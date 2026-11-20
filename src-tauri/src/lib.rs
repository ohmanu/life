mod db;
mod github;
mod gmail;
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

async fn sync_all(app: &AppHandle, github_too: bool) {
    if matches!(secrets::get(gmail::PASS), Ok(Some(_))) {
        if let Err(e) = sync_gmail(app).await {
            log::warn!("gmail: {e}");
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
                .icon(app.default_window_icon().cloned().ok_or("sin icono")?)
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
            encargo_abrir
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar LIFE");
}
