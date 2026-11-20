mod banco;
mod db;
mod github;
mod gmail;
mod instagram;
mod revolut;
mod secrets;

use db::Db;
use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// Gmail cada 10 minutos; GitHub cada 6 vueltas (una hora).
const TICK: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const GITHUB_EVERY: u32 = 6;

#[derive(Serialize)]
struct SourceStatus<T> {
    connected: bool,
    snapshot: Option<T>,
}

/// Clave de cifrado de `life.db`: se crea la primera vez y se guarda en el
/// Administrador de credenciales de Windows. Nunca toca el disco ni la interfaz.
fn db_key() -> Result<String, String> {
    const NAME: &str = "db_key";
    if let Some(k) = secrets::get(NAME)? {
        return Ok(k);
    }
    let k = db::new_key();
    secrets::set(NAME, &k)?;
    Ok(k)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Descarga, guarda y avisa a la interfaz. No retiene la base de datos mientras espera a la red.
async fn sync_github(app: &AppHandle) -> Result<github::Snapshot, String> {
    let token = secrets::get(github::TOKEN)?.ok_or("GitHub no está conectado.")?;
    let result = github::fetch(&token).await;
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    match result {
        Ok(snap) => {
            let json = serde_json::to_string(&snap).map_err(|e| e.to_string())?;
            db::save_snapshot(&conn, "github", &json, &snap.synced_at).map_err(|e| e.to_string())?;
            for d in &snap.days {
                let _ = conn.execute(
                    "INSERT INTO metricas_diarias (fuente, clave, fecha, valor) VALUES ('github', 'contribuciones', ?1, ?2)
                     ON CONFLICT(fuente, clave, fecha) DO UPDATE SET valor = excluded.valor",
                    rusqlite::params![d.date, d.count],
                );
            }
            db::log_sync(&conn, "github", true, None);
            drop(conn);
            let _ = app.emit("github-updated", &snap);
            Ok(snap)
        }
        Err(e) => {
            db::log_sync(&conn, "github", false, Some(&e));
            Err(e)
        }
    }
}

#[tauri::command]
fn github_status(app: AppHandle) -> Result<SourceStatus<github::Snapshot>, String> {
    let connected = secrets::get(github::TOKEN)?.is_some();
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let snapshot = db::snapshot(&conn, "github")
        .map_err(|e| e.to_string())?
        .and_then(|j| serde_json::from_str(&j).ok());
    Ok(SourceStatus { connected, snapshot })
}

/// Comprueba el token contra GitHub antes de guardarlo.
#[tauri::command]
async fn github_connect(app: AppHandle, token: String) -> Result<github::Snapshot, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Pega el token de GitHub.".into());
    }
    github::fetch(&token).await?;
    secrets::set(github::TOKEN, &token)?;
    sync_github(&app).await
}

#[tauri::command]
async fn github_sync(app: AppHandle) -> Result<github::Snapshot, String> {
    sync_github(&app).await
}

#[tauri::command]
fn github_disconnect(app: AppHandle) -> Result<(), String> {
    secrets::delete(github::TOKEN)?;
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::delete_snapshot(&conn, "github").map_err(|e| e.to_string())
}

// ── Instagram ─────────────────────────────────────────────────────────────

/// Seguidores por día que LIFE ha ido guardando (Meta solo da el número de hoy).
fn ig_historia(conn: &rusqlite::Connection) -> Vec<instagram::Dia> {
    let Ok(mut st) = conn.prepare(
        "SELECT fecha, valor FROM metricas_diarias WHERE fuente = 'instagram' AND clave = 'seguidores' ORDER BY fecha",
    ) else {
        return Vec::new();
    };
    st.query_map([], |r| Ok(instagram::Dia { fecha: r.get(0)?, valor: r.get::<_, f64>(1)? as i64 }))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// Renueva el token cada 7 días (dura 60) y descarga perfil, publicaciones y estadísticas.
async fn sync_instagram(app: &AppHandle) -> Result<instagram::Snapshot, String> {
    let mut token = secrets::get(instagram::TOKEN)?.ok_or("Instagram no está conectado.")?;
    let renovar = {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::ajuste(&conn, "ig_renovado")
            .map_err(|e| e.to_string())?
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            .is_none_or(|t| chrono::Utc::now() - t.with_timezone(&chrono::Utc) > chrono::Duration::days(7))
    };
    if renovar {
        match instagram::renovar(&token).await {
            Ok(nuevo) => {
                secrets::set(instagram::TOKEN, &nuevo)?;
                token = nuevo;
                let state = app.state::<Db>();
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                db::set_ajuste(&conn, "ig_renovado", &gmail::utc(chrono::Utc::now())).map_err(|e| e.to_string())?;
            }
            // Un token recién creado (menos de 24 h) aún no se puede renovar: se intenta otro día.
            Err(e) => log::info!("instagram: sin renovar el token ({e})"),
        }
    }
    let result = instagram::fetch(&token).await;
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    match result {
        Ok(mut snap) => {
            let hoy = chrono::Local::now().format("%Y-%m-%d").to_string();
            let _ = conn.execute(
                "INSERT INTO metricas_diarias (fuente, clave, fecha, valor) VALUES ('instagram', 'seguidores', ?1, ?2)
                 ON CONFLICT(fuente, clave, fecha) DO UPDATE SET valor = excluded.valor",
                rusqlite::params![hoy, snap.followers],
            );
            snap.historia = ig_historia(&conn);
            let json = serde_json::to_string(&snap).map_err(|e| e.to_string())?;
            db::save_snapshot(&conn, "instagram", &json, &snap.synced_at).map_err(|e| e.to_string())?;
            db::log_sync(&conn, "instagram", true, None);
            drop(conn);
            let _ = app.emit("instagram-updated", &snap);
            Ok(snap)
        }
        Err(e) => {
            db::log_sync(&conn, "instagram", false, Some(&e));
            Err(e)
        }
    }
}

#[tauri::command]
fn instagram_status(app: AppHandle) -> Result<SourceStatus<instagram::Snapshot>, String> {
    let connected = secrets::get(instagram::TOKEN)?.is_some();
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let snapshot = db::snapshot(&conn, "instagram")
        .map_err(|e| e.to_string())?
        .and_then(|j| serde_json::from_str::<instagram::Snapshot>(&j).ok())
        .map(|mut s| {
            s.historia = ig_historia(&conn);
            s
        });
    Ok(SourceStatus { connected, snapshot })
}

/// Comprueba el token contra Instagram antes de guardarlo.
#[tauri::command]
async fn instagram_connect(app: AppHandle, token: String) -> Result<instagram::Snapshot, String> {
    let token: String = token.split_whitespace().collect();
    if token.len() < 20 {
        return Err("Pega el token de Instagram.".into());
    }
    instagram::fetch(&token).await?;
    secrets::set(instagram::TOKEN, &token)?;
    {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        // Recién generado: se renovará dentro de una semana.
        db::set_ajuste(&conn, "ig_renovado", &gmail::utc(chrono::Utc::now())).map_err(|e| e.to_string())?;
    }
    sync_instagram(&app).await
}

#[tauri::command]
async fn instagram_sync(app: AppHandle) -> Result<instagram::Snapshot, String> {
    sync_instagram(&app).await
}

/// Abre una publicación en el navegador. Solo enlaces de instagram.com.
#[tauri::command]
fn instagram_abrir(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let u: tauri::Url = url.parse().map_err(|_| "Enlace no válido.".to_string())?;
    if u.scheme() != "https" || !matches!(u.host_str(), Some("www.instagram.com" | "instagram.com")) {
        return Err("Solo se abren enlaces de instagram.com.".into());
    }
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string())
}

/// Borra el token. El historial de seguidores se queda en life.db.
#[tauri::command]
fn instagram_disconnect(app: AppHandle) -> Result<(), String> {
    secrets::delete(instagram::TOKEN)?;
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let _ = conn.execute("DELETE FROM ajustes WHERE clave = 'ig_renovado'", []);
    db::delete_snapshot(&conn, "instagram").map_err(|e| e.to_string())
}

// ── Gmail · encargos ──────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct GmailView {
    connected: bool,
    user: Option<String>,
    synced_at: Option<String>,
    encargos: Vec<gmail::Encargo>,
}

fn gmail_view(app: &AppHandle) -> Result<GmailView, String> {
    let user = secrets::get(gmail::USER)?;
    let connected = user.is_some() && secrets::get(gmail::PASS)?.is_some();
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let synced_at = db::snapshot(&conn, "gmail").map_err(|e| e.to_string())?;
    let encargos = db::encargos(&conn).map_err(|e| e.to_string())?;
    Ok(GmailView { connected, user, synced_at, encargos })
}

/// Encargos sin responder → aviso en el texto del icono de la bandeja.
fn update_tray(app: &AppHandle, view: &GmailView) {
    let sin = view.encargos.iter().filter(|e| e.respondido.is_none() && e.estado == "nuevo").count();
    let tip = match sin {
        0 => "LIFE".to_string(),
        1 => "LIFE · 1 encargo sin responder".to_string(),
        n => format!("LIFE · {n} encargos sin responder"),
    };
    if let Some(tray) = app.tray_by_id("life") {
        let _ = tray.set_tooltip(Some(tip));
    }
}

/// Lee Gmail (en un hilo aparte: IMAP es bloqueante), guarda y avisa a la interfaz.
async fn sync_gmail(app: &AppHandle) -> Result<GmailView, String> {
    let user = secrets::get(gmail::USER)?.ok_or("Gmail no está conectado.")?;
    let pass = secrets::get(gmail::PASS)?.ok_or("Gmail no está conectado.")?;

    let desde = gmail::utc(chrono::Utc::now() - chrono::Duration::days(180));
    let (validity, known, pendientes) = {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let validity: Option<u32> = db::ajuste(&conn, "gmail_uidvalidity")
            .map_err(|e| e.to_string())?
            .and_then(|v| v.parse().ok());
        let known = db::known_uids(&conn).map_err(|e| e.to_string())?;
        let pendientes = db::pendientes(&conn, &desde).map_err(|e| e.to_string())?;
        (validity, known, pendientes)
    };
    let first_run = validity.is_none();

    let result = tauri::async_runtime::spawn_blocking(move || {
        gmail::fetch(&user, &pass, validity, &known, &pendientes)
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut nuevos = Vec::new();
    {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        match result {
            Ok(f) => {
                for e in &f.nuevos {
                    if db::insert_encargo(&conn, e).map_err(|e| e.to_string())? {
                        nuevos.push(e.clone());
                    }
                }
                for (id, cuando) in &f.respuestas {
                    db::set_respondido(&conn, id, cuando).map_err(|e| e.to_string())?;
                }
                db::set_ajuste(&conn, "gmail_uidvalidity", &f.uidvalidity.to_string())
                    .map_err(|e| e.to_string())?;
                let now = gmail::utc(chrono::Utc::now());
                db::save_snapshot(&conn, "gmail", &now, &now).map_err(|e| e.to_string())?;
                db::log_sync(&conn, "gmail", true, Some(&format!("{} nuevos", nuevos.len())));
            }
            Err(e) => {
                db::log_sync(&conn, "gmail", false, Some(&e));
                return Err(e);
            }
        }
    }

    // Aviso de Windows por cada encargo nuevo (no en la primera lectura, que trae el histórico).
    if !first_run {
        use tauri_plugin_notification::NotificationExt;
        for e in &nuevos {
            let _ = app
                .notification()
                .builder()
                .title("Encargo nuevo")
                .body(format!("{} · {} · {}", e.tipo, e.que, e.nombre))
                .show();
        }
    }

    let view = gmail_view(app)?;
    avisar_48h(app, &view)?;
    update_tray(app, &view);
    let _ = app.emit("gmail-updated", &view);
    Ok(view)
}

/// Aviso de Windows cuando un encargo pasa de 48 h sin respuesta. Una sola vez por encargo y
/// solo para los de la última semana, para no avisar del histórico.
fn avisar_48h(app: &AppHandle, view: &GmailView) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let now = chrono::Utc::now();
    let limite = gmail::utc(now - chrono::Duration::hours(48));
    let semana = gmail::utc(now - chrono::Duration::days(7));
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    for e in view.encargos.iter().filter(|e| {
        e.estado == "nuevo" && e.respondido.is_none() && e.recibido < limite && e.recibido >= semana
    }) {
        let key = format!("aviso48:{}", e.id);
        if db::ajuste(&conn, &key).map_err(|e| e.to_string())?.is_some() {
            continue;
        }
        let _ = app
            .notification()
            .builder()
            .title("Encargo sin responder · 48 h")
            .body(format!("{} · {} · {}", e.tipo, e.que, e.nombre))
            .show();
        db::set_ajuste(&conn, &key, &gmail::utc(now)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn gmail_status(app: AppHandle) -> Result<GmailView, String> {
    let view = gmail_view(&app)?;
    update_tray(&app, &view);
    Ok(view)
}

/// Comprueba el correo y la contraseña de aplicación contra Gmail antes de guardarlos.
#[tauri::command]
async fn gmail_connect(app: AppHandle, user: String, password: String) -> Result<GmailView, String> {
    let user = user.trim().to_lowercase();
    // Google enseña la contraseña de aplicación en grupos de 4 con espacios.
    let pass: String = password.chars().filter(|c| !c.is_whitespace()).collect();
    if !user.contains('@') {
        return Err("Escribe tu dirección de Gmail.".into());
    }
    if pass.len() != 16 {
        return Err("La contraseña de aplicación tiene 16 letras.".into());
    }
    let (u, p) = (user.clone(), pass.clone());
    tauri::async_runtime::spawn_blocking(move || gmail::check(&u, &p))
        .await
        .map_err(|e| e.to_string())??;
    secrets::set(gmail::USER, &user)?;
    secrets::set(gmail::PASS, &pass)?;
    sync_gmail(&app).await
}

#[tauri::command]
async fn gmail_sync(app: AppHandle) -> Result<GmailView, String> {
    sync_gmail(&app).await
}

/// Borra las credenciales. Los encargos ya leídos se quedan en life.db.
#[tauri::command]
fn gmail_disconnect(app: AppHandle) -> Result<GmailView, String> {
    secrets::delete(gmail::USER)?;
    secrets::delete(gmail::PASS)?;
    {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::delete_snapshot(&conn, "gmail").map_err(|e| e.to_string())?;
    }
    gmail_view(&app)
}

/// Cambia el estado en LIFE. No escribe nada en Gmail.
#[tauri::command]
fn encargo_estado(app: AppHandle, id: String, estado: String) -> Result<GmailView, String> {
    if !gmail::ESTADOS.contains(&estado.as_str()) {
        return Err(format!("Estado desconocido: {estado}"));
    }
    {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let now = gmail::utc(chrono::Utc::now());
        if db::set_estado(&conn, &id, &estado, &now).map_err(|e| e.to_string())? == 0 {
            return Err("Ese encargo no existe.".into());
        }
    }
    let view = gmail_view(&app)?;
    update_tray(&app, &view);
    Ok(view)
}

fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Abre el correo del encargo en Gmail, en el navegador.
#[tauri::command]
fn encargo_abrir(app: AppHandle, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let user = secrets::get(gmail::USER)?.unwrap_or_default();
    let url = format!(
        "https://mail.google.com/mail/?authuser={}#search/rfc822msgid%3A{}",
        pct(&user),
        pct(&id)
    );
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ── Dinero · Revolut ──────────────────────────────────────────────────────

#[derive(Serialize)]
struct DineroView {
    movimientos: Vec<revolut::Mov>,
    /// Categorías que elegiste a mano, por comercio.
    categorias: std::collections::HashMap<String, String>,
    importado: Option<String>,
    archivo: Option<String>,
    banco: BancoView,
    patrimonio: Patrimonio,
}

/// Lo que Open Banking no da: el oro y los ajustes a mano de la hucha.
#[derive(Serialize, Default)]
struct Patrimonio {
    oro_onzas: Option<f64>,
    oro_coste: Option<f64>,
    /// Valor según el último resumen del ejercicio y su fecha.
    oro_valor_resumen: Option<f64>,
    oro_fecha: Option<String>,
    /// Precio de la onza en euros y cuándo se consultó.
    oro_precio: Option<f64>,
    oro_precio_fecha: Option<String>,
    /// Saldo de la hucha que pusiste a mano y cuándo.
    hucha_saldo: Option<f64>,
    hucha_fecha: Option<String>,
    /// TIN anual de la hucha en % (para estimar los intereses).
    hucha_tin: Option<f64>,
}

fn patrimonio(conn: &rusqlite::Connection) -> Patrimonio {
    let s = |k: &str| db::ajuste(conn, k).ok().flatten();
    let n = |k: &str| s(k).and_then(|v| v.parse::<f64>().ok());
    Patrimonio {
        oro_onzas: n("oro_onzas"),
        oro_coste: n("oro_coste"),
        oro_valor_resumen: n("oro_valor"),
        oro_fecha: s("oro_fecha"),
        oro_precio: n("oro_precio"),
        oro_precio_fecha: s("oro_precio_fecha"),
        hucha_saldo: n("hucha_saldo"),
        hucha_fecha: s("hucha_fecha"),
        hucha_tin: n("hucha_tin"),
    }
}

/// Precio de la onza de oro en euros (api.gold-api.com, sin clave; no se envía nada tuyo).
async fn precio_oro() -> Result<f64, String> {
    let v: serde_json::Value = reqwest::Client::builder()
        .user_agent("LIFE")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .get("https://api.gold-api.com/price/XAU/EUR")
        .send()
        .await
        .map_err(|e| format!("Sin conexión con el precio del oro: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Precio del oro ilegible: {e}"))?;
    match (v["currency"].as_str(), v["price"].as_f64()) {
        (Some("EUR"), Some(p)) if p > 0.0 => Ok(p),
        _ => Err("El servicio del precio del oro respondió algo inesperado.".into()),
    }
}

async fn actualizar_oro(app: &AppHandle) -> Result<(), String> {
    let p = precio_oro().await?;
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::set_ajuste(&conn, "oro_precio", &p.to_string()).map_err(|e| e.to_string())?;
    db::set_ajuste(&conn, "oro_precio_fecha", &gmail::utc(chrono::Utc::now())).map_err(|e| e.to_string())?;
    Ok(())
}

/// Ajuste a mano: onzas de oro (las que muestra Revolut) y saldo de la hucha hoy.
#[tauri::command]
async fn patrimonio_ajustar(app: AppHandle, oro_onzas: Option<f64>, hucha: Option<f64>, tin: Option<f64>) -> Result<DineroView, String> {
    {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let e = |e: rusqlite::Error| e.to_string();
        if let Some(o) = oro_onzas.filter(|o| *o >= 0.0) {
            db::set_ajuste(&conn, "oro_onzas", &o.to_string()).map_err(e)?;
        }
        if let Some(t) = tin.filter(|t| (0.0..=20.0).contains(t)) {
            db::set_ajuste(&conn, "hucha_tin", &t.to_string()).map_err(e)?;
        }
        if let Some(h) = hucha.filter(|h| *h >= 0.0) {
            db::set_ajuste(&conn, "hucha_saldo", &h.to_string()).map_err(e)?;
            db::set_ajuste(&conn, "hucha_fecha", &chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()).map_err(e)?;
        }
    }
    let _ = actualizar_oro(&app).await;
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    dinero_view(&conn)
}

#[derive(Serialize)]
struct BancoView {
    /// Hay ID de aplicación y clave de Enable Banking guardados.
    configurado: bool,
    /// Hay sesión con Revolut.
    conectado: bool,
    app_id: Option<String>,
    /// Hasta cuándo vale el permiso del banco (RFC 3339).
    valido_hasta: Option<String>,
    sincronizado: Option<String>,
    cuentas: usize,
    error: Option<String>,
}

#[derive(Serialize)]
struct Importe {
    nuevos: usize,
    /// Del CSV, ya cubiertos por el banco: no se guardan.
    solapados: usize,
    actualizados: usize,
    ignorados: usize,
    leidos: usize,
    vista: DineroView,
}

fn dinero_view(conn: &rusqlite::Connection) -> Result<DineroView, String> {
    let e = |e: rusqlite::Error| e.to_string();
    Ok(DineroView {
        movimientos: db::movs(conn).map_err(e)?,
        categorias: db::categorias(conn).map_err(e)?,
        importado: db::ajuste(conn, "revolut_importado").map_err(e)?,
        archivo: db::ajuste(conn, "revolut_archivo").map_err(e)?,
        banco: banco_view(conn)?,
        patrimonio: patrimonio(conn),
    })
}

fn banco_view(conn: &rusqlite::Connection) -> Result<BancoView, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let app_id = secrets::get(banco::APP_ID)?;
    let cuentas: Vec<banco::Cuenta> = db::ajuste(conn, "banco_cuentas")
        .map_err(e)?
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    Ok(BancoView {
        configurado: app_id.is_some() && secrets::get(banco::KEY)?.is_some(),
        conectado: secrets::get(banco::SESSION)?.is_some(),
        app_id,
        valido_hasta: db::ajuste(conn, "banco_valido_hasta").map_err(e)?,
        sincronizado: db::ajuste(conn, "banco_sincronizado").map_err(e)?,
        cuentas: cuentas.len(),
        error: db::ajuste(conn, "banco_error").map_err(e)?,
    })
}

fn banco_cliente() -> Result<banco::Cliente, String> {
    let app_id = secrets::get(banco::APP_ID)?.ok_or("Falta el ID de la aplicación de Enable Banking.")?;
    let pem = banco::leer_clave()?.ok_or("Falta la clave privada de Enable Banking.")?;
    banco::Cliente::new(&app_id, &pem)
}

/// Guarda el ID de la aplicación y la clave (eliges el .pem) y los comprueba contra Enable Banking.
#[tauri::command]
async fn banco_configurar(app: AppHandle, app_id: String) -> Result<Option<DineroView>, String> {
    use tauri_plugin_dialog::DialogExt;
    let app_id = app_id.trim().to_string();
    if app_id.len() < 8 {
        return Err("Pega el ID de la aplicación de Enable Banking.".into());
    }
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = a.dialog().file().set_title("Clave privada de Enable Banking (.pem)").add_filter("Clave PEM", &["pem", "key"]);
        if let Some(w) = a.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let pem = std::fs::read_to_string(&path).map_err(|e| format!("No se pudo leer la clave: {e}"))?;
    banco::Cliente::new(&app_id, &pem)?.comprobar().await?;
    banco::guardar_clave(&pem)?;
    secrets::set(banco::APP_ID, &app_id)?;
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(Some(dinero_view(&conn)?))
}

/// Abre la autorización de Revolut en una ventana de LIFE y, al volver, abre la sesión y sincroniza.
#[tauri::command]
async fn banco_conectar(app: AppHandle) -> Result<DineroView, String> {
    let cliente = banco_cliente()?;
    let state_tok = db::new_key();
    let url = cliente.empezar(&state_tok).await?;
    let url: tauri::Url = url.parse().map_err(|e| format!("Dirección de autorización no válida: {e}"))?;

    if let Some(w) = app.get_webview_window("banco") {
        let _ = w.destroy();
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let nav = tx.clone();
    let esperado = state_tok.clone();
    tauri::WebviewWindowBuilder::new(&app, "banco", tauri::WebviewUrl::External(url))
        .title("LIFE · Autorizar Revolut (solo lectura)")
        .inner_size(520.0, 780.0)
        .center()
        // Revolut abre una ventana aparte para que confirmes: se deja abrir (con su relación
        // con esta, para que avise al terminar). Lo que no sea web (enlace a la app) va al sistema.
        .on_new_window({
            let app = app.clone();
            move |u, _| {
                log::info!("banco: ventana nueva {}", u.as_str().split('?').next().unwrap_or(""));
                if matches!(u.scheme(), "http" | "https") {
                    tauri::webview::NewWindowResponse::Allow
                } else {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app.opener().open_url(u.as_str(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
                }
            }
        })
        .on_navigation(move |u| {
            if !u.as_str().starts_with(banco::REDIRECT) {
                return true;
            }
            let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
            let r = match (q.get("code"), q.get("state")) {
                (Some(c), Some(s)) if *s == esperado => Ok(c.clone()),
                (Some(_), _) => Err("La respuesta del banco no coincide con esta autorización.".to_string()),
                _ => Err(q.get("error_description").or(q.get("error")).cloned().unwrap_or_else(|| "Autorización cancelada.".into())),
            };
            if let Some(s) = nav.lock().ok().and_then(|mut g| g.take()) {
                let _ = s.send(r);
            }
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    drop(tx);

    let res = tokio::time::timeout(std::time::Duration::from_secs(15 * 60), rx).await;
    if let Some(w) = app.get_webview_window("banco") {
        let _ = w.destroy();
    }
    let code = match res {
        Err(_) => return Err("La autorización tardó demasiado. Vuelve a intentarlo.".into()),
        Ok(Err(_)) => return Err("Cerraste la ventana sin autorizar.".into()),
        Ok(Ok(r)) => r?,
    };
    let sesion = cliente.sesion(&code).await?;
    secrets::set(banco::SESSION, &sesion.session_id)?;
    {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let e = |e: rusqlite::Error| e.to_string();
        db::set_ajuste(&conn, "banco_cuentas", &serde_json::to_string(&sesion.accounts).map_err(|e| e.to_string())?).map_err(e)?;
        if let Some(v) = sesion.valid_until() {
            db::set_ajuste(&conn, "banco_valido_hasta", &v).map_err(e)?;
        }
        let _ = conn.execute("DELETE FROM ajustes WHERE clave IN ('banco_error', 'banco_desde', 'aviso_banco')", []);
    }
    sync_banco(&app).await
}

/// Descarga movimientos y saldos de todas las cuentas autorizadas.
async fn sync_banco(app: &AppHandle) -> Result<DineroView, String> {
    let cliente = banco_cliente()?;
    let (cuentas, desde, huchas): (Vec<banco::Cuenta>, String, Vec<String>) = {
        let state = app.state::<Db>();
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        // Revolut no da la hucha por Open Banking: su nombre sale de los intereses del resumen
        // del ejercicio importado, para que los traspasos a ella sigan siendo internos.
        let huchas = db::nombres_hucha(&conn).map_err(|e| e.to_string())?;
        let cuentas = db::ajuste(&conn, "banco_cuentas")
            .map_err(|e| e.to_string())?
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        // La primera vez, todo lo que dé el banco; después, desde 10 días antes de la última.
        let desde = db::ajuste(&conn, "banco_desde")
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| (chrono::Local::now() - chrono::Duration::days(730)).format("%Y-%m-%d").to_string());
        (cuentas, desde, huchas)
    };
    if cuentas.is_empty() {
        return Err("El banco no autorizó ninguna cuenta.".into());
    }
    // Solo las huchas: el nombre de la cuenta en Revolut es el tuyo, y lo que te mandas desde
    // otro banco sí cuenta como dinero que entra.
    let propias = huchas;
    let resultado: Result<Vec<revolut::Mov>, String> = async {
        let mut movs = Vec::new();
        for c in &cuentas {
            let raw = cliente.movimientos(&c.uid, &desde).await?;
            let mut ms: Vec<revolut::Mov> = raw.iter().filter_map(|t| banco::a_mov(t, c, &propias)).collect();
            ms.sort_by(|a, b| a.fecha.cmp(&b.fecha));
            // Si el banco no da el saldo tras cada movimiento, el saldo actual va en el último.
            if ms.iter().all(|m| m.saldo.is_none()) {
                if let (Some(s), Some(last)) = (cliente.saldo(&c.uid).await?, ms.last_mut()) {
                    last.saldo = Some(s);
                }
            }
            movs.extend(ms);
        }
        Ok(movs)
    }
    .await;

    let state = app.state::<Db>();
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = gmail::utc(chrono::Utc::now());
    let movs = match resultado {
        Ok(m) => m,
        Err(err) => {
            let _ = db::set_ajuste(&conn, "banco_error", &err);
            db::log_sync(&conn, "banco", false, Some(&err));
            return Err(err);
        }
    };
    db::upsert_movs(&mut conn, &movs, &now).map_err(|e| e.to_string())?;
    // Lo del banco manda sobre lo importado por CSV en el mismo periodo y producto.
    db::retirar_csv_solapado(&conn).map_err(|e| e.to_string())?;
    let hasta = (chrono::Local::now() - chrono::Duration::days(10)).format("%Y-%m-%d").to_string();
    let e = |e: rusqlite::Error| e.to_string();
    db::set_ajuste(&conn, "banco_desde", &hasta).map_err(e)?;
    db::set_ajuste(&conn, "banco_sincronizado", &now).map_err(e)?;
    let _ = conn.execute("DELETE FROM ajustes WHERE clave = 'banco_error'", []);
    db::log_sync(&conn, "banco", true, Some(&format!("{} movimientos", movs.len())));
    let view = dinero_view(&conn)?;
    drop(conn);
    let _ = app.emit("dinero-updated", &view);
    Ok(view)
}

#[tauri::command]
async fn banco_sync(app: AppHandle) -> Result<DineroView, String> {
    sync_banco(&app).await
}

/// Quita el permiso del banco en LIFE. Con `todo`, también el ID y la clave de Enable Banking.
/// Los movimientos ya descargados se quedan.
#[tauri::command]
fn banco_desconectar(app: AppHandle, todo: bool) -> Result<DineroView, String> {
    secrets::delete(banco::SESSION)?;
    if todo {
        banco::borrar_clave()?;
        secrets::delete(banco::APP_ID)?;
    }
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM ajustes WHERE clave IN ('banco_cuentas', 'banco_valido_hasta', 'banco_desde', 'banco_error', 'aviso_banco')",
        [],
    );
    dinero_view(&conn)
}

/// Aviso de Windows una vez cuando al permiso del banco le quedan 7 días o menos.
fn avisar_banco(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let Some(hasta) = db::ajuste(&conn, "banco_valido_hasta").map_err(|e| e.to_string())? else { return Ok(()) };
    let Ok(h) = chrono::DateTime::parse_from_rfc3339(&hasta) else { return Ok(()) };
    let dias = (h.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days();
    if dias > 7 || db::ajuste(&conn, "aviso_banco").map_err(|e| e.to_string())?.as_deref() == Some(&hasta) {
        return Ok(());
    }
    let _ = app
        .notification()
        .builder()
        .title("Revolut · renovar acceso")
        .body(if dias < 0 { "El permiso del banco ha caducado. Renuévalo en LIFE → F5.".to_string() } else { format!("Al permiso del banco le quedan {dias} días. Renuévalo en LIFE → F5.") })
        .show();
    db::set_ajuste(&conn, "aviso_banco", &hasta).map_err(|e| e.to_string())
}

#[tauri::command]
fn dinero_status(app: AppHandle) -> Result<DineroView, String> {
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    dinero_view(&conn)
}

/// Pide el CSV del extracto de Revolut, lo lee y guarda los movimientos. `None` si cancelas.
#[tauri::command]
async fn dinero_importar(app: AppHandle) -> Result<Option<Importe>, String> {
    use tauri_plugin_dialog::DialogExt;
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = a.dialog().file().set_title("Extracto de Revolut (CSV)").add_filter("CSV", &["csv"]);
        if let Some(w) = a.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| format!("No se pudo leer el archivo: {e}"))?;
    let parsed = revolut::parse(&String::from_utf8_lossy(&bytes))?;

    let (nuevos, actualizados, solapados) = {
    let state = app.state::<Db>();
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = gmail::utc(chrono::Utc::now());
    let (nuevos, actualizados) = db::upsert_movs(&mut conn, &parsed.movs, &now).map_err(|e| e.to_string())?;
    // Si ya hay datos del banco, el CSV no los duplica.
    let solapados = db::retirar_csv_solapado(&conn).map_err(|e| e.to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    db::set_ajuste(&conn, "revolut_importado", &now).map_err(|e| e.to_string())?;
    db::set_ajuste(&conn, "revolut_archivo", &name).map_err(|e| e.to_string())?;
    if let Some(h) = parsed.movs.iter().find_map(|m| m.descripcion.strip_prefix("Intereses de ")) {
        db::set_ajuste(&conn, "hucha_nombre", h).map_err(|e| e.to_string())?;
    }
    if let Some(o) = &parsed.oro {
        let e = |e: rusqlite::Error| e.to_string();
        db::set_ajuste(&conn, "oro_onzas", &o.onzas.to_string()).map_err(e)?;
        db::set_ajuste(&conn, "oro_coste", &o.coste.to_string()).map_err(e)?;
        db::set_ajuste(&conn, "oro_fecha", &o.fecha).map_err(e)?;
        if let Some(v) = o.valor {
            db::set_ajuste(&conn, "oro_valor", &v.to_string()).map_err(e)?;
        }
    }
    db::log_sync(&conn, "revolut", true, Some(&format!("{name}: {nuevos} nuevos, {actualizados} actualizados")));
    (nuevos, actualizados, solapados)
    };
    if parsed.oro.is_some() {
        if let Err(e) = actualizar_oro(&app).await {
            log::warn!("oro: {e}");
        }
    }
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(Some(Importe {
        nuevos: nuevos.saturating_sub(solapados),
        solapados,
        actualizados,
        ignorados: parsed.ignorados,
        leidos: parsed.movs.len(),
        vista: dinero_view(&conn)?,
    }))
}

#[tauri::command]
fn dinero_categoria(app: AppHandle, comercio: String, categoria: String) -> Result<DineroView, String> {
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::set_categoria(&conn, &comercio, categoria.trim()).map_err(|e| e.to_string())?;
    dinero_view(&conn)
}

/// Borra los movimientos importados (las categorías elegidas se conservan).
#[tauri::command]
fn dinero_borrar(app: AppHandle) -> Result<DineroView, String> {
    let state = app.state::<Db>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::borrar_movs(&conn).map_err(|e| e.to_string())?;
    let _ = conn.execute("DELETE FROM ajustes WHERE clave IN ('revolut_importado', 'revolut_archivo')", []);
    dinero_view(&conn)
}

async fn sync_all(app: &AppHandle, github_too: bool) {
    // Precio del oro cada hora, solo si tienes oro.
    let tiene_oro = {
        let state = app.state::<Db>();
        let conn = state.0.lock();
        conn.ok().and_then(|c| db::ajuste(&c, "oro_onzas").ok().flatten()).and_then(|v| v.parse::<f64>().ok()).is_some_and(|o| o > 0.0)
    };
    if tiene_oro && github_too {
        if let Err(e) = actualizar_oro(app).await {
            log::warn!("oro: {e}");
        }
    }
    // Banco: cada 6 h como mucho (PSD2 permite unas 4 consultas al día sin ti delante).
    if matches!(secrets::get(banco::SESSION), Ok(Some(_))) {
        let toca = {
            let state = app.state::<Db>();
            let conn = state.0.lock();
            conn.ok()
                .and_then(|c| db::ajuste(&c, "banco_sincronizado").ok().flatten())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                .is_none_or(|t| chrono::Utc::now() - t.with_timezone(&chrono::Utc) > chrono::Duration::hours(6))
        };
        if toca {
            if let Err(e) = sync_banco(app).await {
                log::warn!("banco: {e}");
            }
        }
        let _ = avisar_banco(app);
    }
    if matches!(secrets::get(gmail::PASS), Ok(Some(_))) {
        if let Err(e) = sync_gmail(app).await {
            log::warn!("gmail: {e}");
        }
    }
    if github_too && matches!(secrets::get(instagram::TOKEN), Ok(Some(_))) {
        if let Err(e) = sync_instagram(app).await {
            log::warn!("instagram: {e}");
        }
    }
    if github_too && matches!(secrets::get(github::TOKEN), Ok(Some(_))) {
        if let Err(e) = sync_github(app).await {
            log::warn!("github: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Una sola LIFE: abrirla otra vez trae al frente la que ya está en la bandeja.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--bandeja"]),
        ))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build(),
                )?;
            }

            let dir = app.path().app_data_dir()?;
            let key = db_key().map_err(|e| format!("No se pudo leer la clave de life.db: {e}"))?;
            let conn = db::open(&dir, &key).map_err(|e| format!("No se pudo abrir life.db: {e}"))?;
            app.manage(Db(Mutex::new(conn)));

            // Bandeja del sistema
            let open = MenuItemBuilder::with_id("open", "Abrir LIFE").build(app)?;
            let sync = MenuItemBuilder::with_id("sync", "Sincronizar ahora").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Salir").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open, &sync]).separator().item(&quit).build()?;
            TrayIconBuilder::with_id("life")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .tooltip("LIFE")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "sync" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            sync_all(&app, true).await;
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Al arrancar con Windows se queda en la bandeja; si no, se muestra.
            if !std::env::args().any(|a| a == "--bandeja") {
                show_main(app.handle());
            }

            // Sincronización periódica mientras LIFE esté abierta (ventana o bandeja).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick: u32 = 0;
                loop {
                    sync_all(&handle, tick % GITHUB_EVERY == 0).await;
                    tick = tick.wrapping_add(1);
                    tokio::time::sleep(TICK).await;
                }
            });
            Ok(())
        })
        // Cerrar la ventana la esconde en la bandeja; para salir, menú de la bandeja → Salir.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            github_status,
            github_connect,
            github_sync,
            github_disconnect,
            gmail_status,
            gmail_connect,
            gmail_sync,
            gmail_disconnect,
            encargo_estado,
            encargo_abrir,
            dinero_status,
            dinero_importar,
            dinero_categoria,
            dinero_borrar,
            banco_configurar,
            banco_conectar,
            banco_sync,
            banco_desconectar,
            patrimonio_ajustar,
            instagram_status,
            instagram_connect,
            instagram_sync,
            instagram_disconnect,
            instagram_abrir
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar LIFE");
}
