//! Revolut por Open Banking (PSD2) a través de Enable Banking. Solo lectura: permiso de
//! información de cuentas (AIS), nunca de pagos.
//!
//! La aplicación de Enable Banking es tuya (modo restringido: solo lee las cuentas que
//! vinculaste). Su ID y su clave privada viven en el Administrador de credenciales de Windows,
//! igual que la sesión que da el banco.

use crate::revolut::{comercio, Mov};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const APP_ID: &str = "eb_app_id";
pub const KEY: &str = "eb_key";
pub const SESSION: &str = "eb_session";
/// Dirección de vuelta registrada en Enable Banking. Nunca se llega a cargar: LIFE la
/// intercepta en su ventana de autorización y se queda con el código.
pub const REDIRECT: &str = "https://localhost/life";
const API: &str = "https://api.enablebanking.com";
const PAIS: &str = "ES";

/// La clave PEM no cabe en una sola credencial de Windows (máximo 2.560 bytes en UTF-16,
/// es decir, 1.280 caracteres): va en trozos.
const TROZO: usize = 1000;

pub fn guardar_clave(pem: &str) -> Result<(), String> {
    EncodingKey::from_rsa_pem(pem.as_bytes()).map_err(|_| "Ese archivo no es una clave privada RSA en formato PEM.".to_string())?;
    borrar_clave()?;
    let trozos: Vec<String> = pem.as_bytes().chunks(TROZO).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
    for (i, t) in trozos.iter().enumerate() {
        crate::secrets::set(&format!("{KEY}_{i}"), t)?;
    }
    crate::secrets::set(KEY, &trozos.len().to_string())
}

pub fn leer_clave() -> Result<Option<String>, String> {
    let Some(n) = crate::secrets::get(KEY)? else { return Ok(None) };
    let n: usize = n.parse().map_err(|_| "Clave de Enable Banking dañada: vuelve a cargarla.")?;
    let mut pem = String::new();
    for i in 0..n {
        pem.push_str(&crate::secrets::get(&format!("{KEY}_{i}"))?.ok_or("Clave de Enable Banking incompleta: vuelve a cargarla.")?);
    }
    Ok(Some(pem))
}

pub fn borrar_clave() -> Result<(), String> {
    if let Some(n) = crate::secrets::get(KEY)?.and_then(|n| n.parse::<usize>().ok()) {
        for i in 0..n {
            crate::secrets::delete(&format!("{KEY}_{i}"))?;
        }
    }
    crate::secrets::delete(KEY)
}

#[derive(Serialize)]
struct Claims {
    iss: &'static str,
    aud: &'static str,
    iat: i64,
    exp: i64,
}

pub struct Cliente {
    http: reqwest::Client,
    jwt: String,
}

impl Cliente {
    pub fn new(app_id: &str, pem: &str) -> Result<Self, String> {
        let mut h = Header::new(Algorithm::RS256);
        h.kid = Some(app_id.to_string());
        let now = chrono::Utc::now().timestamp();
        let key = EncodingKey::from_rsa_pem(pem.as_bytes()).map_err(|e| format!("Clave de Enable Banking no válida: {e}"))?;
        let jwt = jsonwebtoken::encode(&h, &Claims { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 }, &key)
            .map_err(|e| e.to_string())?;
        let http = reqwest::Client::builder()
            .user_agent("LIFE")
            .timeout(std::time::Duration::from_secs(40))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { http, jwt })
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, String> {
        let r = req.bearer_auth(&self.jwt).send().await.map_err(|e| format!("Sin conexión con Enable Banking: {e}"))?;
        let status = r.status();
        let body: Value = r.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        let detalle = body.get("message").or_else(|| body.get("detail")).and_then(Value::as_str).unwrap_or("");
        Err(match status.as_u16() {
            401 | 403 => format!("Enable Banking rechaza la aplicación (revisa el ID y la clave, y que esté activada). {detalle}"),
            429 => "El banco limita las consultas (unas 4 al día sin ti delante). Prueba más tarde.".into(),
            _ => format!("Enable Banking respondió {status}. {detalle}"),
        })
    }

    async fn get(&self, path: &str, q: &[(&str, &str)]) -> Result<Value, String> {
        self.send(self.http.get(format!("{API}{path}")).query(q)).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.send(self.http.post(format!("{API}{path}")).json(&body)).await
    }

    /// Nombre de Revolut en Enable Banking y validez máxima del permiso (en segundos).
    async fn revolut(&self) -> Result<(String, i64), String> {
        let v = self.get("/aspsps", &[("country", PAIS), ("psu_type", "personal")]).await?;
        let a = v["aspsps"]
            .as_array()
            .and_then(|l| l.iter().find(|a| a["name"].as_str().is_some_and(|n| n.to_lowercase().contains("revolut"))))
            .ok_or("Enable Banking no ofrece Revolut en España.")?;
        let max = a["maximum_consent_validity"].as_i64().unwrap_or(90 * 86400);
        Ok((a["name"].as_str().unwrap_or("Revolut").to_string(), max.clamp(86400, 180 * 86400)))
    }

    /// Comprueba que la aplicación y la clave valen (y que Revolut está disponible).
    pub async fn comprobar(&self) -> Result<(), String> {
        self.revolut().await.map(|_| ())
    }

    /// Empieza la autorización: devuelve la dirección donde tú das permiso en Revolut.
    pub async fn empezar(&self, state: &str) -> Result<String, String> {
        let (nombre, max) = self.revolut().await?;
        // Una hora por debajo del máximo: el reloj del banco y el de este equipo no van al segundo.
        let hasta = (chrono::Utc::now() + chrono::Duration::seconds(max - 3600)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let v = self
            .post("/auth", json!({
                "access": { "valid_until": hasta },
                "aspsp": { "name": nombre, "country": PAIS },
                "state": state,
                "redirect_url": REDIRECT,
                "psu_type": "personal",
                "language": "es"
            }))
            .await?;
        v["url"].as_str().map(str::to_string).ok_or_else(|| "Enable Banking no devolvió la dirección de autorización.".into())
    }

    pub async fn sesion(&self, code: &str) -> Result<Sesion, String> {
        let v = self.post("/sessions", json!({ "code": code })).await?;
        serde_json::from_value(v).map_err(|e| format!("Respuesta inesperada al abrir la sesión: {e}"))
    }

    /// Movimientos de una cuenta desde `desde` (AAAA-MM-DD), todas las páginas.
    pub async fn movimientos(&self, uid: &str, desde: &str) -> Result<Vec<Value>, String> {
        let path = format!("/accounts/{uid}/transactions");
        let mut out = Vec::new();
        let mut cont: Option<String> = None;
        for _ in 0..200 {
            let mut q = vec![("date_from", desde), ("strategy", "longest")];
            if let Some(c) = cont.as_deref() {
                q.push(("continuation_key", c));
            }
            let v = self.get(&path, &q).await?;
            if let Some(l) = v["transactions"].as_array() {
                out.extend(l.iter().cloned());
            }
            cont = v["continuation_key"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
            if cont.is_none() {
                break;
            }
        }
        Ok(out)
    }

    /// Saldo actual: el disponible o el contable, el que dé el banco.
    pub async fn saldo(&self, uid: &str) -> Result<Option<f64>, String> {
        let v = self.get(&format!("/accounts/{uid}/balances"), &[]).await?;
        let l = v["balances"].as_array().cloned().unwrap_or_default();
        let pick = ["ITAV", "CLAV", "ITBD", "CLBD", "XPCD", "OTHR"]
            .iter()
            .find_map(|t| l.iter().find(|b| b["balance_type"] == *t))
            .or(l.first());
        Ok(pick.and_then(|b| b["balance_amount"]["amount"].as_str()).and_then(|a| a.parse().ok()))
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Cuenta {
    pub uid: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub cash_account_type: Option<String>,
    #[serde(default)]
    pub account_id: Option<Value>,
}

impl Cuenta {
    pub fn producto(&self) -> &'static str {
        let t = self.cash_account_type.as_deref().unwrap_or("");
        let n = self.name.as_deref().unwrap_or("").to_lowercase();
        if t == "SVGS" || n.contains("ahorro") || n.contains("saving") || n.contains("hucha") || n.contains("mejora") {
            "ahorro"
        } else {
            "cuenta"
        }
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Sesion {
    pub session_id: String,
    pub accounts: Vec<Cuenta>,
    #[serde(default)]
    pub access: Option<Value>,
}

impl Sesion {
    pub fn valid_until(&self) -> Option<String> {
        self.access.as_ref()?.get("valid_until")?.as_str().map(str::to_string)
    }
}

/// Palabras que delatan la hucha de Revolut («Cuenta con mejora activada», «Savings Vault topup»…).
pub const HUCHA: &[&str] = &["cuenta con mejora", "cuenta remunerada", "savings", "pocket", "vault", "hucha", "ahorros"];

fn hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Movimiento del banco → movimiento de LIFE. `None` si está cancelado o rechazado.
/// `propias` son los nombres de tus huchas: lo que va entre la cuenta y ellas es interno.
/// (Tu nombre no cuenta: lo que te mandas desde otro banco sí es dinero que entra.)
pub fn a_mov(t: &Value, cuenta: &Cuenta, propias: &[String]) -> Option<Mov> {
    let estado = t["status"].as_str().unwrap_or("BOOK");
    if matches!(estado, "CNCL" | "RJCT") {
        return None;
    }
    let s = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let fecha = s(&t["booking_date"]).or_else(|| s(&t["value_date"])).or_else(|| s(&t["transaction_date"]))?;
    let fecha = format!("{} 00:00:00", &fecha[..fecha.len().min(10)]);
    let abs: f64 = t["transaction_amount"]["amount"].as_str()?.parse().ok()?;
    let debito = t["credit_debit_indicator"].as_str() == Some("DBIT");
    let importe = if debito { -abs.abs() } else { abs.abs() };
    let divisa = s(&t["transaction_amount"]["currency"]).unwrap_or_else(|| "EUR".into());
    let otra_parte = if debito { s(&t["creditor"]["name"]) } else { s(&t["debtor"]["name"]) };
    let concepto = t["remittance_information"]
        .as_array()
        .map(|l| l.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "))
        .filter(|x| !x.trim().is_empty());
    let descripcion = otra_parte.clone().or_else(|| concepto.clone()).unwrap_or_else(|| "Sin descripción".into());
    let todo = format!("{} {}", descripcion, concepto.as_deref().unwrap_or("")).to_lowercase();
    let producto = cuenta.producto().to_string();
    let tipo = if todo.contains("exchange") || todo.contains("cambio a ") || todo.contains("conversión") {
        "cambio"
    } else if todo.contains("refund") || todo.contains("reembolso") || todo.contains("revert") {
        "reembolso"
    } else if todo.contains("atm") || todo.contains("cajero") || todo.contains("retirada de efectivo") {
        "cajero"
    } else if todo.contains("bizum") || todo.starts_with("to ") || todo.starts_with("from ") || todo.contains("transfer") {
        "transferencia"
    } else if !debito && (todo.contains("top-up") || todo.contains("recarga") || todo.contains("dinero añadido")) {
        "recarga"
    } else if debito {
        "tarjeta"
    } else {
        "otro"
    }
    .to_string();
    let interno = tipo == "cambio"
        || propias.iter().any(|p| p.len() >= 4 && todo.contains(&p.to_lowercase()))
        || HUCHA.iter().any(|k| todo.contains(k));
    let ref_ = s(&t["entry_reference"]).or_else(|| s(&t["transaction_id"]));
    let id = hash(&match ref_ {
        Some(r) => format!("banco|{}|{r}", cuenta.uid),
        None => format!("banco|{}|{fecha}|{descripcion}|{importe:.2}|{divisa}", cuenta.uid),
    });
    // En un traspaso entre tus cuentas, la otra parte suele ser tu propio nombre: el concepto
    // («To Cuenta con mejora activada») dice más y permite reconocer la hucha.
    let descripcion = match (&concepto, interno) {
        (Some(c), true) => c.trim().to_string(),
        _ => descripcion,
    };
    Some(Mov {
        id,
        comercio: comercio(&descripcion),
        completada: Some(fecha.clone()),
        fecha,
        tipo,
        producto,
        descripcion,
        importe,
        comision: 0.0,
        divisa,
        estado: if matches!(estado, "PDNG" | "HOLD" | "SCHD") { "pendiente" } else { "completado" }.into(),
        saldo: t["balance_after_transaction"]["amount"].as_str().and_then(|a| a.parse().ok()),
        interno,
        fuente: "banco".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cuenta() -> Cuenta {
        Cuenta { uid: "u1".into(), name: Some("Cuenta personal".into()), currency: Some("EUR".into()), cash_account_type: Some("CACC".into()), account_id: None }
    }

    #[test]
    fn convierte_un_pago_con_tarjeta() {
        let t = json!({
            "entry_reference": "abc", "status": "BOOK", "booking_date": "2026-11-19",
            "transaction_amount": {"amount": "10.99", "currency": "EUR"}, "credit_debit_indicator": "DBIT",
            "creditor": {"name": "Max"}, "remittance_information": ["Max"],
            "balance_after_transaction": {"amount": "510.35", "currency": "EUR"}
        });
        let m = a_mov(&t, &cuenta(), &[]).unwrap();
        assert_eq!(m.importe, -10.99);
        assert_eq!(m.fecha, "2026-11-19 00:00:00");
        assert_eq!(m.descripcion, "Max");
        assert_eq!(m.tipo, "tarjeta");
        assert_eq!(m.saldo, Some(510.35));
        assert_eq!(m.fuente, "banco");
        assert!(!m.interno);
        assert_eq!(m.id, a_mov(&t, &cuenta(), &[]).unwrap().id);
    }

    #[test]
    fn lo_que_va_a_la_hucha_es_interno_y_lo_cancelado_fuera() {
        let t = json!({
            "status": "BOOK", "booking_date": "2026-11-18",
            "transaction_amount": {"amount": "504.15", "currency": "EUR"}, "credit_debit_indicator": "CRDT",
            "remittance_information": ["Desde EUR Cuenta con mejora activada"]
        });
        let m = a_mov(&t, &cuenta(), &[]).unwrap();
        assert!(m.interno, "la hucha se reconoce sin saber su nombre");
        assert_eq!(m.importe, 504.15);
        let mut c = t.clone();
        c["status"] = json!("CNCL");
        assert!(a_mov(&c, &cuenta(), &[]).is_none());
    }

    #[test]
    fn la_clave_va_en_trozos() {
        // Windows guarda cada credencial en UTF-16: 2 bytes por carácter, máximo 2.560 bytes.
        // Una PEM es ASCII, así que cada trozo ocupa 2 × TROZO bytes.
        assert!(TROZO * 2 <= 2560);
    }
}
