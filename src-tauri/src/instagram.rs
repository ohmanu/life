//! Instagram (cuenta profesional de creador) con la API oficial. Solo lectura. Dos tipos de token:
//! - «Unified login» (apps nuevas de Meta): token de usuario del sistema contra graph.facebook.com,
//!   permisos `instagram_basic` e `instagram_manage_insights`. La cuenta sale de
//!   `/me/assigned_instagram_accounts`. Su caducidad la fija la configuración de la app.
//! - «Instagram Login» (apps anteriores, tokens `IGAA…`): graph.instagram.com, dura 60 días y
//!   LIFE lo renueva cada semana.
//! El token vive en las credenciales de Windows.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TOKEN: &str = "ig_token";
const API_IG: &str = "https://graph.instagram.com/v24.0";
const API_FB: &str = "https://graph.facebook.com/v24.0";

/// Token del inicio de sesión de Instagram (los de Unified login son de otro tipo).
pub fn es_token_ig(token: &str) -> bool {
    token.starts_with("IG")
}
/// Publicaciones recientes de las que se piden estadísticas (una petición por publicación).
const CON_ESTADISTICAS: usize = 24;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Post {
    pub id: String,
    pub caption: String,
    pub media_type: String,
    pub product: String,
    pub timestamp: String,
    pub permalink: String,
    pub likes: Option<i64>,
    pub comments: Option<i64>,
    pub reach: Option<i64>,
    pub views: Option<i64>,
    pub saved: Option<i64>,
    pub shares: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Dia {
    pub fecha: String,
    pub valor: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Snapshot {
    pub username: String,
    pub name: Option<String>,
    pub followers: i64,
    pub follows: i64,
    pub media_count: i64,
    pub posts: Vec<Post>,
    /// Alcance diario de la cuenta, últimos 30 días.
    pub reach: Vec<Dia>,
    /// Totales de los últimos 30 días.
    pub reach_30: Option<i64>,
    pub views_30: Option<i64>,
    pub engaged_30: Option<i64>,
    pub interactions_30: Option<i64>,
    /// Seguidores conectados por hora (0-23), si Meta lo da (100 seguidores o más).
    pub online: Vec<i64>,
    /// Seguidores por día (guardados por LIFE en cada sincronización).
    #[serde(default)]
    pub historia: Vec<Dia>,
    /// Publicaciones e historias por día del último año (guardadas por LIFE).
    #[serde(default)]
    pub actividad: Vec<DiaPub>,
    /// (id, fecha local, tipo) de lo leído en esta sincronización, para guardarlo en life.db.
    #[serde(skip)]
    pub leidas: Vec<(String, String, String)>,
    pub synced_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DiaPub {
    pub fecha: String,
    pub posts: i64,
    pub historias: i64,
}

/// «2026-11-20T18:00:00+0000» → fecha local «2026-11-20».
fn fecha_local(ts: &str) -> Option<String> {
    let t = chrono::DateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%z").ok()?;
    Some(t.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

struct Api {
    http: reqwest::Client,
    token: String,
    base: &'static str,
}

impl Api {
    fn new(token: &str) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .user_agent("LIFE")
            .timeout(std::time::Duration::from_secs(25))
            .build()
            .map_err(|e| e.to_string())?;
        let base = if es_token_ig(token) { API_IG } else { API_FB };
        Ok(Self { http, token: token.to_string(), base })
    }

    async fn get(&self, path: &str, q: &[(&str, &str)]) -> Result<Value, String> {
        let url = if path.starts_with("https://") { path.to_string() } else { format!("{}{path}", self.base) };
        let mut req = self.http.get(url).query(q);
        if !path.starts_with("https://") || !path.contains("access_token=") {
            req = req.query(&[("access_token", self.token.as_str())]);
        }
        let r = req.send().await.map_err(|e| format!("Sin conexión con Instagram: {e}"))?;
        let status = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(v);
        }
        let msg = v["error"]["message"].as_str().unwrap_or("").to_string();
        let code = v["error"]["code"].as_i64().unwrap_or(0);
        Err(match code {
            190 => "El token de Instagram no vale o ha caducado: genera otro en Meta for Developers.".into(),
            10 | 200 => format!("Al token le falta un permiso (instagram_basic o instagram_manage_insights). {msg}"),
            4 | 17 | 32 | 613 => "Instagram limita las consultas ahora mismo. Prueba más tarde.".into(),
            _ => format!("Instagram respondió {status}. {msg}"),
        })
    }
}

fn i(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// Valor de una métrica en una respuesta de `insights` (total o última del periodo).
fn metrica(v: &Value, nombre: &str) -> Option<i64> {
    let m = v["data"].as_array()?.iter().find(|m| m["name"] == nombre)?;
    i(&m["total_value"]["value"]).or_else(|| m["values"].as_array()?.last().and_then(|x| i(&x["value"])))
}

/// Renueva el token largo (60 días más). Meta exige que tenga al menos 24 h.
pub async fn renovar(token: &str) -> Result<String, String> {
    let api = Api::new(token)?;
    let v = api
        .get("https://graph.instagram.com/refresh_access_token", &[("grant_type", "ig_refresh_token")])
        .await?;
    v["access_token"].as_str().map(str::to_string).ok_or_else(|| "Instagram no devolvió el token renovado.".into())
}

pub async fn fetch(token: &str) -> Result<Snapshot, String> {
    let api = Api::new(token)?;
    // Con Unified login, /me es el «usuario del sistema»: la cuenta de Instagram se busca aparte.
    let yo = if es_token_ig(token) {
        "/me".to_string()
    } else {
        let v = api.get("/me/assigned_instagram_accounts", &[("fields", "id,username")]).await?;
        let id = v["data"].as_array().and_then(|l| l.first()).and_then(|a| a["id"].as_str())
            .ok_or("El token no tiene ninguna cuenta de Instagram asignada. Añádela al generar el token.")?;
        format!("/{id}")
    };
    let campos = if es_token_ig(token) {
        "user_id,username,name,account_type,followers_count,follows_count,media_count"
    } else {
        "username,name,followers_count,follows_count,media_count"
    };
    let me = api.get(&yo, &[("fields", campos)]).await?;
    if me["account_type"].as_str() == Some("PERSONAL") {
        return Err("La cuenta de Instagram es personal: pásala a creador en la app de Instagram.".into());
    }
    let mut snap = Snapshot {
        username: me["username"].as_str().unwrap_or("").to_string(),
        name: me["name"].as_str().map(str::to_string),
        followers: i(&me["followers_count"]).unwrap_or(0),
        follows: i(&me["follows_count"]).unwrap_or(0),
        media_count: i(&me["media_count"]).unwrap_or(0),
        synced_at: crate::gmail::utc(chrono::Utc::now()),
        ..Default::default()
    };

    // Publicaciones recientes.
    let media = api
        .get(
            &format!("{yo}/media"),
            &[("fields", "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count"), ("limit", "50")],
        )
        .await?;
    for m in media["data"].as_array().cloned().unwrap_or_default() {
        let caption: String = m["caption"].as_str().unwrap_or("").chars().take(140).collect();
        snap.posts.push(Post {
            id: m["id"].as_str().unwrap_or("").to_string(),
            caption,
            media_type: m["media_type"].as_str().unwrap_or("").to_string(),
            product: m["media_product_type"].as_str().unwrap_or("").to_string(),
            timestamp: m["timestamp"].as_str().unwrap_or("").to_string(),
            permalink: m["permalink"].as_str().unwrap_or("").to_string(),
            likes: i(&m["like_count"]),
            comments: i(&m["comments_count"]),
            ..Default::default()
        });
    }

    // Fechas de todo el último año (solo id, fecha y tipo; hasta 10 páginas) para la cuadrícula.
    let hace_un_ano = (chrono::Local::now() - chrono::Duration::days(372)).format("%Y-%m-%d").to_string();
    let mut sig: Option<String> = None;
    for pagina in 0..10 {
        let v = match &sig {
            None => api.get(&format!("{yo}/media"), &[("fields", "id,timestamp,media_product_type"), ("limit", "100")]).await,
            Some(url) => api.get(url, &[]).await,
        };
        let Ok(v) = v else { break };
        let mut viejo = false;
        for m in v["data"].as_array().cloned().unwrap_or_default() {
            let (Some(id), Some(f)) = (m["id"].as_str(), m["timestamp"].as_str().and_then(fecha_local)) else { continue };
            if f < hace_un_ano {
                viejo = true;
                continue;
            }
            snap.leidas.push((id.to_string(), f, m["media_product_type"].as_str().unwrap_or("FEED").to_string()));
        }
        sig = v["paging"]["next"].as_str().map(str::to_string);
        if viejo || sig.is_none() || pagina == 9 {
            break;
        }
    }
    // Historias activas (Meta solo da las de las últimas 24 h; LIFE las guarda en cada lectura).
    if let Ok(v) = api.get(&format!("{yo}/stories"), &[("fields", "id,timestamp")]).await {
        for m in v["data"].as_array().cloned().unwrap_or_default() {
            if let (Some(id), Some(f)) = (m["id"].as_str(), m["timestamp"].as_str().and_then(fecha_local)) {
                snap.leidas.push((id.to_string(), f, "STORY".into()));
            }
        }
    }

    // Estadísticas de las más recientes. Si una métrica no vale para ese tipo, se reintenta con menos.
    for p in snap.posts.iter_mut().take(CON_ESTADISTICAS) {
        if p.product == "STORY" {
            continue;
        }
        let path = format!("/{}/insights", p.id);
        let v = match api.get(&path, &[("metric", "reach,views,saved,shares")]).await {
            Ok(v) => v,
            Err(_) => match api.get(&path, &[("metric", "reach,saved")]).await {
                Ok(v) => v,
                Err(_) => continue,
            },
        };
        p.reach = metrica(&v, "reach");
        p.views = metrica(&v, "views");
        p.saved = metrica(&v, "saved");
        p.shares = metrica(&v, "shares");
    }

    // Cuenta: alcance diario y totales de 30 días.
    let hasta = chrono::Utc::now().timestamp();
    let desde = hasta - 29 * 86400;
    let (desde_s, hasta_s) = (desde.to_string(), hasta.to_string());
    if let Ok(v) = api
        .get(&format!("{yo}/insights"), &[("metric", "reach"), ("period", "day"), ("metric_type", "time_series"), ("since", &desde_s), ("until", &hasta_s)])
        .await
    {
        if let Some(vals) = v["data"].as_array().and_then(|d| d.first()).and_then(|m| m["values"].as_array()) {
            snap.reach = vals
                .iter()
                .filter_map(|x| Some(Dia { fecha: x["end_time"].as_str()?.get(..10)?.to_string(), valor: i(&x["value"])? }))
                .collect();
        }
    }
    if let Ok(v) = api
        .get(
            &format!("{yo}/insights"),
            &[("metric", "reach,views,accounts_engaged,total_interactions"), ("period", "day"), ("metric_type", "total_value"), ("since", &desde_s), ("until", &hasta_s)],
        )
        .await
    {
        snap.reach_30 = metrica(&v, "reach");
        snap.views_30 = metrica(&v, "views");
        snap.engaged_30 = metrica(&v, "accounts_engaged");
        snap.interactions_30 = metrica(&v, "total_interactions");
    }
    // Hora con más seguidores conectados (solo con 100 seguidores o más).
    if let Ok(v) = api.get(&format!("{yo}/insights"), &[("metric", "online_followers"), ("period", "lifetime")]).await {
        if let Some(obj) = v["data"].as_array().and_then(|d| d.first()).and_then(|m| m["values"].as_array()).and_then(|l| l.last()).and_then(|x| x["value"].as_object()) {
            let mut horas = vec![0i64; 24];
            for (h, n) in obj {
                if let (Ok(h), Some(n)) = (h.parse::<usize>(), i(n)) {
                    if h < 24 {
                        horas[h] = n;
                    }
                }
            }
            if horas.iter().any(|n| *n > 0) {
                snap.online = horas;
            }
        }
    }
    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lee_metricas_de_insights() {
        let v = json!({"data": [
            {"name": "reach", "period": "lifetime", "values": [{"value": 1200}]},
            {"name": "views", "total_value": {"value": "3400"}}
        ]});
        assert_eq!(metrica(&v, "reach"), Some(1200));
        assert_eq!(metrica(&v, "views"), Some(3400));
        assert_eq!(metrica(&v, "saved"), None);
    }
}
