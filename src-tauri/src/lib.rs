mod db;
mod github;
mod secrets;

use db::Db;
use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

const SYNC_EVERY: std::time::Duration = std::time::Duration::from_secs(60 * 60);

#[derive(Serialize)]
struct SourceStatus<T> {
    connected: bool,
    snapshot: Option<T>,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Una sola LIFE: abrirla otra vez trae al frente la que ya está en la bandeja.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
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
            let conn = db::open(&dir).map_err(|e| format!("No se pudo abrir life.db: {e}"))?;
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
                            let _ = sync_github(&app).await;
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
                loop {
                    if matches!(secrets::get(github::TOKEN), Ok(Some(_))) {
                        if let Err(e) = sync_github(&handle).await {
                            log::warn!("github: {e}");
                        }
                    }
                    tokio::time::sleep(SYNC_EVERY).await;
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
            github_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar LIFE");
}
