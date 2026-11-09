//! MaxCloud desktop: settings window + tray, running sync-agent in a background thread.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sync_agent::api::{Client, Tokens};
use sync_core::SyncConfig;
use tauri::{Manager, State};

#[derive(Clone, Serialize, Deserialize, Default)]
struct Settings {
    server: String,
    root: String,
    excluded: Vec<String>,
    upload_kbps: u64,
    download_kbps: u64,
    paused: bool,
    access: String,
    refresh: String,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    last: Mutex<String>,
}

fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap().join("settings.json")
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Desktop".into())
}

#[tauri::command]
fn login(app: tauri::AppHandle, state: State<Arc<AppState>>, server: String, email: String, password: String, totp: Option<String>, root: String) -> Result<(), String> {
    let client = Client::new(&server, &device_name(), 0, 0);
    let t = client.login(&email, &password, totp.as_deref()).map_err(|e| e.to_string())?;
    let mut s = state.settings.lock().unwrap();
    *s = Settings { server, root, access: t.access_token, refresh: t.refresh_token, ..s.clone() };
    std::fs::create_dir_all(settings_path(&app).parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(&app), serde_json::to_vec(&*s).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_settings(app: tauri::AppHandle, state: State<Arc<AppState>>, excluded: Vec<String>, upload_kbps: u64, download_kbps: u64, paused: bool) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    s.excluded = excluded;
    s.upload_kbps = upload_kbps;
    s.download_kbps = download_kbps;
    s.paused = paused;
    std::fs::write(settings_path(&app), serde_json::to_vec(&*s).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn status(state: State<Arc<AppState>>) -> (Settings, String) {
    let mut s = state.settings.lock().unwrap().clone();
    s.access.clear();
    s.refresh.clear();
    (s, state.last.lock().unwrap().clone())
}

/// Background loop: sync every 30 s (the agent is incremental; unchanged files are not re-hashed).
fn spawn_sync(app: tauri::AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || loop {
        let s = state.settings.lock().unwrap().clone();
        if !s.paused && !s.access.is_empty() && !s.root.is_empty() {
            let client = Client::new(&s.server, &device_name(), s.upload_kbps * 1024, s.download_kbps * 1024);
            *client.tokens.lock().unwrap() = Tokens { access_token: s.access.clone(), refresh_token: s.refresh.clone() };
            let cfg = SyncConfig { excluded: s.excluded.clone(), device_name: device_name(), today: sync_agent::today_utc() };
            let msg = match sync_agent::sync_once(&client, &PathBuf::from(&s.root), &cfg) {
                Ok(r) => format!("Up to date · ↑{} ↓{} · {} conflict(s){}", r.uploaded, r.downloaded, r.conflicts, if r.errors.is_empty() { String::new() } else { format!(" · {} error(s)", r.errors.len()) }),
                Err(e) => format!("Sync error: {e}"),
            };
            *state.last.lock().unwrap() = msg;
            // persist rotated tokens
            let t = client.tokens.lock().unwrap().clone();
            let mut cur = state.settings.lock().unwrap();
            cur.access = t.access_token;
            cur.refresh = t.refresh_token;
            let _ = std::fs::write(settings_path(&app), serde_json::to_vec(&*cur).unwrap());
        }
        std::thread::sleep(Duration::from_secs(30));
    });
}

fn main() {
    let state = Arc::new(AppState::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(state.clone())
        .setup(move |app| {
            if let Ok(b) = std::fs::read(settings_path(app.handle())) {
                if let Ok(s) = serde_json::from_slice::<Settings>(&b) {
                    *state.settings.lock().unwrap() = s;
                }
            }
            let _tray = tauri::tray::TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone()).tooltip("MaxCloud").build(app)?;
            spawn_sync(app.handle().clone(), state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![login, update_settings, status])
        .run(tauri::generate_context!())
        .expect("error while running MaxCloud");
}
