//! Un movimiento de dinero tal como lo guarda LIFE (llega del banco por Open Banking).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Mov {
    /// Huella estable del movimiento: volver a leerlo no lo duplica.
    pub id: String,
    /// `AAAA-MM-DD HH:MM:SS`.
    pub fecha: String,
    pub completada: Option<String>,
    /// tarjeta, recarga, transferencia, cambio, reembolso, cajero, comision, intereses u otro.
    pub tipo: String,
    /// cuenta, ahorro u otro.
    pub producto: String,
    /// Comercio o persona.
    pub descripcion: String,
    /// Concepto que escribió quien pagó (Bizum, transferencias): «YT Premium», «cena»…
    pub concepto: Option<String>,
    /// Clave de comercio para agrupar y recordar categorías.
    pub comercio: String,
    pub importe: f64,
    pub comision: f64,
    pub divisa: String,
    /// completado o pendiente.
    pub estado: String,
    pub saldo: Option<f64>,
    /// Movimiento entre tus propias cuentas (hucha, cambio de divisa): no es ingreso ni gasto.
    pub interno: bool,
    /// banco (o csv, de importaciones antiguas que siguen en life.db).
    pub fuente: String,
}

/// Clave de comercio: «AMAZON.ES*AB12CD34» y «Amazon.es*ZZ9» → «amazon es».
pub fn comercio(desc: &str) -> String {
    let base = match desc.find('*') {
        Some(i) if i >= 3 => &desc[..i],
        _ => desc,
    };
    let mut out = String::new();
    for word in base.split(|c: char| !c.is_alphanumeric()) {
        if word.is_empty() || word.chars().filter(char::is_ascii_digit).count() >= 3 {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.extend(word.chars().flat_map(char::to_lowercase));
    }
    let out: String = out.chars().take(40).collect();
    if out.is_empty() { desc.trim().to_lowercase() } else { out }
}

#[cfg(test)]
mod tests {
    #[test]
    fn clave_de_comercio() {
        assert_eq!(super::comercio("AMAZON.ES*AB12CD34"), "amazon es");
        assert_eq!(super::comercio("Netflix.com"), "netflix com");
        assert_eq!(super::comercio("Plk 16086 Cc Los Fresn"), "plk cc los fresn");
    }
}
