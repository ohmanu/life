//! Encargos desde Gmail por IMAP, **solo lectura**.
//!
//! - Se entra con una contraseña de aplicación de Google (guardada en el Administrador de
//!   credenciales de Windows).
//! - El buzón se abre con `EXAMINE` (modo solo lectura del protocolo) y los correos se piden con
//!   `BODY.PEEK[]`, que no los marca como leídos. Nunca se envía, mueve, etiqueta ni borra nada.
//! - Las hojas de encargo llegan de `web@glutamatocult.com` con asunto
//!   `Encargo · Tipo · Qué · Nombre` y cuerpo en líneas `Clave: valor`, luego `Mensaje:`.
//! - «Respondido» sale de buscar un correo tuyo enviado a la dirección del cliente.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::collections::HashSet;

pub const USER: &str = "gmail_user";
pub const PASS: &str = "gmail_app_password";

const HOST: &str = "imap.gmail.com";
const FROM: &str = "web@glutamatocult.com";
/// Búsqueda de Gmail (extensión X-GM-RAW). Solo ASCII; el asunto exacto se comprueba al leerlo.
const QUERY: &str = "from:web@glutamatocult.com subject:Encargo";

/// Estados de un encargo. `nuevo` → `respondido` lo pone LIFE al ver tu respuesta; el resto los
/// marcas tú en la app (no se escribe nada en Gmail).
pub const ESTADOS: &[&str] = &["nuevo", "respondido", "presupuesto", "confirmado", "cobrado", "descartado"];

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Encargo {
    pub id: String,
    pub uid: u32,
    pub recibido: String,
    pub asunto: String,
    pub tipo: String,
    pub que: String,
    pub nombre: String,
    pub correo: String,
    pub telefono: String,
    pub empresa: String,
    pub fecha: String,
    pub lugar: String,
    pub web: String,
    pub presupuesto: String,
    pub idioma: String,
    pub mensaje: String,
    pub estado: String,
    pub respondido: Option<String>,
}

/// Encargo aún sin respuesta, para buscar si ya le escribiste.
pub struct Pendiente {
    pub id: String,
    pub correo: String,
    pub recibido: String,
}

pub struct Fetched {
    pub uidvalidity: u32,
    pub nuevos: Vec<Encargo>,
    /// (id del encargo, fecha de tu primera respuesta)
    pub respuestas: Vec<(String, String)>,
}

pub fn utc(d: DateTime<impl chrono::TimeZone>) -> String {
    d.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true)
}

type Session = imap::Session<native_tls::TlsStream<std::net::TcpStream>>;

fn login(user: &str, pass: &str) -> Result<Session, String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| format!("TLS: {e}"))?;
    let client = imap::connect((HOST, 993), HOST, &tls)
        .map_err(|e| format!("No se pudo conectar con Gmail: {e}"))?;
    client.login(user, pass).map_err(|(e, _)| {
        let msg = e.to_string();
        if msg.contains("AUTHENTICATIONFAILED") || msg.contains("Invalid credentials") {
            "Gmail rechazó el correo o la contraseña de aplicación.".to_string()
        } else if msg.contains("Application-specific password") {
            "Gmail pide una contraseña de aplicación, no la de tu cuenta.".to_string()
        } else {
            format!("Gmail: {msg}")
        }
    })
}

/// Comprueba las credenciales sin leer nada.
pub fn check(user: &str, pass: &str) -> Result<(), String> {
    let mut s = login(user, pass)?;
    let _ = s.logout();
    Ok(())
}

/// Nombre del buzón «Todos» (cambia con el idioma de la cuenta): el que lleva el atributo `\All`.
fn all_mail(s: &mut Session) -> Result<String, String> {
    let names = s.list(None, Some("*")).map_err(|e| format!("Gmail: {e}"))?;
    let found = names.iter().find(|n| {
        n.attributes()
            .iter()
            .any(|a| matches!(a, imap::types::NameAttribute::Custom(c) if c.eq_ignore_ascii_case("\\All")))
    });
    Ok(found.map(|n| n.name().to_string()).unwrap_or_else(|| "[Gmail]/All Mail".into()))
}

/// Solo direcciones normales: se meten en una búsqueda y no deben poder romperla.
fn safe_address(a: &str) -> bool {
    !a.is_empty() && a.contains('@') && a.chars().all(|c| c.is_ascii_alphanumeric() || "._%+-@".contains(c))
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

/// Lee los encargos que aún no están en `known` y busca respuestas para `pendientes`.
pub fn fetch(
    user: &str,
    pass: &str,
    known_validity: Option<u32>,
    known: &HashSet<u32>,
    pendientes: &[Pendiente],
) -> Result<Fetched, String> {
    let mut s = login(user, pass)?;
    let mailbox = all_mail(&mut s)?;
    let mb = s.examine(&mailbox).map_err(|e| format!("Gmail: {e}"))?;
    let uidvalidity = mb.uid_validity.unwrap_or(0);
    let same = known_validity == Some(uidvalidity);

    let found = s
        .uid_search(format!("X-GM-RAW \"{QUERY}\""))
        .map_err(|e| format!("Gmail: {e}"))?;
    let mut todo: Vec<u32> = found.into_iter().filter(|u| !(same && known.contains(u))).collect();
    todo.sort_unstable();

    let mut nuevos = Vec::new();
    for chunk in todo.chunks(50) {
        let fetches = s
            .uid_fetch(uid_set(chunk), "(UID INTERNALDATE BODY.PEEK[])")
            .map_err(|e| format!("Gmail: {e}"))?;
        for f in fetches.iter() {
            let (Some(uid), Some(raw)) = (f.uid, f.body()) else { continue };
            let recibido = f.internal_date().map(utc).unwrap_or_default();
            if let Some(mut e) = parse(raw, uid, uidvalidity) {
                e.recibido = recibido;
                nuevos.push(e);
            }
        }
    }

    let mut respuestas = Vec::new();
    for p in pendientes.iter().filter(|p| safe_address(&p.correo)) {
        let sent = s
            .uid_search(format!("X-GM-RAW \"from:me to:{}\"", p.correo))
            .map_err(|e| format!("Gmail: {e}"))?;
        if sent.is_empty() {
            continue;
        }
        let mut uids: Vec<u32> = sent.into_iter().collect();
        uids.sort_unstable();
        let fetches = s
            .uid_fetch(uid_set(&uids), "(UID INTERNALDATE)")
            .map_err(|e| format!("Gmail: {e}"))?;
        let first = fetches
            .iter()
            .filter_map(|f| f.internal_date().map(utc))
            .filter(|d| d.as_str() >= p.recibido.as_str())
            .min();
        if let Some(d) = first {
            respuestas.push((p.id.clone(), d));
        }
    }

    let _ = s.logout();
    Ok(Fetched { uidvalidity, nuevos, respuestas })
}

/// Correo MIME → encargo. `None` si no es una hoja de encargo de la web.
pub fn parse(raw: &[u8], uid: u32, uidvalidity: u32) -> Option<Encargo> {
    let msg = mail_parser::MessageParser::default().parse(raw)?;
    let from = msg.from().and_then(|a| a.first()).and_then(|a| a.address()).unwrap_or_default();
    if !from.eq_ignore_ascii_case(FROM) {
        return None;
    }
    let subject = msg.subject().unwrap_or_default();
    if !subject.starts_with("Encargo ·") {
        return None;
    }
    let body = msg.body_text(0).unwrap_or_default();
    let mut e = parse_text(subject, &body);
    if e.correo.is_empty() {
        if let Some(a) = msg.reply_to().and_then(|a| a.first()).and_then(|a| a.address()) {
            e.correo = a.to_string();
        }
    }
    e.id = msg
        .message_id()
        .map(str::to_string)
        .unwrap_or_else(|| format!("uid-{uidvalidity}-{uid}"));
    e.uid = uid;
    Some(e)
}

/// Asunto y cuerpo de texto → campos del encargo.
pub fn parse_text(subject: &str, body: &str) -> Encargo {
    let mut e = Encargo { asunto: subject.to_string(), estado: "nuevo".into(), ..Default::default() };

    // Asunto: Encargo · Tipo · Qué · Nombre (respaldo si falta alguna línea del cuerpo)
    let parts: Vec<&str> = subject.split(" · ").map(str::trim).collect();
    if parts.len() >= 4 {
        e.tipo = parts[1].into();
        e.que = parts[2..parts.len() - 1].join(" · ");
        e.nombre = parts[parts.len() - 1].into();
    }

    let lines: Vec<&str> = body.lines().map(|l| l.trim_end_matches('\r')).collect();
    let msg_at = lines.iter().position(|l| l.trim() == "Mensaje:");
    for line in &lines[..msg_at.unwrap_or(lines.len())] {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim().to_string();
        match k.trim() {
            "Encargo" => {
                if let Some((t, q)) = v.split_once(" · ") {
                    e.tipo = t.trim().into();
                    e.que = q.trim().into();
                }
            }
            "Nombre" => e.nombre = v,
            "Correo" => e.correo = v,
            "Teléfono" => e.telefono = v,
            "Empresa o proyecto" => e.empresa = v,
            "Fecha" | "Plazo" => e.fecha = v,
            "Lugar" => e.lugar = v,
            "Web actual" => e.web = v,
            "Presupuesto" => e.presupuesto = v,
            "Idioma de la web" => e.idioma = v,
            _ => {}
        }
    }

    if let Some(i) = msg_at {
        let rest = &lines[i + 1..];
        // La firma «--» del final no es parte del mensaje.
        let end = rest.iter().rposition(|l| l.trim() == "--").unwrap_or(rest.len());
        e.mensaje = rest[..end].join("\n").trim().to_string();
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "Nueva hoja de encargo desde glutamatocult.com\r\n\r\nEncargo: Fotografía · Retrato\r\nNombre: Lucía M.\r\nCorreo: lucia@example.com\r\nFecha: 2026-12-05\r\nLugar: Madrid\r\nPresupuesto: 300–600 €\r\nIdioma de la web: español\r\n\r\nMensaje:\r\nHola: quería unas fotos.\r\n\r\nGracias.\r\n\r\n--\r\nResponde a este correo para contestar directamente.";

    #[test]
    fn lee_la_hoja_de_encargo() {
        let e = parse_text("Encargo · Fotografía · Retrato · Lucía M.", BODY);
        assert_eq!(e.tipo, "Fotografía");
        assert_eq!(e.que, "Retrato");
        assert_eq!(e.nombre, "Lucía M.");
        assert_eq!(e.correo, "lucia@example.com");
        assert_eq!(e.fecha, "2026-12-05");
        assert_eq!(e.lugar, "Madrid");
        assert_eq!(e.presupuesto, "300–600 €");
        assert_eq!(e.idioma, "español");
        assert_eq!(e.mensaje, "Hola: quería unas fotos.\n\nGracias.");
        assert_eq!(e.estado, "nuevo");
    }

    #[test]
    fn plazo_y_asunto_de_respaldo() {
        let e = parse_text("Encargo · Software · Web · Ana", "Plazo: enero\nMensaje:\nNada\n");
        assert_eq!((e.tipo.as_str(), e.que.as_str(), e.nombre.as_str()), ("Software", "Web", "Ana"));
        assert_eq!(e.fecha, "enero");
        assert_eq!(e.mensaje, "Nada");
    }

    #[test]
    fn correo_mime_completo() {
        use std::fmt::Write;
        let b64 = {
            // base64 mínimo para no añadir dependencias en pruebas
            const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut out = String::new();
            for c in BODY.as_bytes().chunks(3) {
                let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
                for i in 0..4 {
                    if i <= c.len() { out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char) } else { out.push('=') }
                }
            }
            out
        };
        let mut raw = String::new();
        write!(raw, "From: =?UTF-8?Q?Glutamato_Cult_=C2=B7_Web?= <web@glutamatocult.com>\r\nReply-To: Lucia <lucia@example.com>\r\nSubject: =?UTF-8?Q?Encargo_=C2=B7_Fotograf=C3=ADa_=C2=B7_Retrato_=C2=B7_Luc=C3=ADa_M.?=\r\nMessage-ID: <abc@glutamatocult.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{b64}\r\n").unwrap();
        let e = parse(raw.as_bytes(), 7, 1).expect("es un encargo");
        assert_eq!(e.id, "abc@glutamatocult.com");
        assert_eq!(e.nombre, "Lucía M.");
        assert_eq!(e.presupuesto, "300–600 €");
        assert_eq!(e.uid, 7);

        let otro = raw.replace("web@glutamatocult.com", "spam@example.com");
        assert!(parse(otro.as_bytes(), 8, 1).is_none());
    }

    #[test]
    fn direcciones_seguras() {
        assert!(safe_address("lucia.m+web@example.com"));
        assert!(!safe_address("a\" OR x@y.com"));
        assert!(!safe_address(""));
    }
}
