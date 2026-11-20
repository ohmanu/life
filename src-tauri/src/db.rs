//! Base de datos local: un archivo SQLite (`life.db`) en la carpeta de datos de la app
//! (%APPDATA%\com.glutamato.life), cifrado con AES-256 (formato SQLCipher 4). La clave vive
//! en el Administrador de credenciales de Windows. Nada sale del ordenador.

use rusqlite::{Connection, OptionalExtension, params};
use crate::gmail::{Encargo, Pendiente};
use crate::revolut::Mov;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

/// Esquema. Se añaden migraciones al final, nunca se reescriben las anteriores.
const MIGRATIONS: &[&str] = &[
    // 1 · base
    "
    CREATE TABLE metricas_diarias (
        fuente TEXT NOT NULL,
        clave  TEXT NOT NULL,
        fecha  TEXT NOT NULL,          -- AAAA-MM-DD
        valor  REAL NOT NULL,
        PRIMARY KEY (fuente, clave, fecha)
    );
    CREATE TABLE instantaneas (
        fuente      TEXT PRIMARY KEY,  -- github, gmail, banco…
        json        TEXT NOT NULL,
        sincronizado TEXT NOT NULL     -- RFC 3339
    );
    CREATE TABLE sync_log (
        id      INTEGER PRIMARY KEY,
        fuente  TEXT NOT NULL,
        momento TEXT NOT NULL,
        ok      INTEGER NOT NULL,
        detalle TEXT
    );
    CREATE TABLE ajustes (
        clave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
    );
    -- Fases 1 y 2: se rellenan más adelante
    CREATE TABLE encargos (
        id          TEXT PRIMARY KEY,   -- id del hilo de Gmail
        recibido    TEXT NOT NULL,
        tipo        TEXT, que TEXT, nombre TEXT, correo TEXT,
        presupuesto TEXT, fecha TEXT, lugar TEXT, idioma TEXT, mensaje TEXT,
        estado      TEXT NOT NULL DEFAULT 'nuevo',
        respondido  TEXT,
        transaccion TEXT
    );
    CREATE TABLE transacciones (
        id        TEXT PRIMARY KEY,
        fecha     TEXT NOT NULL,
        importe   REAL NOT NULL,
        divisa    TEXT NOT NULL,
        comercio  TEXT,
        categoria_propuesta TEXT,
        categoria TEXT,
        cuenta    TEXT
    );
    ",
    // 2 · encargos desde Gmail
    "
    ALTER TABLE encargos ADD COLUMN uid INTEGER;
    ALTER TABLE encargos ADD COLUMN asunto TEXT;
    ALTER TABLE encargos ADD COLUMN telefono TEXT;
    ALTER TABLE encargos ADD COLUMN empresa TEXT;
    ALTER TABLE encargos ADD COLUMN web TEXT;
    ALTER TABLE encargos ADD COLUMN cambiado TEXT;
    CREATE INDEX encargos_recibido ON encargos (recibido);
    ",
    // 3 · dinero desde el CSV de Revolut (la tabla de la fase 0 estaba vacía)
    "
    DROP TABLE transacciones;
    CREATE TABLE transacciones (
        id          TEXT PRIMARY KEY,   -- huella del movimiento
        fecha       TEXT NOT NULL,      -- inicio, AAAA-MM-DD HH:MM:SS
        completada  TEXT,
        tipo        TEXT NOT NULL,
        producto    TEXT NOT NULL,
        descripcion TEXT NOT NULL,
        comercio    TEXT NOT NULL,
        importe     REAL NOT NULL,
        comision    REAL NOT NULL DEFAULT 0,
        divisa      TEXT NOT NULL,
        estado      TEXT NOT NULL,
        saldo       REAL,
        interno     INTEGER NOT NULL DEFAULT 0,
        importado   TEXT NOT NULL
    );
    CREATE INDEX transacciones_fecha ON transacciones (fecha);
    CREATE TABLE categorias (
        comercio  TEXT PRIMARY KEY,     -- la categoría que eliges se recuerda por comercio
        categoria TEXT NOT NULL
    );
    ",
    // 4 · origen de cada movimiento: csv o banco (Open Banking)
    "
    ALTER TABLE transacciones ADD COLUMN fuente TEXT NOT NULL DEFAULT 'csv';
    ",
];

/// Cabecera de un SQLite sin cifrar. Un archivo cifrado empieza por bytes aleatorios.
const PLAIN_HEADER: &[u8; 16] = b"SQLite format 3\0";

/// Abre `life.db` cifrada (formato SQLCipher 4) con `key`.
///
/// - Si el archivo existe en claro (versiones anteriores), lo cifra en el sitio.
/// - Si está cifrado con otra clave (credencial perdida), lo aparta como
///   `life.db.ilegible-<fecha>` y empieza una base nueva: los datos se pueden volver
///   a sincronizar, pero el archivo no se borra.
pub fn open(dir: &Path, key: &str) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(dir).ok();
    let path = dir.join("life.db");

    if is_plain(&path) {
        encrypt_in_place(&path, key)?;
        log::info!("life.db estaba sin cifrar: cifrada");
    }

    let conn = match open_keyed(&path, key) {
        Ok(c) => c,
        Err(e) if path.exists() => {
            let aside = dir.join(format!("life.db.ilegible-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
            log::warn!("life.db no se abre con la clave guardada ({e}); se aparta en {}", aside.display());
            drop_sidecars(&path);
            std::fs::rename(&path, &aside).map_err(io_err)?;
            open_keyed(&path, key)?
        }
        Err(e) => return Err(e),
    };

    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    Ok(conn)
}

/// Clave nueva: 32 bytes aleatorios del sistema en hexadecimal.
pub fn new_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("generador aleatorio del sistema");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn set_cipher(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "cipher", "sqlcipher")?;
    conn.pragma_update(None, "legacy", 4)?;
    Ok(())
}

fn open_keyed(path: &Path, key: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    set_cipher(&conn)?;
    conn.pragma_update(None, "key", key)?;
    // Con una clave errónea, la primera lectura falla con «file is not a database».
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
    Ok(conn)
}

fn is_plain(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 16];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == PLAIN_HEADER
}

fn encrypt_in_place(path: &Path, key: &str) -> rusqlite::Result<()> {
    let conn = Connection::open(path)?;
    // El cifrado en el sitio no funciona en modo WAL: se vuelca el WAL y se pasa a DELETE.
    conn.pragma_update(None, "journal_mode", "DELETE")?;
    set_cipher(&conn)?;
    conn.pragma_update(None, "rekey", key)?;
    Ok(())
}

fn drop_sidecars(path: &Path) {
    for ext in ["db-wal", "db-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
}

fn io_err(e: std::io::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(e))
}

pub fn save_snapshot(conn: &Connection, fuente: &str, json: &str, when: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO instantaneas (fuente, json, sincronizado) VALUES (?1, ?2, ?3)
         ON CONFLICT(fuente) DO UPDATE SET json = excluded.json, sincronizado = excluded.sincronizado",
        params![fuente, json, when],
    )?;
    Ok(())
}

pub fn snapshot(conn: &Connection, fuente: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT json FROM instantaneas WHERE fuente = ?1", [fuente], |r| r.get(0))
        .optional()
}

pub fn delete_snapshot(conn: &Connection, fuente: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM instantaneas WHERE fuente = ?1", [fuente])?;
    Ok(())
}

pub fn ajuste(conn: &Connection, clave: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT valor FROM ajustes WHERE clave = ?1", [clave], |r| r.get(0)).optional()
}

pub fn set_ajuste(conn: &Connection, clave: &str, valor: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ajustes (clave, valor) VALUES (?1, ?2)
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
        params![clave, valor],
    )?;
    Ok(())
}

// ── Encargos ──────────────────────────────────────────────────────────────

/// Guarda un encargo leído de Gmail. Si ya existía, solo actualiza el UID: el estado que
/// marcaste a mano no se pisa.
pub fn insert_encargo(conn: &Connection, e: &Encargo) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "INSERT INTO encargos (id, uid, recibido, asunto, tipo, que, nombre, correo, telefono, empresa,
                               fecha, lugar, web, presupuesto, idioma, mensaje, estado)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'nuevo')
         ON CONFLICT(id) DO NOTHING",
        params![e.id, e.uid, e.recibido, e.asunto, e.tipo, e.que, e.nombre, e.correo, e.telefono,
                e.empresa, e.fecha, e.lugar, e.web, e.presupuesto, e.idioma, e.mensaje],
    )?;
    if n == 0 {
        conn.execute("UPDATE encargos SET uid = ?2 WHERE id = ?1", params![e.id, e.uid])?;
    }
    Ok(n > 0)
}

pub fn encargos(conn: &Connection) -> rusqlite::Result<Vec<Encargo>> {
    let mut st = conn.prepare(
        "SELECT id, COALESCE(uid, 0), recibido, COALESCE(asunto, ''), COALESCE(tipo, ''), COALESCE(que, ''),
                COALESCE(nombre, ''), COALESCE(correo, ''), COALESCE(telefono, ''), COALESCE(empresa, ''),
                COALESCE(fecha, ''), COALESCE(lugar, ''), COALESCE(web, ''), COALESCE(presupuesto, ''),
                COALESCE(idioma, ''), COALESCE(mensaje, ''), estado, respondido
         FROM encargos ORDER BY recibido DESC",
    )?;
    let rows = st.query_map([], |r| {
        Ok(Encargo {
            id: r.get(0)?, uid: r.get(1)?, recibido: r.get(2)?, asunto: r.get(3)?, tipo: r.get(4)?,
            que: r.get(5)?, nombre: r.get(6)?, correo: r.get(7)?, telefono: r.get(8)?, empresa: r.get(9)?,
            fecha: r.get(10)?, lugar: r.get(11)?, web: r.get(12)?, presupuesto: r.get(13)?,
            idioma: r.get(14)?, mensaje: r.get(15)?, estado: r.get(16)?, respondido: r.get(17)?,
        })
    })?;
    rows.collect()
}

pub fn known_uids(conn: &Connection) -> rusqlite::Result<HashSet<u32>> {
    let mut st = conn.prepare("SELECT uid FROM encargos WHERE uid IS NOT NULL")?;
    let rows = st.query_map([], |r| r.get::<_, u32>(0))?;
    rows.collect()
}

/// Encargos sin respuesta de los últimos 180 días (los descartados no cuentan).
pub fn pendientes(conn: &Connection, desde: &str) -> rusqlite::Result<Vec<Pendiente>> {
    let mut st = conn.prepare(
        "SELECT id, COALESCE(correo, ''), recibido FROM encargos
         WHERE respondido IS NULL AND estado != 'descartado' AND recibido >= ?1",
    )?;
    let rows = st.query_map([desde], |r| Ok(Pendiente { id: r.get(0)?, correo: r.get(1)?, recibido: r.get(2)? }))?;
    rows.collect()
}

/// Tu primera respuesta: guarda la fecha y, si seguía como «nuevo», lo pasa a «respondido».
pub fn set_respondido(conn: &Connection, id: &str, cuando: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE encargos SET respondido = ?2,
                estado = CASE WHEN estado = 'nuevo' THEN 'respondido' ELSE estado END
         WHERE id = ?1 AND respondido IS NULL",
        params![id, cuando],
    )?;
    Ok(())
}

pub fn set_estado(conn: &Connection, id: &str, estado: &str, cuando: &str) -> rusqlite::Result<usize> {
    conn.execute("UPDATE encargos SET estado = ?2, cambiado = ?3 WHERE id = ?1", params![id, estado, cuando])
}

// ── Dinero ────────────────────────────────────────────────────────────────

/// Guarda los movimientos de un extracto. Uno que ya estaba solo se actualiza (por ejemplo,
/// de pendiente a completado). Devuelve (nuevos, actualizados).
pub fn upsert_movs(conn: &mut Connection, movs: &[Mov], cuando: &str) -> rusqlite::Result<(usize, usize)> {
    let tx = conn.transaction()?;
    let (mut nuevos, mut cambiados) = (0, 0);
    {
        let mut prev = tx.prepare("SELECT estado, completada, saldo, importe FROM transacciones WHERE id = ?1")?;
        let mut ins = tx.prepare(
            "INSERT INTO transacciones (id, fecha, completada, tipo, producto, descripcion, comercio, importe,
                                        comision, divisa, estado, saldo, interno, importado, fuente)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        let mut upd = tx.prepare(
            "UPDATE transacciones SET estado = ?2, completada = ?3, saldo = ?4, comision = ?5, importe = ?6, fecha = ?7
             WHERE id = ?1",
        )?;
        for m in movs {
            let old: Option<(String, Option<String>, Option<f64>, f64)> =
                prev.query_row([&m.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional()?;
            match old {
                None => {
                    ins.execute(params![m.id, m.fecha, m.completada, m.tipo, m.producto, m.descripcion, m.comercio,
                                        m.importe, m.comision, m.divisa, m.estado, m.saldo, m.interno as i64, cuando, m.fuente])?;
                    nuevos += 1;
                }
                // Los intereses del mes en curso crecen de un resumen a otro: importe y fecha también se actualizan.
                Some((estado, completada, saldo, importe)) => {
                    if estado != m.estado || completada != m.completada || (m.saldo.is_some() && saldo != m.saldo)
                        || (importe - m.importe).abs() > 0.004
                    {
                        upd.execute(params![m.id, m.estado, m.completada, m.saldo.or(saldo), m.comision, m.importe, m.fecha])?;
                        cambiados += 1;
                    }
                }
            }
        }
    }
    tx.commit()?;
    Ok((nuevos, cambiados))
}

pub fn movs(conn: &Connection) -> rusqlite::Result<Vec<Mov>> {
    let mut st = conn.prepare(
        "SELECT id, fecha, completada, tipo, producto, descripcion, comercio, importe, comision, divisa,
                estado, saldo, interno, fuente
         FROM transacciones ORDER BY fecha, rowid",
    )?;
    let rows = st.query_map([], |r| {
        Ok(Mov {
            id: r.get(0)?, fecha: r.get(1)?, completada: r.get(2)?, tipo: r.get(3)?, producto: r.get(4)?,
            descripcion: r.get(5)?, comercio: r.get(6)?, importe: r.get(7)?, comision: r.get(8)?,
            divisa: r.get(9)?, estado: r.get(10)?, saldo: r.get(11)?, interno: r.get::<_, i64>(12)? != 0, fuente: r.get(13)?,
        })
    })?;
    rows.collect()
}

pub fn categorias(conn: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    let mut st = conn.prepare("SELECT comercio, categoria FROM categorias")?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Categoría elegida para un comercio; vacía = volver a la automática.
pub fn set_categoria(conn: &Connection, comercio: &str, categoria: &str) -> rusqlite::Result<()> {
    if categoria.is_empty() {
        conn.execute("DELETE FROM categorias WHERE comercio = ?1", [comercio])?;
    } else {
        conn.execute(
            "INSERT INTO categorias (comercio, categoria) VALUES (?1, ?2)
             ON CONFLICT(comercio) DO UPDATE SET categoria = excluded.categoria",
            params![comercio, categoria],
        )?;
    }
    Ok(())
}

/// Nombres de tus huchas («Cuenta con mejora activada»), sacados de los intereses importados por CSV.
pub fn nombres_hucha(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare(
        "SELECT DISTINCT substr(descripcion, 14) FROM transacciones
         WHERE producto = 'ahorro' AND descripcion LIKE 'Intereses de %'",
    )?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).filter(|n| n.trim().len() >= 4 && n != "hucha").collect())
}

pub fn borrar_movs(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("DELETE FROM transacciones;")
}

pub fn log_sync(conn: &Connection, fuente: &str, ok: bool, detalle: Option<&str>) {
    let now = chrono::Local::now().to_rfc3339();
    let _ = conn.execute(
        "INSERT INTO sync_log (fuente, momento, ok, detalle) VALUES (?1, ?2, ?3, ?4)",
        params![fuente, now, ok as i64, detalle],
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(path: &Path) -> Vec<u8> {
        std::fs::read(path).unwrap()[..16].to_vec()
    }

    #[test]
    fn crea_cifrada_y_reabre() {
        let dir = tempfile::tempdir().unwrap();
        let key = new_key();
        assert_eq!(key.len(), 64);
        {
            let c = open(dir.path(), &key).unwrap();
            save_snapshot(&c, "github", "{\"a\":1}", "hoy").unwrap();
            c.pragma_update(None, "wal_checkpoint", "TRUNCATE").unwrap();
        }
        let file = dir.path().join("life.db");
        assert_ne!(header(&file), PLAIN_HEADER);
        assert!(!std::fs::read(&file).unwrap().windows(7).any(|w| w == b"github\0" || w == b"{\"a\":1}"));

        let c = open(dir.path(), &key).unwrap();
        assert_eq!(snapshot(&c, "github").unwrap().as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn reimportar_no_duplica_y_completa_pendientes() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = open(dir.path(), &new_key()).unwrap();
        let h = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";
        let a = crate::revolut::parse(&format!("{h}CARD_PAYMENT,Current,2026-10-06 13:30:00,,Cafe,-2.50,0,EUR,PENDING,\nTOPUP,Current,2026-10-01 08:00:00,2026-10-01 08:00:00,Pago,100,0,EUR,COMPLETED,100")).unwrap();
        assert_eq!(upsert_movs(&mut c, &a.movs, "t1").unwrap(), (2, 0));
        let b = crate::revolut::parse(&format!("{h}CARD_PAYMENT,Current,2026-10-06 13:30:00,2026-10-07 09:00:00,Cafe,-2.50,0,EUR,COMPLETED,97.50")).unwrap();
        assert_eq!(upsert_movs(&mut c, &b.movs, "t2").unwrap(), (0, 1));
        let all = movs(&c).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].estado, "completado");
        assert_eq!(all[1].saldo, Some(97.5));
        set_categoria(&c, "cafe", "Restaurantes").unwrap();
        assert_eq!(categorias(&c).unwrap().get("cafe").map(String::as_str), Some("Restaurantes"));
    }

    #[test]
    fn recuerda_el_nombre_de_la_hucha() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = open(dir.path(), &new_key()).unwrap();
        let resumen = "\"Cuentas corrientes Estado de transacciones\",,,
\"Cuenta personal (EUR)\",,,
Fecha,Descripción,Categoría,\"Entradas/salidas de dinero\",Saldo
\"1 ene 2026\",Mercadona,Comercio,\"-5,00€\",\"10,00€\"
---------,,,
\"Cuentas de Ahorro Transaction Statements\",,,
\"Ahorros  (EUR)\",,,
Fecha,Descripción,TAE,TIN,\"Gross interest\",\"Impuestos retenidos\",\"Other taxes\",Fees,\"Net interest\"
1/1/26,\"Interés neto pagado a Cuenta con mejora activada del 1 ene 2026\",1%,1%,\"1,35€\",\"0,25€\",\"0,00€\",\"0,00€\",\"1,10€\"";
        let p = crate::revolut::parse(resumen).unwrap();
        upsert_movs(&mut c, &p.movs, "t").unwrap();
        assert_eq!(nombres_hucha(&c).unwrap(), vec!["Cuenta con mejora activada".to_string()]);
    }

    #[test]
    fn sin_clave_no_se_lee() {
        let dir = tempfile::tempdir().unwrap();
        drop(open(dir.path(), &new_key()).unwrap());
        let plain = Connection::open(dir.path().join("life.db")).unwrap();
        assert!(plain.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).is_err());
    }

    #[test]
    fn cifra_una_base_en_claro() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("life.db");
        {
            let c = Connection::open(&file).unwrap();
            c.pragma_update(None, "journal_mode", "WAL").unwrap();
            c.execute_batch(MIGRATIONS[0]).unwrap();
            c.pragma_update(None, "user_version", 1).unwrap();
            save_snapshot(&c, "github", "viejo", "ayer").unwrap();
        }
        assert_eq!(header(&file), PLAIN_HEADER);

        let key = new_key();
        let c = open(dir.path(), &key).unwrap();
        assert_eq!(snapshot(&c, "github").unwrap().as_deref(), Some("viejo"));
        drop(c);
        assert_ne!(header(&file), PLAIN_HEADER);
    }

    #[test]
    fn clave_erronea_aparta_el_archivo() {
        let dir = tempfile::tempdir().unwrap();
        {
            let c = open(dir.path(), &new_key()).unwrap();
            save_snapshot(&c, "github", "x", "hoy").unwrap();
        }
        let c = open(dir.path(), &new_key()).unwrap();
        assert_eq!(snapshot(&c, "github").unwrap(), None);
        let aside = std::fs::read_dir(dir.path()).unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("life.db.ilegible-"));
        assert!(aside);
    }
}
