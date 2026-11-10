mod auth;
mod codex;
mod files;
mod model;
mod store;
mod translation;
mod updates;
mod web;
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
    mutation_gate: Mutex<()>,
}
impl AppState {
    async fn cancel_jobs(&self) {
        for token in self.jobs.lock().await.values() {
            token.cancel();
        }
    }
    async fn cancel_and_wait(&self, ids: Option<&[String]>) -> Result<()> {
        {
            let jobs = self.jobs.lock().await;
            for (id, token) in jobs.iter() {
                if ids.is_none_or(|ids| ids.contains(id)) {
                    token.cancel();
                }
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let pending = self
                    .jobs
                    .lock()
                    .await
                    .keys()
                    .any(|id| ids.is_none_or(|ids| ids.contains(id)));
                if !pending {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "処理の終了を待っています。少し待ってやり直してください".to_string())
    }
}

#[cfg(test)]
fn test_state(root: PathBuf) -> AppState {
    AppState {
        root,
        store: store::Store::open(std::path::Path::new(":memory:")).unwrap(),
        http: reqwest::Client::new(),
        local_http: reqwest::Client::builder().no_proxy().build().unwrap(),
        imports: Mutex::new(HashMap::new()),
        jobs: Mutex::new(HashMap::new()),
        engine: Mutex::new(None),
        auth_gate: Mutex::new(()),
        chat_gate: Mutex::new(()),
        mutation_gate: Mutex::new(()),
    }
}
pub fn emit(app: &tauri::AppHandle, event: Value) {
    let _ = app.emit("study-job", event);
}

#[cfg(test)]
mod job_tests {
    use super::*;

    #[tokio::test]
    async fn deletion_waits_for_cancelled_jobs_to_finish_their_last_write() {
        let state = std::sync::Arc::new(test_state(PathBuf::new()));
        let selected = CancellationToken::new();
        let other = CancellationToken::new();
        state
            .jobs
            .lock()
            .await
            .insert("selected".into(), selected.clone());
        state
            .jobs
            .lock()
            .await
            .insert("other".into(), other.clone());
        let worker = state.clone();
        let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let wrote = finished.clone();
        tokio::spawn(async move {
            selected.cancelled().await;
            tokio::task::yield_now().await;
            wrote.store(true, std::sync::atomic::Ordering::SeqCst);
            worker.jobs.lock().await.remove("selected");
        });
        state
            .cancel_and_wait(Some(&["selected".into()]))
            .await
            .unwrap();
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!other.is_cancelled());
        state.jobs.lock().await.remove("other");
        state.cancel_and_wait(None).await.unwrap();
    }
}
#[tauri::command]
fn list_documents(state: State<'_, AppState>) -> Result<Vec<Document>> {
    state.store.list()
}
#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>> {
    state.store.projects()
}
#[tauri::command]
fn create_project(name: String, state: State<'_, AppState>) -> Result<Project> {
    state.store.create_project(&name)
}
#[tauri::command]
fn rename_project(id: String, name: String, state: State<'_, AppState>) -> Result<()> {
    state.store.rename_project(&id, &name)
}
#[tauri::command]
fn delete_project(id: String, state: State<'_, AppState>) -> Result<()> {
    state.store.delete_project(&id)
}
#[tauri::command]
fn set_project_document(
    project_id: String,
    id: String,
    revision: String,
    add: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    state
        .store
        .project_document(&project_id, &id, &revision, add)
}
#[tauri::command]
fn save_preference(
    id: String,
    revision: String,
    ratio: u8,
    position: Option<String>,
    bilingual: Option<bool>,
    state: State<'_, AppState>,
) -> Result<()> {
    state
        .store
        .preference(&id, &revision, ratio, position, bilingual.unwrap_or(false))
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
        state.cancel_jobs().await;
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
    let _gate = state.mutation_gate.lock().await;
    state.cancel_and_wait(None).await?;
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
            // Test runs must never overwrite the user's documents or credentials.
            #[cfg(debug_assertions)]
            let root = std::env::var_os("STUDY_TOOL_TEST_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(root);
            std::fs::create_dir_all(root.join("snapshots"))?;
            let store =
                store::Store::open(&root.join("study.sqlite3")).map_err(std::io::Error::other)?;
            let http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?;
            let local_http = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()?;
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
                mutation_gate: Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_documents,
            list_projects,
            create_project,
            rename_project,
            delete_project,
            set_project_document,
            files::read_file,
            files::list_folder,
            files::fetch_page,
            files::save_document,
            files::delete_document,
            files::upgrade_markdown,
            files::read_snapshot,
            files::open_url,
            save_preference,
            get_translations,
            get_history,
            get_settings,
            save_settings,
            cancel_job,
            prepare_update,
            updates::check_release_update,
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
