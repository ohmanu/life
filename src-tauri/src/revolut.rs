//! Revolut · fase 2, primera parte: el CSV del extracto que exporta la app de Revolut.
//! LIFE no se conecta a Revolut: tú eliges el archivo, se lee una vez y se guarda en life.db.
//! Acepta el extracto en inglés o en español y separado por comas o por punto y coma.

use chrono::{NaiveDate, NaiveDateTime};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Mov {
    /// Huella estable del movimiento: reimportar un extracto que se solapa no duplica nada.
    pub id: String,
    /// Inicio de la operación, `AAAA-MM-DD HH:MM:SS`.
    pub fecha: String,
    pub completada: Option<String>,
    /// tarjeta, recarga, transferencia, cambio, reembolso, cajero, comision u otro.
    pub tipo: String,
    /// cuenta, ahorro u otro nombre de producto en minúsculas.
    pub producto: String,
    pub descripcion: String,
    /// Clave de comercio para agrupar y recordar categorías.
    pub comercio: String,
    pub importe: f64,
    pub comision: f64,
    pub divisa: String,
    /// completado o pendiente.
    pub estado: String,
    pub saldo: Option<f64>,
    /// Movimiento entre tus propias cuentas (hucha, cambio de divisa): no cuenta como ingreso ni gasto.
    pub interno: bool,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub movs: Vec<Mov>,
    /// Filas revertidas, rechazadas o sin fecha/importe.
    pub ignorados: usize,
}

/// Minúsculas, sin tildes y solo letras y números: para comparar cabeceras y valores.
fn norm(s: &str) -> String {
    s.trim_start_matches('\u{feff}')
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            c => c,
        })
        .filter(|c| c.is_alphanumeric())
        .collect()
}

#[derive(Default)]
struct Cols {
    tipo: Option<usize>,
    producto: Option<usize>,
    inicio: Option<usize>,
    fin: Option<usize>,
    descripcion: Option<usize>,
    importe: Option<usize>,
    comision: Option<usize>,
    divisa: Option<usize>,
    estado: Option<usize>,
    saldo: Option<usize>,
}

fn columns(header: &csv::StringRecord) -> Cols {
    let mut c = Cols::default();
    for (i, h) in header.iter().enumerate() {
        let slot = match norm(h).as_str() {
            "type" | "tipo" => &mut c.tipo,
            "product" | "producto" => &mut c.producto,
            "starteddate" | "startdate" | "fechadeinicio" | "fechainicio" | "fechadeinicializacion" => &mut c.inicio,
            "completeddate" | "fechadefinalizacion" | "fechafinalizacion" | "fechadecompletado" | "fechacompletada" => &mut c.fin,
            "description" | "descripcion" | "concepto" => &mut c.descripcion,
            "amount" | "importe" | "cantidad" => &mut c.importe,
            "fee" | "comision" | "comisiones" | "tarifa" => &mut c.comision,
            "currency" | "divisa" | "moneda" => &mut c.divisa,
            "state" | "estado" => &mut c.estado,
            "balance" | "saldo" => &mut c.saldo,
            _ => continue,
        };
        slot.get_or_insert(i);
    }
    c
}

/// `-1,234.56`, `-1.234,56`, `-12,50`, `12.5 €` → número.
pub fn amount(s: &str) -> Option<f64> {
    let s: String = s.chars().filter(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | ',' | '.')).collect();
    if s.is_empty() {
        return None;
    }
    let s = match (s.rfind(','), s.rfind('.')) {
        (Some(c), Some(d)) if c > d => s.replace('.', "").replace(',', "."),
        (Some(_), Some(_)) => s.replace(',', ""),
        (Some(_), None) => s.replace(',', "."),
        _ => s,
    };
    s.parse().ok()
}

/// Fecha del extracto → `AAAA-MM-DD HH:MM:SS`.
pub fn date(s: &str) -> Option<String> {
    let s = s.trim();
    const DT: &[&str] = &["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M"];
    const D: &[&str] = &["%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y"];
    let fmt = "%Y-%m-%d %H:%M:%S";
    DT.iter()
        .find_map(|f| NaiveDateTime::parse_from_str(s, f).ok())
        .or_else(|| D.iter().find_map(|f| NaiveDate::parse_from_str(s, f).ok()).and_then(|d| d.and_hms_opt(0, 0, 0)))
        .map(|d| d.format(fmt).to_string())
}

fn tipo(s: &str) -> String {
    let n = norm(s);
    let has = |k: &[&str]| k.iter().any(|k| n.contains(k));
    let t = if has(&["cardpayment", "pagocontarjeta", "pagotarjeta", "compra"]) {
        "tarjeta"
    } else if has(&["refund", "reembolso", "devolucion"]) {
        "reembolso"
    } else if has(&["topup", "recarga"]) {
        "recarga"
    } else if has(&["exchange", "intercambio", "cambiodedivisa"]) {
        "cambio"
    } else if has(&["transfer"]) {
        "transferencia"
    } else if has(&["atm", "cajero", "retirada"]) {
        "cajero"
    } else if has(&["fee", "comision", "cargo"]) {
        "comision"
    } else if n.is_empty() {
        "otro"
    } else {
        return n;
    };
    t.to_string()
}

fn producto(s: &str) -> String {
    let n = norm(s);
    let has = |k: &[&str]| k.iter().any(|k| n.contains(k));
    if n.is_empty() || has(&["current", "actual", "corriente", "principal"]) {
        "cuenta".into()
    } else if has(&["saving", "ahorro", "deposit", "deposito", "hucha", "vault", "pocket"]) {
        "ahorro".into()
    } else {
        n
    }
}

/// Clave de comercio: «AMAZON.ES*AB12CD34» y «Amazon.es*ZZ9» → «amazon es».
pub fn comercio(desc: &str) -> String {
    let base = match desc.find('*') {
        Some(i) if i >= 3 => &desc[..i],
        _ => desc,
    };
    let mut out = String::new();
    for word in base.split(|c: char| !c.is_alphanumeric()) {
        if word.is_empty() || (word.chars().filter(char::is_ascii_digit).count() >= 3) {
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

fn interno(tipo: &str, producto: &str, desc: &str) -> bool {
    let n = norm(desc);
    let has = |k: &[&str]| k.iter().any(|k| n.contains(k));
    if has(&["interest", "interes", "intereses"]) {
        return false; // los intereses de la hucha sí son ingreso
    }
    tipo == "cambio"
        || producto != "cuenta"
        || has(&["savings", "pocket", "vault", "hucha", "ahorro", "exchangedto", "cambiadoa"])
}

/// FNV-1a de 64 bits en hexadecimal.
fn hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub fn parse(text: &str) -> Result<Parsed, String> {
    let text = text.trim_start_matches('\u{feff}');
    let first = text.lines().next().unwrap_or_default();
    let delim = if first.matches(';').count() > first.matches(',').count() { b';' } else { b',' };
    let mut rdr = csv::ReaderBuilder::new().delimiter(delim).flexible(true).from_reader(text.as_bytes());
    let header = rdr.headers().map_err(|e| format!("No se puede leer el CSV: {e}"))?.clone();
    let c = columns(&header);
    let (Some(desc_i), Some(imp_i)) = (c.descripcion, c.importe) else {
        return Err("Este CSV no parece un extracto de Revolut: faltan las columnas de descripción e importe.".into());
    };
    if c.inicio.is_none() && c.fin.is_none() {
        return Err("Este CSV no parece un extracto de Revolut: falta la columna de fecha.".into());
    }

    let mut out = Parsed::default();
    let mut seen: HashMap<String, u32> = HashMap::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("Fila ilegible en el CSV: {e}"))?;
        let get = |i: Option<usize>| i.and_then(|i| rec.get(i)).unwrap_or("").trim();
        let estado_n = norm(get(c.estado));
        if ["revert", "declin", "rechaz", "fail", "fallid", "cancel", "anulad"].iter().any(|k| estado_n.contains(k)) {
            out.ignorados += 1;
            continue;
        }
        let completada = date(get(c.fin));
        let (Some(fecha), Some(importe)) = (date(get(c.inicio)).or_else(|| completada.clone()), amount(get(Some(imp_i)))) else {
            out.ignorados += 1;
            continue;
        };
        let descripcion = get(Some(desc_i)).to_string();
        let tipo = tipo(get(c.tipo));
        let producto = producto(get(c.producto));
        let divisa = match get(c.divisa) {
            "" => "EUR".to_string(),
            d => d.to_uppercase(),
        };
        let base = format!("{producto}|{fecha}|{descripcion}|{importe:.2}|{divisa}|{tipo}");
        let n = seen.entry(base.clone()).or_insert(0);
        *n += 1;
        let id = hash(&if *n == 1 { base } else { format!("{base}#{n}") });
        out.movs.push(Mov {
            id,
            interno: interno(&tipo, &producto, &descripcion),
            comercio: comercio(&descripcion),
            fecha,
            completada,
            tipo,
            producto,
            descripcion,
            importe,
            comision: amount(get(c.comision)).map(f64::abs).unwrap_or(0.0),
            divisa,
            estado: if estado_n.contains("pend") { "pendiente" } else { "completado" }.into(),
            saldo: amount(get(c.saldo)),
        });
    }
    if out.movs.is_empty() && out.ignorados == 0 {
        return Err("El CSV no tiene movimientos.".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: &str = "\u{feff}Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-10-03 09:12:44,2026-10-04 10:00:01,Netflix.com,-13.99,0.00,EUR,COMPLETED,1200.01
TOPUP,Current,2026-10-01 08:00:00,2026-10-01 08:00:02,Payment from Acme SL,2500.00,0.00,EUR,COMPLETED,1214.00
TRANSFER,Current,2026-10-05 12:00:00,2026-10-05 12:00:00,To EUR Savings,-300.00,0.00,EUR,COMPLETED,900.01
TRANSFER,Savings,2026-10-05 12:00:00,2026-10-05 12:00:00,From EUR Current,300.00,0.00,EUR,COMPLETED,6300.00
CARD_PAYMENT,Current,2026-10-06 13:30:00,,AMAZON.ES*AB12CD34,-25.50,0.00,EUR,PENDING,
CARD_PAYMENT,Current,2026-10-07 13:30:00,,Tienda,-9.00,0.00,EUR,REVERTED,
";

    #[test]
    fn lee_el_extracto_en_ingles() {
        let p = parse(EN).unwrap();
        assert_eq!(p.movs.len(), 5);
        assert_eq!(p.ignorados, 1);
        let n = &p.movs[0];
        assert_eq!(n.tipo, "tarjeta");
        assert_eq!(n.producto, "cuenta");
        assert_eq!(n.importe, -13.99);
        assert_eq!(n.saldo, Some(1200.01));
        assert_eq!(n.comercio, "netflix com");
        assert!(!n.interno);
        assert!(p.movs[2].interno, "a la hucha");
        assert!(p.movs[3].interno, "producto ahorro");
        assert_eq!(p.movs[4].estado, "pendiente");
        assert_eq!(p.movs[4].comercio, "amazon es");
    }

    #[test]
    fn lee_el_extracto_en_espanol_con_punto_y_coma() {
        let es = "Tipo;Producto;Fecha de inicio;Fecha de finalización;Descripción;Importe;Comisión;Divisa;State;Saldo
Pago con tarjeta;Actual;03/10/2026 09:12;03/10/2026 09:15;Mercadona;-1.234,56;0,00;EUR;COMPLETADO;10,00
Intercambio;Actual;04/10/2026 10:00;04/10/2026 10:00;Cambiado a USD;-100,00;0,50;EUR;COMPLETADO;9,00";
        let p = parse(es).unwrap();
        assert_eq!(p.movs.len(), 2);
        assert_eq!(p.movs[0].fecha, "2026-10-03 09:12:00");
        assert_eq!(p.movs[0].importe, -1234.56);
        assert_eq!(p.movs[0].tipo, "tarjeta");
        assert!(p.movs[1].interno);
        assert_eq!(p.movs[1].comision, 0.5);
    }

    #[test]
    fn la_huella_no_cambia_y_separa_repetidos() {
        let a = parse(EN).unwrap();
        let b = parse(EN).unwrap();
        assert_eq!(a.movs[0].id, b.movs[0].id);
        let twice = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-10-03 09:12:44,,Cafe,-1.50,0,EUR,COMPLETED,
CARD_PAYMENT,Current,2026-10-03 09:12:44,,Cafe,-1.50,0,EUR,COMPLETED,";
        let p = parse(twice).unwrap();
        assert_ne!(p.movs[0].id, p.movs[1].id);
    }

    #[test]
    fn rechaza_otros_csv() {
        assert!(parse("nombre,correo\nana,a@b.c").is_err());
    }

    #[test]
    fn importes() {
        assert_eq!(amount("-1,234.56"), Some(-1234.56));
        assert_eq!(amount("12,5 €"), Some(12.5));
        assert_eq!(amount(""), None);
    }
}
