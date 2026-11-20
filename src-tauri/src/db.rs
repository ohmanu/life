//! Base de datos local: un archivo SQLite (`life.db`) en la carpeta de datos de la app
//! (%APPDATA%\com.glutamato.life), cifrado con AES-256 (formato SQLCipher 4). La clave vive
//! en el Administrador de credenciales de Windows. Nada sale del ordenador.

use rusqlite::{Connection, OptionalExtension, params};
use crate::gmail::{Encargo, Pendiente};
use std::collections::HashSet;
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
