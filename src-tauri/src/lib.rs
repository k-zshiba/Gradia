mod auth;
mod codex;
mod files;
mod model;
mod store;
mod translation;
use model::*;
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub struct AppState {
    root: PathBuf,
    store: store::Store,
    http: reqwest::Client,
    local_http: reqwest::Client,
    imports: Mutex<HashMap<String, String>>,
    jobs: Mutex<HashMap<String, CancellationToken>>,
    engine: Mutex<Option<translation::Engine>>,
    auth_gate: Mutex<()>,
    chat_gate: Mutex<()>,
}
pub fn emit(app: &tauri::AppHandle, event: Value) {
    let _ = app.emit("study-job", event);
}
#[tauri::command]
fn list_documents(state: State<'_, AppState>) -> Result<Vec<Document>> {
    state.store.list()
}
#[tauri::command]
fn save_preference(
    id: String,
    revision: String,
    ratio: u8,
    position: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    state.store.preference(&id, &revision, ratio, position)
}
#[tauri::command]
fn get_translations(id: String, revision: String, state: State<'_, AppState>) -> Result<Value> {
    translation::check_model_stamp(&state)?;
    state.store.translations(&id, &revision)
}
#[tauri::command]
fn get_history(
    id: String,
    revision: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>> {
    state.store.history(&id, &revision)
}
#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings> {
    state.store.settings()
}
#[tauri::command]
async fn save_settings(settings: Settings, state: State<'_, AppState>) -> Result<()> {
    let old = state.store.settings()?;
    if old.llama_path != settings.llama_path
        || old.model_path != settings.model_path
        || old.gpu_layers != settings.gpu_layers
    {
        for token in state.jobs.lock().await.values() {
            token.cancel();
        }
        if let Some(mut engine) = state.engine.lock().await.take() {
            let _ = engine.child.kill().await;
        }
        state
            .store
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM translations", [])
            .map_err(|e| e.to_string())?;
    }
    state.store.set(
        "settings",
        &serde_json::to_string(&settings).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
async fn cancel_job(job_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some(token) = state.jobs.lock().await.get(&job_id) {
        token.cancel();
    }
    Ok(())
}
#[tauri::command]
async fn prepare_update(state: State<'_, AppState>) -> Result<()> {
    let tokens = state
        .jobs
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for token in tokens {
        token.cancel();
    }
    // Jobs persist their final/interrupted state before removing themselves.
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while !state.jobs.lock().await.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "処理の終了を待っています。少し待って更新をやり直してください".to_string())?;
    if let Some(mut engine) = state.engine.lock().await.take() {
        let _ = engine.child.kill().await;
    }
    Ok(())
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let root = app.path().app_local_data_dir()?;
            // Development integration tests use an isolated database and credentials directory.
            #[cfg(debug_assertions)]
            let root = std::env::var_os("STUDY_TOOL_TEST_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(root);
            std::fs::create_dir_all(root.join("snapshots"))?;
            let store =
                store::Store::open(&root.join("study.sqlite3")).map_err(std::io::Error::other)?;
            let http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()?;
            let local_http = reqwest::Client::builder().no_proxy().build()?;
            app.manage(AppState {
                root,
                store,
                http,
                local_http,
                imports: Mutex::new(HashMap::new()),
                jobs: Mutex::new(HashMap::new()),
                engine: Mutex::new(None),
                auth_gate: Mutex::new(()),
                chat_gate: Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_documents,
            files::read_file,
            files::list_folder,
            files::fetch_page,
            files::save_document,
            files::read_snapshot,
            files::open_url,
            save_preference,
            get_translations,
            get_history,
            get_settings,
            save_settings,
            cancel_job,
            prepare_update,
            translation::start_translation,
            translation::start_engine,
            translation::stop_engine,
            auth::sign_in,
            auth::sign_out,
            auth::account_status,
            codex::start_chat
        ])
        .run(tauri::generate_context!())
        .expect("Gradiaを起動できませんでした");
}
