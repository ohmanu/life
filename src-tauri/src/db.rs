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
    // 10 · categorías que propone Claude para comercios que las reglas no reconocen
    "
    CREATE TABLE categorias_ia (
        comercio  TEXT PRIMARY KEY,
        categoria TEXT NOT NULL,
        creado    TEXT NOT NULL
    );
    ",
    // 11 · tokens de Claude por día, modelo y proyecto (registros locales de Claude Code y llamadas de LIFE)
    "
    CREATE TABLE tokens_dia (
        fecha TEXT NOT NULL, modelo TEXT NOT NULL, proyecto TEXT NOT NULL,
        entrada INTEGER NOT NULL DEFAULT 0, salida INTEGER NOT NULL DEFAULT 0,
        cache_creacion INTEGER NOT NULL DEFAULT 0, cache_lectura INTEGER NOT NULL DEFAULT 0,
        mensajes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (fecha, modelo, proyecto)
    );
    CREATE TABLE tokens_archivos (ruta TEXT PRIMARY KEY, offset INTEGER NOT NULL);
    CREATE TABLE tokens_vistos (id TEXT PRIMARY KEY);
    ",
    // 12 · volver a leer el banco entero: las nóminas de Sabadell (tipo «nomina») en todo el histórico
    "
    DELETE FROM ajustes WHERE clave = 'banco_desde';
    ",
    // 13 · nóminas antiguas deducidas por quien las envía (ver deducir_nominas)
    "
    UPDATE transacciones SET tipo = 'nomina', concepto = 'Desde Sabadell'
     WHERE fuente = 'banco' AND importe > 0 AND interno = 0 AND tipo IN ('otro', 'transferencia', 'recarga')
       AND descripcion IN (SELECT DISTINCT descripcion FROM transacciones WHERE tipo = 'nomina' AND concepto = 'Desde Sabadell');
    ",
];

pub fn categorias_ia(conn: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    let mut st = conn.prepare("SELECT comercio, categoria FROM categorias_ia")?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

pub fn guardar_categorias_ia(conn: &Connection, m: &HashMap<String, String>, cuando: &str) -> rusqlite::Result<()> {
    for (k, v) in m {
        conn.execute(
            "INSERT INTO categorias_ia (comercio, categoria, creado) VALUES (?1, ?2, ?3)
             ON CONFLICT(comercio) DO UPDATE SET categoria = excluded.categoria, creado = excluded.creado",
            params![k, v, cuando],
        )?;
    }
    Ok(())
}

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

    // Una base bloqueada por otro proceso (otra LIFE, una prueba…) NO es una clave errónea:
    // se reintenta y, si sigue sin abrirse, se devuelve el error sin tocar el archivo.
    let mut intento = 0;
    let abierta = loop {
        match open_keyed(&path, key) {
            Err(e) if !es_clave_erronea(&e) && intento < 4 => {
                intento += 1;
                log::warn!("life.db ocupada ({e}); reintento {intento}");
                std::thread::sleep(std::time::Duration::from_millis(750));
            }
            r => break r,
        }
    };
    let conn = match abierta {
        Ok(c) => c,
        // Solo con «file is not a database» (la clave guardada no es la de este archivo) se aparta.
        Err(e) if path.exists() && es_clave_erronea(&e) => {
            let aside = dir.join(format!("life.db.ilegible-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
            log::warn!("life.db no se abre con la clave guardada ({e}); se aparta en {}", aside.display());
            mover_sidecars(&path, &aside);
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
    // Si otro proceso la tiene ocupada, esperar un poco en vez de fallar al momento.
    conn.busy_timeout(std::time::Duration::from_secs(3))?;
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

/// ¿Es el error de una clave que no corresponde al archivo (SQLITE_NOTADB)?
fn es_clave_erronea(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::NotADatabase)
}

/// Los archivos auxiliares viajan con la base apartada (nunca se borran: pueden tener datos).
fn mover_sidecars(path: &Path, aside: &Path) {
    for ext in ["-wal", "-shm"] {
        let s = std::path::PathBuf::from(format!("{}{ext}", path.display()));
        if s.exists() {
            let _ = std::fs::rename(&s, format!("{}{ext}", aside.display()));
        }
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
        let mut prev = tx.prepare("SELECT estado, completada, saldo, importe, descripcion, interno, concepto, tipo FROM transacciones WHERE id = ?1")?;
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
            type Previo = (String, Option<String>, Option<f64>, f64, String, i64, Option<String>, String);
            let old: Option<Previo> = prev
                .query_row([&m.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))
                .optional()?;
            match old {
                None => {
                    ins.execute(params![m.id, m.fecha, m.completada, m.tipo, m.producto, m.descripcion, m.comercio,
                                        m.importe, m.comision, m.divisa, m.estado, m.saldo, m.interno as i64, cuando, m.fuente, m.concepto])?;
                    nuevos += 1;
                }
                // Los intereses del mes en curso crecen de un resumen a otro: importe y fecha también se
                // actualizan. Descripción e «interno» también, por si LIFE aprende a leerlos mejor.
                Some((estado, completada, saldo, importe, descripcion, interno, concepto, tipo)) => {
                    if estado != m.estado || completada != m.completada || (m.saldo.is_some() && saldo != m.saldo)
                        || (importe - m.importe).abs() > 0.004 || descripcion != m.descripcion || (interno != 0) != m.interno || concepto != m.concepto || tipo != m.tipo
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
/// Los movimientos antiguos llegan sin IBAN de origen: los ingresos de quien envía las nóminas
/// de Sabadell (misma descripción, que no sean devoluciones) también son nómina.
pub fn deducir_nominas(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE transacciones SET tipo = 'nomina', concepto = 'Desde Sabadell'
         WHERE fuente = 'banco' AND importe > 0 AND interno = 0 AND tipo IN ('otro', 'transferencia', 'recarga')
           AND descripcion IN (SELECT DISTINCT descripcion FROM transacciones WHERE tipo = 'nomina' AND concepto = 'Desde Sabadell')",
        [],
    )
}

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
    fn deduce_las_nominas_antiguas_por_quien_las_envia() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = open(dir.path(), &new_key()).unwrap();
        let mut nueva = mov("n1", "2026-10-30 00:00:00", "YO MISMO", 1500.0, "completado", None, "banco", "cuenta");
        nueva.tipo = "nomina".into();
        nueva.concepto = Some("Desde Sabadell".into());
        let mut vieja = mov("n2", "2026-06-30 00:00:00", "YO MISMO", 1500.0, "completado", None, "banco", "cuenta");
        vieja.tipo = "otro".into();
        let mut devolucion = mov("r1", "2026-06-12 00:00:00", "YO MISMO", 49.9, "completado", None, "banco", "cuenta");
        devolucion.tipo = "reembolso".into();
        upsert_movs(&mut c, &[nueva, vieja, devolucion], "t").unwrap();
        assert_eq!(deducir_nominas(&c).unwrap(), 1);
        let tipos: Vec<_> = movs(&c).unwrap().into_iter().map(|m| (m.id, m.tipo)).collect();
        assert!(tipos.contains(&("n2".into(), "nomina".into())));
        assert!(tipos.contains(&("r1".into(), "reembolso".into())));
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
    fn ocupada_no_es_clave_erronea() {
        let ocupada = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY), None);
        let bloqueada = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_LOCKED), None);
        let mala = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB), None);
        assert!(!es_clave_erronea(&ocupada));
        assert!(!es_clave_erronea(&bloqueada));
        assert!(es_clave_erronea(&mala));
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
        let q = |sql: &str| -> String { c.query_row(sql, [], |r| r.get::<_, Option<String>>(0)).ok().flatten().unwrap_or_else(|| "—".into()) };
        println!("nominas={} con_concepto={} cat_ia={} banco_sync={} banco_desde={} banco_error={}",
            q("SELECT CAST(count(*) AS TEXT) FROM transacciones WHERE tipo = 'nomina'"),
            q("SELECT CAST(count(*) AS TEXT) FROM transacciones WHERE concepto IS NOT NULL"),
            q("SELECT CAST(count(*) AS TEXT) FROM categorias_ia"),
            q("SELECT valor FROM ajustes WHERE clave = 'banco_sincronizado'"),
            q("SELECT valor FROM ajustes WHERE clave = 'banco_desde'"),
            q("SELECT valor FROM ajustes WHERE clave = 'banco_error'"));
        let mut st = c.prepare("SELECT fecha, importe, descripcion, coalesce(concepto, ''), tipo FROM transacciones WHERE fuente = 'banco' AND importe > 900 ORDER BY fecha DESC LIMIT 8").unwrap();
        for r in st.query_map([], |r| Ok(format!("  {} {:>9.2} {} «{}» {}", r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))).unwrap() { println!("{}", r.unwrap()); }
        let mut st = c.prepare("SELECT categoria, count(*) FROM categorias_ia GROUP BY 1 ORDER BY 2 DESC").unwrap();
        for r in st.query_map([], |r| Ok(format!("  ia {} {}", r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).unwrap() { println!("{}", r.unwrap()); }
        let mut st = c.prepare("SELECT comercio, count(*), round(min(-importe),2), round(max(-importe),2), min(substr(fecha,1,10)), max(substr(fecha,1,10)), max(descripcion), max(coalesce(concepto,'')) FROM transacciones WHERE importe < 0 AND fecha >= '2025-11-01' AND (lower(descripcion || ' ' || coalesce(concepto,'')) GLOB '*[nN]etflix*' OR lower(descripcion || ' ' || coalesce(concepto,'')) LIKE '%spotify%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%apple%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%google%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%youtube%' OR lower(descripcion || ' ' || coalesce(concepto,'')) LIKE '%yt %' OR lower(descripcion || coalesce(concepto,'')) LIKE '%premium%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%adobe%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%claude%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%anthropic%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%openai%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%disney%' OR lower(descripcion) = 'max' OR lower(descripcion || coalesce(concepto,'')) LIKE '%prime%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%digi%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%gym%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%suscrip%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%hbo%' OR lower(descripcion || coalesce(concepto,'')) LIKE '%github%' OR comercio IN (SELECT comercio FROM categorias_ia WHERE categoria = 'Suscripciones')) GROUP BY comercio ORDER BY 2 DESC").unwrap();
        for r in st.query_map([], |r| Ok(format!("  sub {:<34} n={:<3} {:>7}-{:<7} {}..{} {} «{}»", r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, f64>(2)?, r.get::<_, f64>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, String>(7)?))).unwrap() { println!("{}", r.unwrap()); }
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        println!("version {v}");
    }
}

#[cfg(test)]
mod rescate {
    /// Abre copias de archivos de base (sin migrar ni apartar nada) y cuenta lo que tienen:
    /// `LIFE_DB_PRUEBA="ruta1;ruta2" cargo test inspeccionar_copias -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn inspeccionar_copias() {
        let key = crate::secrets::get("db_key").unwrap().expect("db_key");
        for ruta in std::env::var("LIFE_DB_PRUEBA").unwrap().split(';') {
            let tmp = tempfile::tempdir().unwrap();
            let dst = tmp.path().join("life.db");
            std::fs::copy(ruta, &dst).unwrap();
            for ext in ["-wal", "-shm"] {
                let s = format!("{ruta}{ext}");
                if std::path::Path::new(&s).exists() { std::fs::copy(&s, tmp.path().join(format!("life.db{ext}"))).unwrap(); }
            }
            match super::open_keyed(&dst, &key) {
                Err(e) => println!("{ruta}: NO SE ABRE ({e})"),
                Ok(c) => {
                    let n = |t: &str| c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).map(|x| x.to_string()).unwrap_or_else(|_| "—".into());
                    let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap_or(-1);
                    let a = |k: &str| super::ajuste(&c, k).ok().flatten().unwrap_or_else(|| "—".into());
                    println!("{ruta}: version={v} movs={} ajustes={} radar={} categorias={} partes={} tokens_dia={} cat_ia={} hucha={} oro={} banco_sync={}",
                        n("transacciones"), n("ajustes"), n("radar"), n("categorias"), n("partes"), n("tokens_dia"), n("categorias_ia"), a("hucha_saldo"), a("oro_onzas"), a("banco_sincronizado"));
                }
            }
        }
    }
}
