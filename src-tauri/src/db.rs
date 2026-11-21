//! Base de datos local: un archivo SQLite (`life.db`) en la carpeta de datos de la app
//! (%APPDATA%\com.glutamato.life), cifrado con AES-256 (formato SQLCipher 4). La clave vive
//! en el Administrador de credenciales de Windows. Nada sale del ordenador.

use rusqlite::{Connection, OptionalExtension, params};
use crate::gmail::{Encargo, Pendiente};
use crate::movimiento::Mov;
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
    // 5 · volver a leer todo el histórico del banco una vez (descripciones de traspasos mejoradas)
    "
    DELETE FROM ajustes WHERE clave = 'banco_desde';
    ",
    // 6 · traspasos con la hucha («Cuenta con mejora activada») internos; tu nombre ya no lo es.
    //     La siguiente sincronización vuelve a leer todo el histórico con las reglas nuevas.
    "
    UPDATE transacciones SET interno = 1
     WHERE fuente = 'banco' AND (lower(descripcion) LIKE '%cuenta con mejora%' OR lower(descripcion) LIKE '%cuenta remunerada%');
    UPDATE transacciones SET interno = 0
     WHERE fuente = 'banco' AND interno = 1 AND tipo <> 'cambio'
       AND lower(descripcion) NOT LIKE '%cuenta con mejora%' AND lower(descripcion) NOT LIKE '%cuenta remunerada%'
       AND lower(descripcion) NOT LIKE '%savings%' AND lower(descripcion) NOT LIKE '%pocket%'
       AND lower(descripcion) NOT LIKE '%vault%' AND lower(descripcion) NOT LIKE '%hucha%'
       AND lower(descripcion) NOT LIKE '%ahorros%';
    DELETE FROM ajustes WHERE clave = 'banco_desde';
    ",
    // 7 · radar de vida: una fila por semana (ISO, «2026-W47») con la nota de cada eje
    "
    CREATE TABLE radar (
        semana   TEXT PRIMARY KEY,
        valores  TEXT NOT NULL,         -- JSON {eje: 0..10}
        nota     TEXT NOT NULL DEFAULT '',
        guardado TEXT NOT NULL
    );
    ",
    // 8 · partes del día y de la semana escritos por Claude
    "
    CREATE TABLE partes (
        fecha    TEXT NOT NULL,         -- AAAA-MM-DD
        tipo     TEXT NOT NULL,         -- diario | semanal
        texto    TEXT NOT NULL,
        generado TEXT NOT NULL,
        PRIMARY KEY (fecha, tipo)
    );
    ",
    // 9 · concepto de Bizum y transferencias; se vuelve a leer el banco para rellenarlo
    "
    ALTER TABLE transacciones ADD COLUMN concepto TEXT;
    DELETE FROM ajustes WHERE clave IN ('banco_desde', 'revolut_importado', 'revolut_archivo');
    ",
];

#[derive(serde::Serialize, Clone, Debug)]
pub struct Parte {
    pub fecha: String,
    pub tipo: String,
    pub texto: String,
    pub generado: String,
}

pub fn guardar_parte(conn: &Connection, p: &Parte) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO partes (fecha, tipo, texto, generado) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(fecha, tipo) DO UPDATE SET texto = excluded.texto, generado = excluded.generado",
        params![p.fecha, p.tipo, p.texto, p.generado],
    )?;
    Ok(())
}

/// El último parte de cada tipo.
pub fn ultimo_parte(conn: &Connection, tipo: &str) -> rusqlite::Result<Option<Parte>> {
    conn.query_row(
        "SELECT fecha, tipo, texto, generado FROM partes WHERE tipo = ?1 ORDER BY fecha DESC LIMIT 1",
        [tipo],
        |r| Ok(Parte { fecha: r.get(0)?, tipo: r.get(1)?, texto: r.get(2)?, generado: r.get(3)? }),
    )
    .optional()
}

// ── Radar de vida ─────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Semana {
    pub semana: String,
    pub valores: HashMap<String, u8>,
    pub nota: String,
    pub guardado: String,
}

pub fn radar(conn: &Connection) -> rusqlite::Result<Vec<Semana>> {
    let mut st = conn.prepare("SELECT semana, valores, nota, guardado FROM radar ORDER BY semana")?;
    let rows = st.query_map([], |r| {
        let json: String = r.get(1)?;
        Ok(Semana { semana: r.get(0)?, valores: serde_json::from_str(&json).unwrap_or_default(), nota: r.get(2)?, guardado: r.get(3)? })
    })?;
    rows.collect()
}

pub fn guardar_semana(conn: &Connection, s: &Semana) -> rusqlite::Result<()> {
    let json = serde_json::to_string(&s.valores).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO radar (semana, valores, nota, guardado) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(semana) DO UPDATE SET valores = excluded.valores, nota = excluded.nota, guardado = excluded.guardado",
        params![s.semana, json, s.nota, s.guardado],
    )?;
    Ok(())
}

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
        let mut prev = tx.prepare("SELECT estado, completada, saldo, importe, descripcion, interno, concepto FROM transacciones WHERE id = ?1")?;
        let mut ins = tx.prepare(
            "INSERT INTO transacciones (id, fecha, completada, tipo, producto, descripcion, comercio, importe,
                                        comision, divisa, estado, saldo, interno, importado, fuente, concepto)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        )?;
        let mut upd = tx.prepare(
            "UPDATE transacciones SET estado = ?2, completada = ?3, saldo = ?4, comision = ?5, importe = ?6, fecha = ?7,
                    descripcion = ?8, comercio = ?9, tipo = ?10, interno = ?11, concepto = ?12
             WHERE id = ?1",
        )?;
        for m in movs {
            type Previo = (String, Option<String>, Option<f64>, f64, String, i64, Option<String>);
            let old: Option<Previo> = prev
                .query_row([&m.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
                .optional()?;
            match old {
                None => {
                    ins.execute(params![m.id, m.fecha, m.completada, m.tipo, m.producto, m.descripcion, m.comercio,
                                        m.importe, m.comision, m.divisa, m.estado, m.saldo, m.interno as i64, cuando, m.fuente, m.concepto])?;
                    nuevos += 1;
                }
                // Los intereses del mes en curso crecen de un resumen a otro: importe y fecha también se
                // actualizan. Descripción e «interno» también, por si LIFE aprende a leerlos mejor.
                Some((estado, completada, saldo, importe, descripcion, interno, concepto)) => {
                    if estado != m.estado || completada != m.completada || (m.saldo.is_some() && saldo != m.saldo)
                        || (importe - m.importe).abs() > 0.004 || descripcion != m.descripcion || (interno != 0) != m.interno || concepto != m.concepto
                    {
                        upd.execute(params![m.id, m.estado, m.completada, m.saldo.or(saldo), m.comision, m.importe, m.fecha,
                                            m.descripcion, m.comercio, m.tipo, m.interno as i64, m.concepto])?;
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
                estado, saldo, interno, fuente, concepto
         FROM transacciones ORDER BY fecha, rowid",
    )?;
    let rows = st.query_map([], |r| {
        Ok(Mov {
            id: r.get(0)?, fecha: r.get(1)?, completada: r.get(2)?, tipo: r.get(3)?, producto: r.get(4)?,
            descripcion: r.get(5)?, comercio: r.get(6)?, importe: r.get(7)?, comision: r.get(8)?,
            divisa: r.get(9)?, estado: r.get(10)?, saldo: r.get(11)?, interno: r.get::<_, i64>(12)? != 0, fuente: r.get(13)?, concepto: r.get(14)?,
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

/// Lo del banco manda: los movimientos de CSV de un producto desde la primera fecha que da el
/// banco para ese producto se retiran (lo anterior se queda: el banco no llega tan atrás).
pub fn retirar_csv_solapado(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM transacciones WHERE fuente = 'csv' AND fecha >= (
             SELECT MIN(b.fecha) FROM transacciones b WHERE b.fuente = 'banco' AND b.producto = transacciones.producto)",
        [],
    )
}

/// Nombres de tus huchas («Cuenta con mejora activada»), sacados de los intereses importados por CSV.
pub fn nombres_hucha(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare(
        "SELECT DISTINCT substr(descripcion, 14) FROM transacciones
         WHERE producto = 'ahorro' AND descripcion LIKE 'Intereses de %'",
    )?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    let mut out: Vec<String> = rows.filter_map(Result::ok).filter(|n| n.trim().len() >= 4 && n != "hucha").collect();
    if let Some(n) = ajuste(conn, "hucha_nombre")? {
        if !out.contains(&n) {
            out.push(n);
        }
    }
    Ok(out)
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

    fn mov(id: &str, fecha: &str, desc: &str, importe: f64, estado: &str, saldo: Option<f64>, fuente: &str, producto: &str) -> Mov {
        Mov {
            id: id.into(), fecha: fecha.into(), completada: None, tipo: "tarjeta".into(), producto: producto.into(),
            descripcion: desc.into(), concepto: None, comercio: crate::movimiento::comercio(desc), importe, comision: 0.0,
            divisa: "EUR".into(), estado: estado.into(), saldo, interno: false, fuente: fuente.into(),
        }
    }

    #[test]
    fn volver_a_leer_no_duplica_y_completa_pendientes() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = open(dir.path(), &new_key()).unwrap();
        let a = [
            mov("m1", "2026-10-06 13:30:00", "Cafe", -2.5, "pendiente", None, "banco", "cuenta"),
            mov("m2", "2026-10-01 08:00:00", "Pago", 100.0, "completado", Some(100.0), "banco", "cuenta"),
        ];
        assert_eq!(upsert_movs(&mut c, &a, "t1").unwrap(), (2, 0));
        let mut b = a[0].clone();
        b.estado = "completado".into();
        b.saldo = Some(97.5);
        b.concepto = Some("Desayuno".into());
        assert_eq!(upsert_movs(&mut c, &[b], "t2").unwrap(), (0, 1));
        let all = movs(&c).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].estado, "completado");
        assert_eq!(all[1].saldo, Some(97.5));
        assert_eq!(all[1].concepto.as_deref(), Some("Desayuno"));
        set_categoria(&c, "cafe", "Restaurantes").unwrap();
        assert_eq!(categorias(&c).unwrap().get("cafe").map(String::as_str), Some("Restaurantes"));
    }

    #[test]
    fn el_banco_manda_sobre_lo_importado_antes() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = open(dir.path(), &new_key()).unwrap();
        let viejos = [
            mov("c1", "2026-10-01 10:00:00", "Viejo", -1.0, "completado", None, "csv", "cuenta"),
            mov("c2", "2026-11-10 10:00:00", "Solapado", -2.0, "completado", None, "csv", "cuenta"),
        ];
        upsert_movs(&mut c, &viejos, "t").unwrap();
        upsert_movs(&mut c, &[mov("b1", "2026-11-01 00:00:00", "Nuevo", -2.0, "completado", None, "banco", "cuenta")], "t").unwrap();
        assert_eq!(retirar_csv_solapado(&c).unwrap(), 1);
        let quedan: Vec<_> = movs(&c).unwrap().into_iter().map(|m| m.descripcion).collect();
        assert_eq!(quedan, vec!["Viejo", "Nuevo"]);
    }

    #[test]
    fn guarda_y_corrige_la_semana_del_radar() {
        let dir = tempfile::tempdir().unwrap();
        let c = open(dir.path(), &new_key()).unwrap();
        let mut s = Semana {
            semana: "2026-W47".into(),
            valores: [("trabajo".to_string(), 8u8), ("descanso".to_string(), 3)].into_iter().collect(),
            nota: "Semana de bodas".into(),
            guardado: "t".into(),
        };
        guardar_semana(&c, &s).unwrap();
        s.valores.insert("descanso".into(), 5);
        guardar_semana(&c, &s).unwrap();
        let r = radar(&c).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].valores["descanso"], 5);
        assert_eq!(r[0].nota, "Semana de bodas");
    }

    #[test]
    fn recuerda_el_nombre_de_la_hucha() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = open(dir.path(), &new_key()).unwrap();
        let mut i = mov("i1", "2026-01-02 00:00:00", "Intereses de Cuenta con mejora activada", 2.2, "completado", None, "csv", "ahorro");
        i.tipo = "intereses".into();
        upsert_movs(&mut c, &[i], "t").unwrap();
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

/// Diagnóstico local de la base real: `cargo test diagnostico_real -- --ignored --nocapture`.
#[cfg(test)]
mod diagnostico {
    #[test]
    #[ignore]
    fn diagnostico_real() {
        let key = crate::secrets::get("db_key").unwrap().expect("db_key");
        let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.glutamato.life");
        let c = super::open(&dir, &key).unwrap();
        let mut st = c
            .prepare(
                "SELECT fuente, producto, count(*), min(fecha), max(fecha), sum(interno) FROM transacciones GROUP BY fuente, producto",
            )
            .unwrap();
        let rows = st
            .query_map([], |r| Ok(format!("{} {} n={} {}..{} internos={}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, i64>(5)?)))
            .unwrap();
        for r in rows {
            println!("{}", r.unwrap());
        }
        let mut st = c
            .prepare(
                "SELECT substr(fecha, 1, 7), round(sum(CASE WHEN importe > 0 AND interno = 0 THEN importe END)),
                        round(sum(CASE WHEN importe < 0 AND interno = 0 THEN -importe END)),
                        round(sum(CASE WHEN interno = 1 THEN importe END)), sum(interno)
                 FROM transacciones WHERE fecha >= '2025-12' GROUP BY 1 ORDER BY 1",
            )
            .unwrap();
        let rows = st
            .query_map([], |r| Ok(format!("{} entra {:>8} sale {:>8} internos neto {:>8} n={}", r.get::<_, String>(0)?, r.get::<_, Option<f64>>(1)?.unwrap_or(0.0), r.get::<_, Option<f64>>(2)?.unwrap_or(0.0), r.get::<_, Option<f64>>(3)?.unwrap_or(0.0), r.get::<_, i64>(4)?)))
            .unwrap();
        for r in rows {
            println!("{}", r.unwrap());
        }
        if let Ok(Some(j)) = super::snapshot(&c, "instagram") {
            let s: crate::instagram::Snapshot = serde_json::from_str(&j).unwrap();
            let con = |f: fn(&crate::instagram::Post) -> Option<i64>| s.posts.iter().filter(|p| f(p).is_some()).count();
            println!(
                "ig seguidores={} posts={} con_alcance={} con_vistas={} con_guardados={} serie_alcance={} reach30={:?} views30={:?} engaged30={:?} inter30={:?} horas={}",
                s.followers, s.posts.len(), con(|p| p.reach), con(|p| p.views), con(|p| p.saved), s.reach.len(),
                s.reach_30, s.views_30, s.engaged_30, s.interactions_30, s.online.len()
            );
            println!("tipos {:?}", s.posts.iter().map(|p| p.product.as_str()).collect::<std::collections::BTreeSet<_>>());
        }
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        println!("version {v}");
    }
}
