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
    /// csv o banco.
    pub fuente: String,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub movs: Vec<Mov>,
    /// Filas revertidas, rechazadas o sin fecha/importe.
    pub ignorados: usize,
    /// Oro (materias primas) del resumen del ejercicio.
    pub oro: Option<Oro>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Oro {
    /// Onzas troy (XAU) en cartera.
    pub onzas: f64,
    /// Lo que costaron, en euros.
    pub coste: f64,
    /// Valor según Revolut al cierre del resumen.
    pub valor: Option<f64>,
    /// Fecha del cierre del resumen (AAAA-MM-DD).
    pub fecha: String,
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

/// `1 ene 2026`, `20 sept 2026` (resumen del ejercicio) o `1/1/26` (intereses).
fn fecha_es(s: &str) -> Option<String> {
    let s = s.trim();
    if let Ok(d) = NaiveDate::parse_from_str(s, "%d/%m/%y") {
        return d.and_hms_opt(0, 0, 0).map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string());
    }
    let mut it = s.split_whitespace();
    let (d, m, y) = (it.next()?.parse::<u32>().ok()?, norm(it.next()?), it.next()?.parse::<i32>().ok()?);
    const M: [&str; 12] = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    let mes = M.iter().position(|p| m.starts_with(p))? as u32 + 1;
    NaiveDate::from_ymd_opt(y, mes, d)?.and_hms_opt(0, 0, 0).map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
}

/// «Resumen del ejercicio» de Revolut: varios bloques (cuentas, hucha, inversión…) en un solo CSV.
/// Se leen los movimientos de las cuentas corrientes, los intereses de la hucha (sumados por mes)
/// y el saldo de cierre de la hucha.
fn parse_resumen(text: &str) -> Result<Parsed, String> {
    let mut rdr = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(text.as_bytes());
    let rows: Vec<Vec<String>> = rdr
        .records()
        .map(|r| r.map(|r| r.iter().map(|f| f.trim().to_string()).collect()))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("No se puede leer el CSV: {e}"))?;
    fn f(r: &[String], i: usize) -> &str {
        r.get(i).map(String::as_str).unwrap_or("")
    }

    // Nombre de la hucha («Cuenta con mejora activada»): sale en los intereses.
    let hucha = rows.iter().find_map(|r| {
        let d = f(r, 1);
        let i = d.find("pagado a ")? + "pagado a ".len();
        let rest = &d[i..];
        Some(rest[..rest.rfind(" del ").unwrap_or(rest.len())].to_string())
    });
    let hucha_n = hucha.as_deref().map(norm).filter(|h| h.len() >= 4);

    #[derive(PartialEq, Clone, Copy)]
    enum Zona { Nada, ResumenAhorro, ResumenOro, Corriente, Ahorro, Oro }
    let mut zona = Zona::Nada;
    let mut divisa = "EUR".to_string();
    let mut cols: Option<(usize, usize, Option<usize>, Option<usize>)> = None; // importe, descripción, saldo, comisión
    let mut interes_col: Option<usize> = None;
    let mut cierre_hucha: Option<f64> = None;
    let mut cierre_oro: Option<f64> = None;
    let (mut onzas, mut coste, mut hay_oro) = (0.0_f64, 0.0_f64, false);
    // Columnas de la tabla de oro: (unidades, valor, es compra).
    let mut oro_cols: Option<(usize, Option<usize>, bool)> = None;
    let mut intereses: Vec<(String, f64)> = Vec::new();
    let mut out = Parsed::default();
    let mut seen: HashMap<String, u32> = HashMap::new();

    for r in &rows {
        let a = f(r, 0);
        let solo = r.iter().skip(1).all(String::is_empty);
        if solo && !a.is_empty() {
            let n = norm(a);
            let sub = n.starts_with("estado") || n.starts_with("extracto");
            if n.contains("resumenes") {
                zona = if n.contains("ahorro") { Zona::ResumenAhorro } else if n.contains("materiaprima") { Zona::ResumenOro } else { Zona::Nada };
            } else if !sub && (n.contains("estadodetransacciones") || n.contains("transactionstatements")) {
                zona = if n.contains("corriente") { Zona::Corriente } else if n.contains("ahorro") { Zona::Ahorro } else if n.contains("materiaprima") { Zona::Oro } else { Zona::Nada };
            }
            oro_cols = None;
            // «Cuenta personal (EUR)», «Ahorros  (EUR)»: la divisa del bloque.
            if let (Some(i), Some(j)) = (a.rfind('('), a.rfind(')')) {
                let d = a[i + 1..j.max(i + 1)].trim();
                if d.len() == 3 && d.chars().all(|c| c.is_ascii_uppercase()) {
                    divisa = d.to_string();
                }
            }
            cols = None;
            interes_col = None;
            continue;
        }
        if matches!(zona, Zona::ResumenAhorro | Zona::ResumenOro) {
            if let Some(i) = r.iter().position(|x| norm(x) == "saldodecierre") {
                let slot = if zona == Zona::ResumenAhorro { &mut cierre_hucha } else { &mut cierre_oro };
                if slot.is_none() {
                    *slot = amount(f(r, i + 1));
                }
            }
            continue;
        }
        if zona == Zona::Oro {
            let h: Vec<String> = r.iter().map(|x| norm(x)).collect();
            if let Some(u) = h.iter().position(|x| x == "unidadescompradas") {
                oro_cols = Some((u, h.iter().position(|x| x.starts_with("valordelacompra")), true));
                continue;
            }
            if let Some(u) = h.iter().position(|x| x == "unidadesvendidas") {
                oro_cols = Some((u, None, false));
                continue;
            }
            // Filas de datos: empiezan por una fecha y son de XAU.
            if let Some((u, v, compra)) = oro_cols {
                if a.starts_with(|c: char| c.is_ascii_digit()) && r.iter().any(|x| x.trim() == "XAU") {
                    if let Some(units) = amount(f(r, u)).map(f64::abs) {
                        hay_oro = true;
                        if compra {
                            onzas += units;
                            coste += v.and_then(|v| amount(f(r, v))).map(f64::abs).unwrap_or(0.0);
                        } else if onzas > 0.0 {
                            coste -= coste * (units / onzas).min(1.0);
                            onzas -= units;
                        }
                    }
                }
            }
            continue;
        }
        if a == "Total" || a.starts_with("---") || a.is_empty() {
            cols = None;
            interes_col = None;
            continue;
        }
        if norm(a) == "fecha" {
            let h: Vec<String> = r.iter().map(|x| norm(x)).collect();
            let pos = |k: &str| h.iter().position(|x| x == k);
            if zona == Zona::Corriente {
                if let (Some(imp), Some(desc)) = (pos("entradassalidasdedinero"), pos("descripcion")) {
                    cols = Some((imp, desc, pos("saldo"), pos("comisiones")));
                }
            } else if zona == Zona::Ahorro {
                interes_col = pos("netinterest").or_else(|| pos("interesneto"));
            }
            continue;
        }
        if let Some((imp, desc, saldo, com)) = cols {
            let (Some(fecha), Some(importe)) = (fecha_es(a), amount(f(r, imp))) else {
                out.ignorados += 1;
                continue;
            };
            let descripcion = f(r, desc).to_string();
            let d = norm(&descripcion);
            let low = descripcion.to_lowercase();
            let cat = norm(f(r, desc + 1));
            let tipo = if d.starts_with("revertof") || cat.contains("reembolso") {
                "reembolso".to_string()
            } else if ["bizum payment to", "to ", "a ", "from ", "desde ", "transfer "].iter().any(|p| low.starts_with(p)) && !cat.contains("comercio") {
                if cat.contains("cambio") { "cambio".into() } else { "transferencia".into() }
            } else if cat.contains("comercio") || d.starts_with("bizumpurchase") {
                "tarjeta".to_string()
            } else {
                tipo(&cat)
            };
            let producto = "cuenta".to_string();
            let base = format!("resumen|{producto}|{divisa}|{fecha}|{descripcion}|{importe:.2}");
            let n = seen.entry(base.clone()).or_insert(0);
            *n += 1;
            let interno = interno(&tipo, &producto, &descripcion)
                || hucha_n.as_deref().is_some_and(|h| d.contains(h));
            out.movs.push(Mov {
                id: hash(&if *n == 1 { base } else { format!("{base}#{n}") }),
                comercio: comercio(&descripcion),
                completada: Some(fecha.clone()),
                fecha,
                tipo,
                producto,
                descripcion,
                importe,
                comision: com.and_then(|i| amount(f(r, i))).map(f64::abs).unwrap_or(0.0),
                divisa: divisa.clone(),
                estado: "completado".into(),
                saldo: saldo.and_then(|i| amount(f(r, i))),
                interno,
                fuente: "csv".into(),
            });
        } else if let Some(i) = interes_col {
            if let (Some(fecha), Some(neto)) = (fecha_es(a), amount(f(r, i))) {
                intereses.push((fecha, neto));
            }
        }
    }

    // Intereses de la hucha: uno por mes, con fecha del último día pagado.
    let mut meses: Vec<(String, String, f64)> = Vec::new(); // mes, última fecha, suma
    for (fecha, neto) in intereses {
        match meses.last_mut() {
            Some((m, ultima, suma)) if *m == fecha[..7] => {
                *ultima = fecha;
                *suma += neto;
            }
            _ => meses.push((fecha[..7].to_string(), fecha, neto)),
        }
    }
    let nombre = hucha.unwrap_or_else(|| "hucha".into());
    let n_meses = meses.len();
    for (k, (mes, ultima, suma)) in meses.into_iter().enumerate() {
        let descripcion = format!("Intereses de {nombre}");
        out.movs.push(Mov {
            id: hash(&format!("resumen|interes|{mes}")),
            comercio: comercio(&descripcion),
            completada: Some(ultima.clone()),
            fecha: ultima,
            tipo: "intereses".into(),
            producto: "ahorro".into(),
            descripcion,
            importe: (suma * 100.0).round() / 100.0,
            comision: 0.0,
            divisa: "EUR".into(),
            estado: "completado".into(),
            saldo: if k + 1 == n_meses { cierre_hucha } else { None },
            interno: false,
            fuente: "csv".into(),
        });
    }
    out.movs.sort_by(|a, b| a.fecha.cmp(&b.fecha));
    if hay_oro || cierre_oro.is_some_and(|v| v > 0.0) {
        out.oro = Some(Oro {
            onzas: (onzas.max(0.0) * 1e6).round() / 1e6,
            coste: (coste.max(0.0) * 100.0).round() / 100.0,
            valor: cierre_oro,
            fecha: out.movs.last().map(|m| m.fecha[..10].to_string()).unwrap_or_default(),
        });
    }
    if out.movs.is_empty() {
        return Err("Este resumen de Revolut no trae movimientos de la cuenta.".into());
    }
    Ok(out)
}

pub fn parse(text: &str) -> Result<Parsed, String> {
    let text = text.trim_start_matches('\u{feff}');
    if text.lines().any(|l| {
        let n = norm(l);
        n.starts_with("fechadescripcioncategoria") || n.starts_with("cuentascorrientesresumenes")
    }) {
        return parse_resumen(text);
    }
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
            fuente: "csv".into(),
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

    const RESUMEN: &str = r#""Cuentas corrientes Resúmenes",,,,,,,,,,,
,,,,,,,,,,,
"Cuenta personal (EUR)",,,,,,,,,,,
"Ingresos generados (incluidas invitaciones y recompensas)",,,,,,,,,,,
"Ingresos por intereses","0,00€","Impuestos retenidos sobre los intereses","0,00€",,,,,,,,
---------,,,,,,,,,,,
"Cuentas de Ahorro Resúmenes",,,,,,,,,,,
"Ahorros  (EUR)",,,,,,,,,,,
"Valor del depósito",,,,,,,,,,,
"Saldo medio del segundo trimestre 2026","41.176,97€","Saldo de cierre","40.002,04€",,,,,,,,
---------,,,,,,,,,,,
"Cuentas corrientes Estado de transacciones",,,,,,,,,,,
"Cuenta personal (EUR)",,,,,,,,,,,
"Extracto de transacción",,,,,,,,,,,
Fecha,Descripción,Categoría,"Entradas/salidas de dinero",Saldo,"Impuestos retenidos","Otros impuestos",Comisiones,,,,
"1 ene 2026","Bizum payment to: Ana P.",Otras,"-11,70€","760,67€","0,00€","0,00€","0,00€",,,,
"3 ene 2026",Amazon,Comercio,"-21,54€","739,13€","0,00€","0,00€","0,00€",,,,
"4 ene 2026","Dinero añadido a través de BIZUM",Recargar,"9,18€","748,31€","0,00€","0,00€","0,00€",,,,
"4 ene 2026","Dinero añadido a través de BIZUM",Recargar,"9,18€","757,49€","0,00€","0,00€","0,00€",,,,
"20 sept 2026","To Cuenta con mejora activada",Otras,"-100,00€","657,49€","0,00€","0,00€","0,00€",,,,
"21 sept 2026",Zara,Reembolso,"15,00€","672,49€","0,00€","0,00€","0,00€",,,,
"22 sept 2026","Conversión a XAU",Cambio,"-5,00€","667,49€","0,00€","0,00€","0,25€",,,,
Total,,,"-262,02€",,"0,00€","0,00€","4,75€",,,,
---------,,,,,,,,,,,
"Cuenta personal (SEK)",,,,,,,,,,,
"Extracto de transacción",,,,,,,,,,,
Fecha,Descripción,Categoría,"Entradas/salidas de dinero","Entradas/salidas de dinero",Saldo,"Impuestos retenidos","Impuestos retenidos","Otros impuestos","Otros impuestos",Comisiones,Comisiones
Total,,,"0,00 SEK","0,00€",,"0,00 SEK","0,00€","0,00 SEK","0,00€","0,00 SEK","0,00€"
---------,,,,,,,,,,,
"Cuentas de Ahorro Transaction Statements",,,,,,,,,,,
"Ahorros  (EUR)",,,,,,,,,,,
"Extracto de transacciones (recibo de solo intereses)",,,,,,,,,,,
Fecha,Descripción,TAE,TIN,"Gross interest","Impuestos retenidos","Other taxes",Fees,"Net interest",,,
1/1/26,"Interés neto pagado a Cuenta con mejora activada del 1 ene 2026","1.25%","1.25%","1,35€","0,25€","0,00€","0,00€","1,10€",,,
2/1/26,"Interés neto pagado a Cuenta con mejora activada del 2 ene 2026","1.25%","1.25%","1,36€","0,26€","0,00€","0,00€","1,10€",,,
1/2/26,"Interés neto pagado a Cuenta con mejora activada del 1 feb 2026","1.25%","1.25%","1,36€","0,26€","0,00€","0,00€","1,05€",,,
---------,,,,,,,,,,,
"Materia prima Resúmenes",,,,,,,,,,,
"Valor del depósito",,,,,,,,,,,
"Saldo medio del segundo trimestre",€465.70,"Saldo de cierre",€404.39,,,,,,,,
---------,,,,,,,,,,,
"Materia prima Estado de transacciones",,,,,,,,,,,
"Estado de transacciones (solo de las unidades vendidas)",,,,,,,,,,,
"Fecha (de venta)","Materia prima","Edad de las unidades","Unidades vendidas","Precio unitario (en la fecha de venta)","Valor (de venta)","Ganancias de capital",Comisiones,,,,
Acquired,,,,,,,,,,,
"Estado de transacciones (solo de las unidades adquiridas durante el año)",,,,,,,,,,,
"en la fecha de compra","Descripción y símbolo","Unidades compradas","Precio unitario","Valor de la compra",Comisiones,Comisiones,"Tipo de transacción",,,,
2026-05-04T09:40:07.226Z,XAU,0.124945,"-€4,001.76",-500€,"0,001249 XAU","4,95€",EXCHANGE,,,,
---------,,,,,,,,,,,
"Crypto Estado de transacciones",,,,,,,,,,,
"Fecha de compra","Descripción y símbolo","Unidades compradas","Precio unitario","Valor de la compra",Comisiones,,,,,,
"#;

    #[test]
    fn lee_el_resumen_del_ejercicio() {
        let p = parse(RESUMEN).unwrap();
        let cuenta: Vec<_> = p.movs.iter().filter(|m| m.producto == "cuenta").collect();
        assert_eq!(cuenta.len(), 7);
        assert_eq!(cuenta[0].fecha, "2026-01-01 00:00:00");
        assert_eq!(cuenta[0].tipo, "transferencia");
        assert_eq!(cuenta[0].saldo, Some(760.67));
        assert_eq!(cuenta[1].tipo, "tarjeta");
        assert_eq!(cuenta[2].tipo, "recarga");
        assert_ne!(cuenta[2].id, cuenta[3].id, "dos bizum iguales el mismo día");
        let hucha = cuenta.iter().find(|m| m.descripcion.starts_with("To Cuenta")).unwrap();
        assert!(hucha.interno);
        assert_eq!(hucha.fecha, "2026-09-20 00:00:00");
        assert_eq!(cuenta[5].tipo, "reembolso");
        assert!(cuenta[6].interno, "cambio a oro");
        assert_eq!(cuenta[6].comision, 0.25);
        assert!(cuenta.iter().all(|m| m.divisa == "EUR"));

        let int: Vec<_> = p.movs.iter().filter(|m| m.producto == "ahorro").collect();
        assert_eq!(int.len(), 2, "un apunte de intereses por mes");
        assert_eq!(int[0].importe, 2.2);
        assert_eq!(int[0].fecha, "2026-01-02 00:00:00");
        assert!(!int[0].interno);
        assert_eq!(int[0].saldo, None);
        assert_eq!(int[1].saldo, Some(40002.04), "saldo de cierre de la hucha en el último");

        let oro = p.oro.expect("oro");
        assert_eq!(oro.onzas, 0.124945);
        assert_eq!(oro.coste, 500.0);
        assert_eq!(oro.valor, Some(404.39));
        assert_eq!(oro.fecha, "2026-09-22");
    }

    /// `LIFE_CSV=ruta cargo test archivo_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn archivo_real() {
        let path = std::env::var("LIFE_CSV").expect("LIFE_CSV");
        let bytes = std::fs::read(path).unwrap();
        let p = parse(&String::from_utf8_lossy(&bytes)).unwrap();
        let mut por_tipo: HashMap<String, usize> = HashMap::new();
        for m in &p.movs {
            *por_tipo.entry(format!("{}/{}/{}", m.producto, m.tipo, if m.interno { "interno" } else { "-" })).or_default() += 1;
        }
        println!("movimientos {} · ignorados {}", p.movs.len(), p.ignorados);
        println!("{por_tipo:#?}");
        println!("primero {} · último {}", p.movs[0].fecha, p.movs.last().unwrap().fecha);
        let ultimo_saldo = p.movs.iter().rev().find(|m| m.producto == "cuenta" && m.saldo.is_some()).and_then(|m| m.saldo);
        let hucha = p.movs.iter().rev().find(|m| m.producto == "ahorro" && m.saldo.is_some()).and_then(|m| m.saldo);
        println!("saldo cuenta {ultimo_saldo:?} · hucha {hucha:?}");
        let suma: f64 = p.movs.iter().filter(|m| m.producto == "cuenta").map(|m| m.importe).sum();
        println!("suma cuenta {suma:.2}");
        println!("oro {:?}", p.oro);
    }

    #[test]
    fn importes() {
        assert_eq!(amount("-1,234.56"), Some(-1234.56));
        assert_eq!(amount("12,5 €"), Some(12.5));
        assert_eq!(amount(""), None);
    }
}
