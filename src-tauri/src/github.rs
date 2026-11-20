//! GitHub: calendario de contribuciones, racha y repos. GraphQL con un token
//! de acceso de solo lectura guardado en las credenciales de Windows.

use chrono::{Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const TOKEN: &str = "github_token";

const QUERY: &str = r#"
query {
  viewer {
    login
    name
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    }
    repositories(first: 8, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { name pushedAt isPrivate primaryLanguage { name } }
    }
    pullRequests(states: OPEN) { totalCount }
    issues(states: OPEN) { totalCount }
  }
}"#;

#[derive(Serialize, Deserialize, Clone)]
pub struct Day {
    pub date: String,
    pub count: u32,
    pub level: u8,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Repo {
    pub name: String,
    pub pushed_at: String,
    pub private: bool,
    pub language: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Snapshot {
    pub login: String,
    pub name: Option<String>,
    pub total_year: u32,
    pub last_90: u32,
    pub streak: u32,
    pub longest: u32,
    pub days: Vec<Day>,
    pub repos: Vec<Repo>,
    pub open_prs: u32,
    pub open_issues: u32,
    pub synced_at: String,
}

fn level(s: &str) -> u8 {
    match s {
        "FIRST_QUARTILE" => 1,
        "SECOND_QUARTILE" => 2,
        "THIRD_QUARTILE" => 3,
        "FOURTH_QUARTILE" => 4,
        _ => 0,
    }
}

/// Días seguidos con alguna contribución hasta hoy. Si hoy aún no hay nada,
/// la racha sigue viva y se cuenta desde ayer.
fn streaks(days: &[Day], today: NaiveDate) -> (u32, u32) {
    let mut longest = 0;
    let mut run = 0;
    for d in days {
        if d.count > 0 { run += 1; longest = longest.max(run); } else { run = 0; }
    }
    let mut streak = 0;
    let mut skipped_today = false;
    for d in days.iter().rev() {
        let Ok(date) = NaiveDate::parse_from_str(&d.date, "%Y-%m-%d") else { continue };
        if date > today { continue; }
        if d.count > 0 {
            streak += 1;
        } else if date == today && !skipped_today {
            skipped_today = true;
        } else {
            break;
        }
    }
    (streak, longest)
}

pub async fn fetch(token: &str) -> Result<Snapshot, String> {
    let client = reqwest::Client::builder()
        .user_agent("life-desktop")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post("https://api.github.com/graphql")
        .bearer_auth(token)
        .json(&json!({ "query": QUERY }))
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con GitHub: {e}"))?;
    let status = res.status();
    if status.as_u16() == 401 {
        return Err("GitHub rechaza el token. Revisa que esté bien copiado y no haya caducado.".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub respondió {status}"));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(errs) = body.get("errors") {
        return Err(format!("GitHub: {}", errs[0]["message"].as_str().unwrap_or("error en la consulta")));
    }
    let v = &body["data"]["viewer"];
    let cal = &v["contributionsCollection"]["contributionCalendar"];
    let days: Vec<Day> = cal["weeks"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|w| w["contributionDays"].as_array().cloned().unwrap_or_default())
        .map(|d| Day {
            date: d["date"].as_str().unwrap_or_default().to_string(),
            count: d["contributionCount"].as_u64().unwrap_or(0) as u32,
            level: level(d["contributionLevel"].as_str().unwrap_or("")),
        })
        .collect();
    let today = Local::now().date_naive();
    let from_90 = (today - Duration::days(89)).format("%Y-%m-%d").to_string();
    let last_90 = days.iter().filter(|d| d.date >= from_90).map(|d| d.count).sum();
    let (streak, longest) = streaks(&days, today);
    let repos = v["repositories"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| Repo {
            name: r["name"].as_str().unwrap_or_default().to_string(),
            pushed_at: r["pushedAt"].as_str().unwrap_or_default().to_string(),
            private: r["isPrivate"].as_bool().unwrap_or(false),
            language: r["primaryLanguage"]["name"].as_str().map(String::from),
        })
        .collect();
    Ok(Snapshot {
        login: v["login"].as_str().unwrap_or_default().to_string(),
        name: v["name"].as_str().map(String::from),
        total_year: cal["totalContributions"].as_u64().unwrap_or(0) as u32,
        last_90,
        streak,
        longest,
        days,
        repos,
        open_prs: v["pullRequests"]["totalCount"].as_u64().unwrap_or(0) as u32,
        open_issues: v["issues"]["totalCount"].as_u64().unwrap_or(0) as u32,
        synced_at: Local::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d(date: &str, count: u32) -> Day { Day { date: date.into(), count, level: 0 } }

    #[test]
    fn racha_cuenta_desde_ayer_si_hoy_esta_vacio() {
        let days = vec![d("2026-11-17", 0), d("2026-11-18", 2), d("2026-11-19", 1), d("2026-11-20", 0)];
        let today = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
        assert_eq!(streaks(&days, today), (2, 2));
    }

    #[test]
    fn racha_se_rompe_con_un_dia_vacio() {
        let days = vec![d("2026-11-17", 3), d("2026-11-18", 0), d("2026-11-19", 1), d("2026-11-20", 4)];
        let today = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
        assert_eq!(streaks(&days, today), (2, 2));
    }
}
