//! Tokens de Claude por modelo. Dos fuentes, ambas locales y de solo lectura:
//! - Las sesiones de Claude Code (terminal y pestaña Code de la app): sus registros en
//!   `%USERPROFILE%\.claude\projects\**\*.jsonl` traen el uso de cada mensaje. Se leen por
//!   partes (solo lo nuevo desde la última vez) y cada mensaje cuenta una vez.
//! - Las llamadas de LIFE a Claude Code (parte, preguntas, radar, categorías), que no dejan registro.
//! Los chats de claude.ai y el porcentaje de los límites del plan no están disponibles.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Uso {
    pub modelo: String,
    pub entrada: i64,
    pub salida: i64,
    pub cache_creacion: i64,
    pub cache_lectura: i64,
}

#[derive(Serialize, Debug, Clone)]
pub struct Fila {
    pub fecha: String,
    pub modelo: String,
    pub proyecto: String,
    pub entrada: i64,
    pub salida: i64,
    pub cache_creacion: i64,
    pub cache_lectura: i64,
    pub mensajes: i64,
}

pub fn carpeta() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".claude").join("projects"))
}

fn n(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

/// Uso de una respuesta de `claude -p --output-format json` (una entrada por modelo).
pub fn uso_de_respuesta(v: &Value, modelo_pedido: &str) -> Vec<Uso> {
    if let Some(obj) = v["modelUsage"].as_object().filter(|o| !o.is_empty()) {
        return obj
            .iter()
            .map(|(m, u)| Uso {
                modelo: m.clone(),
                entrada: n(&u["inputTokens"]),
                salida: n(&u["outputTokens"]),
                cache_creacion: n(&u["cacheCreationInputTokens"]),
                cache_lectura: n(&u["cacheReadInputTokens"]),
            })
            .collect();
    }
    let u = &v["usage"];
    if u.is_object() {
        return vec![Uso {
            modelo: modelo_pedido.to_string(),
            entrada: n(&u["input_tokens"]),
            salida: n(&u["output_tokens"]),
            cache_creacion: n(&u["cache_creation_input_tokens"]),
            cache_lectura: n(&u["cache_read_input_tokens"]),
        }];
    }
    Vec::new()
}

/// Nombre corto del proyecto a partir de la carpeta de Claude Code («C--proyects-life» → «life»).
pub fn proyecto(carpeta: &str) -> String {
    if carpeta.contains("scratch") || carpeta.contains("Claude-Data") {
        return "sin proyecto".into();
    }
    let ultimo = carpeta.rsplit("--").next().unwrap_or(carpeta);
    for pre in ["proyects-", "projects-", "proyectos-", "Users-"] {
        if let Some(r) = ultimo.strip_prefix(pre) {
            return r.to_string();
        }
    }
    ultimo.to_string()
}

fn sumar(conn: &Connection, fecha: &str, proyecto: &str, u: &Uso, mensajes: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO tokens_dia (fecha, modelo, proyecto, entrada, salida, cache_creacion, cache_lectura, mensajes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(fecha, modelo, proyecto) DO UPDATE SET
            entrada = entrada + excluded.entrada, salida = salida + excluded.salida,
            cache_creacion = cache_creacion + excluded.cache_creacion,
            cache_lectura = cache_lectura + excluded.cache_lectura, mensajes = mensajes + excluded.mensajes",
        params![fecha, u.modelo, proyecto, u.entrada, u.salida, u.cache_creacion, u.cache_lectura, mensajes],
    )?;
    Ok(())
}

/// Anota el uso de una llamada de LIFE.
pub fn registrar_life(conn: &Connection, usos: &[Uso]) -> rusqlite::Result<()> {
    let hoy = chrono::Local::now().format("%Y-%m-%d").to_string();
    for u in usos {
        sumar(conn, &hoy, "LIFE", u, 1)?;
    }
    Ok(())
}

fn jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            jsonl(&p, out);
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            out.push(p);
        }
    }
}

/// Lee lo nuevo de los registros de Claude Code y lo suma. Devuelve cuántos mensajes nuevos contó.
pub fn escanear(conn: &mut Connection, base: &Path) -> rusqlite::Result<usize> {
    let mut archivos = Vec::new();
    jsonl(base, &mut archivos);
    let tx = conn.transaction()?;
    let mut nuevos = 0;
    for ruta in archivos {
        let clave = ruta.to_string_lossy().to_string();
        let proy = ruta
            .strip_prefix(base)
            .ok()
            .and_then(|r| r.components().next())
            .map(|c| proyecto(&c.as_os_str().to_string_lossy()))
            .unwrap_or_else(|| "sin proyecto".into());
        let Ok(mut f) = std::fs::File::open(&ruta) else { continue };
        let largo = f.metadata().map(|m| m.len()).unwrap_or(0);
        let mut desde: u64 = tx
            .query_row("SELECT offset FROM tokens_archivos WHERE ruta = ?1", [&clave], |r| r.get::<_, i64>(0))
            .optional()?
            .unwrap_or(0) as u64;
        if desde > largo {
            desde = 0; // el archivo se reescribió
        }
        if desde == largo {
            continue;
        }
        if f.seek(SeekFrom::Start(desde)).is_err() {
            continue;
        }
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            continue;
        }
        // Solo líneas completas: lo que esté a medio escribir se lee la próxima vez.
        let Some(fin) = buf.iter().rposition(|b| *b == b'\n') else { continue };
        for linea in buf[..fin].split(|b| *b == b'\n') {
            if !linea.windows(7).any(|w| w == b"\"usage\"") {
                continue;
            }
            let Ok(v) = serde_json::from_slice::<Value>(linea) else { continue };
            if v["type"] != "assistant" {
                continue;
            }
            let m = &v["message"];
            let (Some(id), Some(modelo)) = (m["id"].as_str(), m["model"].as_str()) else { continue };
            if modelo.starts_with('<') {
                continue; // mensajes sintéticos
            }
            if tx.execute("INSERT OR IGNORE INTO tokens_vistos (id) VALUES (?1)", [id])? == 0 {
                continue; // el mismo mensaje en otra línea
            }
            let u = &m["usage"];
            let fecha = v["timestamp"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
            let uso = Uso {
                modelo: modelo.to_string(),
                entrada: n(&u["input_tokens"]),
                salida: n(&u["output_tokens"]),
                cache_creacion: n(&u["cache_creation_input_tokens"]),
                cache_lectura: n(&u["cache_read_input_tokens"]),
            };
            sumar(&tx, &fecha, &proy, &uso, 1)?;
            nuevos += 1;
        }
        tx.execute(
            "INSERT INTO tokens_archivos (ruta, offset) VALUES (?1, ?2) ON CONFLICT(ruta) DO UPDATE SET offset = excluded.offset",
            params![clave, (desde + fin as u64 + 1) as i64],
        )?;
    }
    tx.commit()?;
    Ok(nuevos)
}

pub fn filas(conn: &Connection, desde: &str) -> rusqlite::Result<Vec<Fila>> {
    let mut st = conn.prepare(
        "SELECT fecha, modelo, proyecto, entrada, salida, cache_creacion, cache_lectura, mensajes
         FROM tokens_dia WHERE fecha >= ?1 ORDER BY fecha",
    )?;
    let rows = st.query_map([desde], |r| {
        Ok(Fila {
            fecha: r.get(0)?, modelo: r.get(1)?, proyecto: r.get(2)?, entrada: r.get(3)?, salida: r.get(4)?,
            cache_creacion: r.get(5)?, cache_lectura: r.get(6)?, mensajes: r.get(7)?,
        })
    })?;
    rows.collect()
}

#[allow(dead_code)]
pub fn totales_por_modelo(filas: &[Fila]) -> HashMap<String, i64> {
    let mut m = HashMap::new();
    for f in filas {
        *m.entry(f.modelo.clone()).or_default() += f.entrada + f.salida + f.cache_creacion;
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nombre_de_proyecto() {
        assert_eq!(proyecto("C--proyects-life"), "life");
        assert_eq!(proyecto("C--proyects-glutamato-cult"), "glutamato-cult");
        assert_eq!(proyecto("C--Users-casas-AppData-Local-Claude-Data-claude-x-scratch-workspaces-1"), "sin proyecto");
    }

    #[test]
    fn cuenta_cada_mensaje_una_vez_y_lee_por_partes() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::open(dir.path(), &crate::db::new_key()).unwrap();
        let mut conn = db;
        let base = dir.path().join("projects");
        let p = base.join("C--proyects-life");
        std::fs::create_dir_all(&p).unwrap();
        let l = |id: &str, out: i64| format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-11-20T10:00:00Z\",\"message\":{{\"id\":\"{id}\",\"model\":\"claude-opus-5-5\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":{out},\"cache_creation_input_tokens\":100,\"cache_read_input_tokens\":1000}}}}}}\n"
        );
        let f = p.join("s.jsonl");
        std::fs::write(&f, format!("{}{}", l("m1", 5), l("m1", 5))).unwrap();
        assert_eq!(escanear(&mut conn, &base).unwrap(), 1, "dos líneas del mismo mensaje cuentan una");
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(l("m2", 7).as_bytes()).unwrap();
        assert_eq!(escanear(&mut conn, &base).unwrap(), 1, "solo lo nuevo");
        let fs = filas(&conn, "2026-01-01").unwrap();
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].proyecto, "life");
        assert_eq!(fs[0].salida, 12);
        assert_eq!(fs[0].mensajes, 2);
    }

    #[test]
    fn uso_de_una_respuesta_de_claude_code() {
        let v: Value = serde_json::json!({"modelUsage": {"claude-sonnet-5-5": {"inputTokens": 3, "outputTokens": 40, "cacheReadInputTokens": 9, "cacheCreationInputTokens": 2}}});
        let u = uso_de_respuesta(&v, "sonnet");
        assert_eq!(u, vec![Uso { modelo: "claude-sonnet-5-5".into(), entrada: 3, salida: 40, cache_creacion: 2, cache_lectura: 9 }]);
    }
}

#[cfg(test)]
mod real {
    /// Lee tus registros reales en una base temporal: `cargo test tokens_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn tokens_real() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::open(dir.path(), &crate::db::new_key()).unwrap();
        let t = std::time::Instant::now();
        let n = super::escanear(&mut conn, &super::carpeta().unwrap()).unwrap();
        println!("primera lectura: {n} mensajes en {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let n2 = super::escanear(&mut conn, &super::carpeta().unwrap()).unwrap();
        println!("segunda lectura: {n2} mensajes en {:?}", t.elapsed());
        let filas = super::filas(&conn, "2026-10-01").unwrap();
        let mut por: std::collections::BTreeMap<(String, String), (i64, i64, i64, i64)> = Default::default();
        for f in &filas {
            let e = por.entry((f.modelo.clone(), f.proyecto.clone())).or_default();
            e.0 += f.entrada + f.cache_creacion; e.1 += f.salida; e.2 += f.cache_lectura; e.3 += f.mensajes;
        }
        for ((m, p), (i, o, r, k)) in por { println!("{m:<22} {p:<16} entrada={i:>11} salida={o:>9} cache_leida={r:>13} mensajes={k}"); }
    }
}
