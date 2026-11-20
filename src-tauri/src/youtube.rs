//! YouTube: APIs oficiales de Google en solo lectura (`youtube.readonly` y
//! `yt-analytics.readonly`). OAuth de app de escritorio: el navegador vuelve a un puerto local
//! (127.0.0.1) que LIFE escucha un momento. ID y secreto del cliente y el token de renovación
//! viven en las credenciales de Windows.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

pub const CLIENT_ID: &str = "yt_client_id";
pub const CLIENT_SECRET: &str = "yt_client_secret";
pub const REFRESH: &str = "yt_refresh_token";
const SCOPES: &str = "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Video {
    pub id: String,
    pub title: String,
    pub published: String,
    pub duration: String,
    pub views: Option<i64>,
    pub likes: Option<i64>,
    pub comments: Option<i64>,
    /// De los últimos 28 días (Analytics).
    pub views_28: Option<i64>,
    pub minutes_28: Option<i64>,
    pub retention_28: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Dia {
    pub fecha: String,
    pub views: i64,
    pub minutes: i64,
    pub subs: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Snapshot {
    pub channel: String,
    pub subscribers: Option<i64>,
    pub total_views: i64,
    pub video_count: i64,
    pub videos: Vec<Video>,
    pub dias: Vec<Dia>,
    pub views_28: Option<i64>,
    pub minutes_28: Option<i64>,
    pub avg_duration_28: Option<f64>,
    pub retention_28: Option<f64>,
    pub subs_ganados_28: Option<i64>,
    pub subs_perdidos_28: Option<i64>,
    /// Fuentes de tráfico de 28 días: (tipo, vistas).
    pub trafico: Vec<(String, i64)>,
    pub synced_at: String,
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("LIFE")
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())
}

fn b64url(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        let k = c.len() + 1;
        for i in 0..k {
            out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

fn aleatorio(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).expect("aleatorio del sistema");
    b64url(&b)
}

/// SHA-256 (para PKCE). Implementación corta para no añadir otra dependencia.
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
        0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
        0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    let mut out = [0u8; 32];
    for i in 0..8 {
        out[4 * i..4 * i + 4].copy_from_slice(&h[i].to_be_bytes());
    }
    out
}

fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Autorización preparada: la dirección para el navegador y lo necesario para esperar la vuelta.
pub struct Autorizacion {
    pub url: String,
    listener: TcpListener,
    redirect: String,
    verifier: String,
    state: String,
}

pub fn preparar(client_id: &str) -> Result<Autorizacion, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("No se pudo abrir el puerto local: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = aleatorio(48);
    let challenge = b64url(&sha256(verifier.as_bytes()));
    let state = aleatorio(18);
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&access_type=offline&prompt=consent",
        pct(client_id),
        pct(&redirect),
        pct(SCOPES)
    );
    Ok(Autorizacion { url, listener, redirect, verifier, state })
}

/// Espera (bloqueando, hasta 10 minutos) a que Google devuelva el navegador al puerto local.
/// Devuelve (código, redirect, verifier).
pub fn esperar(a: Autorizacion) -> Result<(String, String, String), String> {
    a.listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let fin = Instant::now() + Duration::from_secs(600);
    loop {
        if Instant::now() > fin {
            return Err("La autorización tardó demasiado. Vuelve a intentarlo.".into());
        }
        let (mut s, _) = match a.listener.accept() {
            Ok(x) => x,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        s.set_nonblocking(false).ok();
        s.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let mut buf = [0u8; 8192];
        let n = s.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let path = req.split_whitespace().nth(1).unwrap_or("/");
        let q: std::collections::HashMap<String, String> = tauri::Url::parse(&format!("http://127.0.0.1{path}"))
            .map(|u| u.query_pairs().into_owned().collect())
            .unwrap_or_default();
        if q.is_empty() {
            // favicon u otra petición del navegador: se ignora.
            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let ok = q.get("state") == Some(&a.state) && q.contains_key("code");
        let cuerpo = if ok {
            "<!doctype html><meta charset=utf-8><title>LIFE</title><body style=\"background:#03110f;color:#38f2c4;font:16px monospace;padding:40px\">LIFE · YouTube conectado. Puedes cerrar esta pestaña.</body>"
        } else {
            "<!doctype html><meta charset=utf-8><title>LIFE</title><body style=\"background:#03110f;color:#ff5a4a;font:16px monospace;padding:40px\">LIFE · No se autorizó. Vuelve a LIFE e inténtalo otra vez.</body>"
        };
        let _ = s.write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{cuerpo}", cuerpo.len()).as_bytes(),
        );
        if !ok {
            return Err(q.get("error").map(|e| format!("Google no autorizó: {e}")).unwrap_or_else(|| "La respuesta de Google no coincide con esta autorización.".into()));
        }
        return Ok((q["code"].clone(), a.redirect, a.verifier));
    }
}

/// Canjea el código por un token de renovación.
pub async fn canjear(client_id: &str, secret: &str, code: &str, redirect: &str, verifier: &str) -> Result<String, String> {
    let v: Value = http()?
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("client_secret", secret),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect),
        ])
        .send()
        .await
        .map_err(|e| format!("Sin conexión con Google: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    v["refresh_token"].as_str().map(str::to_string).ok_or_else(|| {
        format!("Google no devolvió el token de renovación. {}", v["error_description"].as_str().or(v["error"].as_str()).unwrap_or(""))
    })
}

async fn acceso(client_id: &str, secret: &str, refresh: &str) -> Result<String, String> {
    let v: Value = http()?
        .post("https://oauth2.googleapis.com/token")
        .form(&[("client_id", client_id), ("client_secret", secret), ("refresh_token", refresh), ("grant_type", "refresh_token")])
        .send()
        .await
        .map_err(|e| format!("Sin conexión con Google: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(t) = v["access_token"].as_str() {
        return Ok(t.to_string());
    }
    Err(match v["error"].as_str() {
        Some("invalid_grant") => "Google ha retirado el permiso (o la app sigue en «Prueba» y caducó a los 7 días). Vuelve a conectar YouTube en F5.".into(),
        _ => format!("Google rechazó la renovación. {}", v["error_description"].as_str().unwrap_or("")),
    })
}

async fn get(c: &reqwest::Client, token: &str, url: &str, q: &[(&str, &str)]) -> Result<Value, String> {
    let r = c.get(url).query(q).bearer_auth(token).send().await.map_err(|e| format!("Sin conexión con YouTube: {e}"))?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(v);
    }
    let msg = v["error"]["message"].as_str().unwrap_or("");
    Err(if msg.contains("has not been used") || msg.contains("is disabled") {
        format!("Activa en Google Cloud la API que falta (YouTube Data API v3 y YouTube Analytics API). {msg}")
    } else {
        format!("YouTube respondió {status}. {msg}")
    })
}

fn i(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// Filas de un informe de Analytics como mapas columna → valor.
fn filas(v: &Value) -> Vec<std::collections::HashMap<String, Value>> {
    let cols: Vec<String> = v["columnHeaders"].as_array().map(|l| l.iter().filter_map(|c| c["name"].as_str().map(str::to_string)).collect()).unwrap_or_default();
    v["rows"]
        .as_array()
        .map(|rows| rows.iter().filter_map(|r| r.as_array()).map(|r| cols.iter().cloned().zip(r.iter().cloned()).collect()).collect())
        .unwrap_or_default()
}

pub async fn fetch(client_id: &str, secret: &str, refresh: &str) -> Result<Snapshot, String> {
    let token = acceso(client_id, secret, refresh).await?;
    let c = http()?;
    const DATA: &str = "https://www.googleapis.com/youtube/v3";
    let ch = get(&c, &token, &format!("{DATA}/channels"), &[("part", "snippet,statistics,contentDetails"), ("mine", "true")]).await?;
    let ch = ch["items"].as_array().and_then(|l| l.first()).cloned().ok_or("Esta cuenta de Google no tiene canal de YouTube.")?;
    let st = &ch["statistics"];
    let mut snap = Snapshot {
        channel: ch["snippet"]["title"].as_str().unwrap_or("").to_string(),
        subscribers: if st["hiddenSubscriberCount"].as_bool() == Some(true) { None } else { i(&st["subscriberCount"]) },
        total_views: i(&st["viewCount"]).unwrap_or(0),
        video_count: i(&st["videoCount"]).unwrap_or(0),
        synced_at: crate::gmail::utc(chrono::Utc::now()),
        ..Default::default()
    };

    // Últimos vídeos subidos.
    if let Some(uploads) = ch["contentDetails"]["relatedPlaylists"]["uploads"].as_str() {
        let pl = get(&c, &token, &format!("{DATA}/playlistItems"), &[("part", "contentDetails"), ("playlistId", uploads), ("maxResults", "25")]).await?;
        let ids: Vec<String> = pl["items"].as_array().map(|l| l.iter().filter_map(|x| x["contentDetails"]["videoId"].as_str().map(str::to_string)).collect()).unwrap_or_default();
        if !ids.is_empty() {
            let vs = get(&c, &token, &format!("{DATA}/videos"), &[("part", "snippet,statistics,contentDetails"), ("id", &ids.join(","))]).await?;
            for v in vs["items"].as_array().cloned().unwrap_or_default() {
                snap.videos.push(Video {
                    id: v["id"].as_str().unwrap_or("").to_string(),
                    title: v["snippet"]["title"].as_str().unwrap_or("").to_string(),
                    published: v["snippet"]["publishedAt"].as_str().unwrap_or("").to_string(),
                    duration: v["contentDetails"]["duration"].as_str().unwrap_or("").to_string(),
                    views: i(&v["statistics"]["viewCount"]),
                    likes: i(&v["statistics"]["likeCount"]),
                    comments: i(&v["statistics"]["commentCount"]),
                    ..Default::default()
                });
            }
            snap.videos.sort_by(|a, b| b.published.cmp(&a.published));
        }
    }

    // Analytics: últimos 28 días hasta ayer (los datos llegan con 1-3 días de retraso).
    const AN: &str = "https://youtubeanalytics.googleapis.com/v2/reports";
    let fin = chrono::Local::now().date_naive() - chrono::Duration::days(1);
    let ini = fin - chrono::Duration::days(27);
    let (ini_s, fin_s) = (ini.format("%Y-%m-%d").to_string(), fin.format("%Y-%m-%d").to_string());
    let base = [("ids", "channel==MINE"), ("startDate", ini_s.as_str()), ("endDate", fin_s.as_str())];
    let q = |extra: &[(&'static str, &'static str)]| -> Vec<(&str, &str)> { base.iter().copied().chain(extra.iter().copied()).collect() };

    if let Ok(v) = get(&c, &token, AN, &q(&[("metrics", "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost")])).await {
        if let Some(r) = filas(&v).into_iter().next() {
            snap.views_28 = r.get("views").and_then(i);
            snap.minutes_28 = r.get("estimatedMinutesWatched").and_then(i);
            snap.avg_duration_28 = r.get("averageViewDuration").and_then(Value::as_f64);
            snap.retention_28 = r.get("averageViewPercentage").and_then(Value::as_f64);
            snap.subs_ganados_28 = r.get("subscribersGained").and_then(i);
            snap.subs_perdidos_28 = r.get("subscribersLost").and_then(i);
        }
    }
    if let Ok(v) = get(&c, &token, AN, &q(&[("metrics", "views,estimatedMinutesWatched,subscribersGained"), ("dimensions", "day"), ("sort", "day")])).await {
        snap.dias = filas(&v)
            .into_iter()
            .filter_map(|r| {
                Some(Dia {
                    fecha: r.get("day")?.as_str()?.to_string(),
                    views: r.get("views").and_then(i).unwrap_or(0),
                    minutes: r.get("estimatedMinutesWatched").and_then(i).unwrap_or(0),
                    subs: r.get("subscribersGained").and_then(i).unwrap_or(0),
                })
            })
            .collect();
    }
    if let Ok(v) = get(&c, &token, AN, &q(&[("metrics", "views,estimatedMinutesWatched,averageViewPercentage"), ("dimensions", "video"), ("sort", "-views"), ("maxResults", "25")])).await {
        for r in filas(&v) {
            let Some(id) = r.get("video").and_then(Value::as_str) else { continue };
            if let Some(vid) = snap.videos.iter_mut().find(|x| x.id == id) {
                vid.views_28 = r.get("views").and_then(i);
                vid.minutes_28 = r.get("estimatedMinutesWatched").and_then(i);
                vid.retention_28 = r.get("averageViewPercentage").and_then(Value::as_f64);
            }
        }
    }
    if let Ok(v) = get(&c, &token, AN, &q(&[("metrics", "views"), ("dimensions", "insightTrafficSourceType"), ("sort", "-views")])).await {
        snap.trafico = filas(&v)
            .into_iter()
            .filter_map(|r| Some((r.get("insightTrafficSourceType")?.as_str()?.to_string(), r.get("views").and_then(i)?)))
            .collect();
    }
    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_y_base64url() {
        // Vector del RFC 7636 (PKCE).
        let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(b64url(&sha256(v.as_bytes())), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert_eq!(b64url(b""), "");
        assert_eq!(b64url(b"f"), "Zg");
    }

    #[test]
    fn lee_filas_de_analytics() {
        let v = serde_json::json!({
            "columnHeaders": [{"name": "day"}, {"name": "views"}],
            "rows": [["2026-11-01", 12], ["2026-11-02", 30]]
        });
        let f = filas(&v);
        assert_eq!(f.len(), 2);
        assert_eq!(f[1]["views"], 30);
    }
}
