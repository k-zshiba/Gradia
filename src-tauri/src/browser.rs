use crate::{model::*, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
#[cfg(windows)]
#[path = "browser_native.rs"]
mod native;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl BrowserBounds {
    fn validate(self) -> Result<Self> {
        if self.x < 0
            || self.y < 0
            || self.width < 1
            || self.height < 1
            || self.x > 32000
            || self.y > 32000
            || self.width > 32000
            || self.height > 32000
        {
            return Err("Web表示の大きさが不正です".into());
        }
        Ok(self)
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowserAction {
    Navigate { url: String },
    Back,
    Forward,
    Reload,
    Bounds { bounds: BrowserBounds },
    Focus,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub session_id: String,
    pub generation: u64,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub error: Option<String>,
}
#[derive(Deserialize)]
pub struct CapturedPage {
    segments: Vec<Segment>,
    title: String,
    url: String,
    truncated: bool,
    #[serde(skip)]
    token: CancellationToken,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotView {
    id: String,
    session_id: String,
    generation: u64,
    title: String,
    url: String,
    segments: Vec<Segment>,
    truncated: bool,
    translations: HashMap<String, String>,
    job_id: Option<String>,
    error: Option<String>,
}
struct Snapshot {
    view: SnapshotView,
    token: CancellationToken,
    selected: HashSet<String>,
    bilingual: bool,
    model_stamp: String,
}
#[derive(Default)]
pub struct Browser {
    page: Mutex<Option<Snapshot>>,
    gate: Mutex<()>,
}

fn trusted(webview: &Webview) -> Result<()> {
    let url = webview.url().map_err(|e| e.to_string())?;
    let allowed = url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("tauri", Some("localhost")) | ("http", Some("tauri.localhost"))
        );
    #[cfg(debug_assertions)]
    let allowed = allowed
        || (url.scheme() == "http"
            && url.host_str() == Some("localhost")
            && url.port() == Some(1420));
    if webview.label() != "main"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("この画面からWeb表示を操作できません".into());
    }
    Ok(())
}
fn navigation_url(input: &str) -> Result<String> {
    let url = crate::files::http_url(input)?;
    #[cfg(debug_assertions)]
    if std::env::var("STUDY_TOOL_BROWSER_TEST_ORIGIN")
        .ok()
        .is_some_and(|origin| {
            origin == url.origin().ascii_serialization()
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some()
        })
    {
        return Ok(url.to_string());
    }
    let local = match url.host().ok_or("URLにホスト名がありません")? {
        url::Host::Domain(host) => {
            let host = host.trim_end_matches('.');
            host == "localhost"
                || host.ends_with(".localhost")
                || !host.contains('.')
                || host.ends_with(".local")
        }
        url::Host::Ipv4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.octets()[0] == 0
        }
        url::Host::Ipv6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || ip.to_ipv4_mapped().is_some()
        }
    };
    if local {
        return Err("ローカルアドレスは開けません".into());
    }
    Ok(url.to_string())
}
fn selected_ids(view: &SnapshotView, ids: Vec<String>) -> Result<HashSet<String>> {
    let eligible: HashSet<_> = view
        .segments
        .iter()
        .filter(|segment| segment.eligible)
        .map(|segment| segment.id.as_str())
        .collect();
    if ids.len() > eligible.len() || ids.iter().any(|id| !eligible.contains(id.as_str())) {
        return Err("翻訳する文が現在のページにありません".into());
    }
    Ok(ids.into_iter().collect())
}
fn matching<'a>(
    page: &'a mut Option<Snapshot>,
    session: &str,
    snapshot: &str,
) -> Result<&'a mut Snapshot> {
    page.as_mut()
        .filter(|page| {
            page.view.session_id == session
                && page.view.id == snapshot
                && !page.token.is_cancelled()
        })
        .ok_or("ページが変わりました。本文を再解析してください".into())
}
async fn apply(app: &AppHandle, page: &Snapshot) -> Result<Value> {
    let updates: Vec<_> = page
        .selected
        .iter()
        .filter_map(|id| {
            page.view
                .translations
                .get(id)
                .map(|text| json!({"id":id,"text":text}))
        })
        .collect();
    native::display(
        app,
        &page.view.session_id,
        page.view.generation,
        json!(updates),
        page.bilingual,
    )
    .await
}
#[tauri::command]
pub async fn browser_open(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<()> {
    trusted(&webview)?;
    if uuid::Uuid::parse_str(&session_id).is_err() {
        return Err("Web表示IDが不正です".into());
    }
    let url = navigation_url(&url)?;
    let bounds = bounds.validate()?;
    let _gate = state.browser.gate.lock().await;
    if let Some(page) = state.browser.page.lock().await.take() {
        page.token.cancel();
    }
    native::open(
        &app,
        session_id,
        url,
        state.root.join("browser-profile"),
        bounds,
    )
    .await
}
#[tauri::command]
pub async fn browser_close(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<()> {
    trusted(&webview)?;
    // Close cannot wait behind a renderer callback; WebView2 may omit callbacks after destruction.
    native::close(&app, session_id.clone()).await?;
    let mut page = state.browser.page.lock().await;
    if page
        .as_ref()
        .is_some_and(|page| page.view.session_id == session_id)
    {
        if let Some(page) = page.take() {
            page.token.cancel();
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn browser_action(
    webview: Webview,
    app: AppHandle,
    session_id: String,
    mut action: BrowserAction,
) -> Result<()> {
    trusted(&webview)?;
    match &mut action {
        BrowserAction::Navigate { url } => *url = navigation_url(url)?,
        BrowserAction::Bounds { bounds } => *bounds = bounds.validate()?,
        _ => {}
    }
    native::action(&app, session_id, action).await
}
#[tauri::command]
pub async fn browser_status(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value> {
    trusted(&webview)?;
    let status = native::status(&app, session_id.clone()).await?;
    let page = state.browser.page.lock().await;
    let snapshot = page
        .as_ref()
        .filter(|page| {
            page.view.session_id == session_id
                && page.view.generation == status.generation
                && !page.token.is_cancelled()
        })
        .map(|page| &page.view);
    Ok(json!({"status":status,"snapshot":snapshot}))
}
#[tauri::command]
pub async fn browser_capture(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SnapshotView> {
    trusted(&webview)?;
    let _gate = state.browser.gate.lock().await;
    let status = native::status(&app, session_id.clone()).await?;
    if status.loading {
        return Err("ページの読み込みを待ってください".into());
    }
    if let Some(page) = state.browser.page.lock().await.take() {
        page.token.cancel();
    }
    let captured = native::capture(&app, &session_id, status.generation).await?;
    navigation_url(&captured.url)?;
    if captured.segments.len() > 2000
        || captured
            .segments
            .iter()
            .map(|s| s.text.len())
            .sum::<usize>()
            > 800000
    {
        return Err("ページの本文が大きすぎます".into());
    }
    let view = SnapshotView {
        id: uuid::Uuid::new_v4().to_string(),
        session_id,
        generation: status.generation,
        title: captured.title,
        url: captured.url,
        segments: captured.segments,
        truncated: captured.truncated,
        translations: HashMap::new(),
        job_id: None,
        error: None,
    };
    *state.browser.page.lock().await = Some(Snapshot {
        view: view.clone(),
        token: captured.token.child_token(),
        selected: HashSet::new(),
        bilingual: false,
        model_stamp: crate::translation::check_model_stamp(&state)?,
    });
    Ok(view)
}
#[tauri::command]
pub async fn browser_display(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    snapshot_id: String,
    segment_ids: Vec<String>,
    bilingual: bool,
) -> Result<Value> {
    trusted(&webview)?;
    let _gate = state.browser.gate.lock().await;
    let mut guard = state.browser.page.lock().await;
    let page = matching(&mut guard, &session_id, &snapshot_id)?;
    page.selected = selected_ids(&page.view, segment_ids)?;
    page.bilingual = bilingual;
    let stamp = crate::translation::check_model_stamp(&state)?;
    if page.model_stamp != stamp {
        page.view.translations.clear();
        page.model_stamp = stamp;
    }
    apply(&app, page).await
}
async fn translate(
    app: &AppHandle,
    session: &str,
    snapshot: &str,
    job: &str,
    segments: &[Segment],
    ids: HashSet<String>,
    cancel: CancellationToken,
) -> Result<()> {
    let state = app.state::<AppState>();
    tokio::select! { _ = cancel.cancelled() => return Err("interrupted".into()), result = crate::translation::ensure_engine(&state) => result? }
    for segment in segments.iter().filter(|segment| ids.contains(&segment.id)) {
        let translated = tokio::select! { _ = cancel.cancelled() => return Err("interrupted".into()), result = crate::translation::translate_original(&state, segments, segment) => result };
        match translated {
            Ok(result) => {
                let _gate = tokio::select! { _ = cancel.cancelled() => return Err("interrupted".into()), gate = state.browser.gate.lock() => gate };
                let mut guard = state.browser.page.lock().await;
                let page = matching(&mut guard, session, snapshot)?;
                if cancel.is_cancelled() {
                    return Err("interrupted".into());
                }
                state
                    .store
                    .cache_browser_translation(&result.key, &result.text)?;
                page.view
                    .translations
                    .insert(segment.id.clone(), result.text);
                apply(app, page).await?;
                let _ = app.emit_to("main", "browser-job", json!({"sessionId":session,"snapshotId":snapshot,"jobId":job,"status":"running","segmentId":segment.id,"cached":result.cached}));
            }
            Err(error) => {
                if let Some(page) = state
                    .browser
                    .page
                    .lock()
                    .await
                    .as_mut()
                    .filter(|page| page.view.id == snapshot)
                {
                    page.view.error = Some(error.clone());
                }
                let _ = app.emit_to("main", "browser-job", json!({"sessionId":session,"snapshotId":snapshot,"jobId":job,"status":"running","segmentId":segment.id,"error":error}));
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn browser_translate(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    snapshot_id: String,
    segment_ids: Vec<String>,
) -> Result<String> {
    trusted(&webview)?;
    let _mutation = state.mutation_gate.lock().await;
    let _gate = state.browser.gate.lock().await;
    let mut guard = state.browser.page.lock().await;
    let page = matching(&mut guard, &session_id, &snapshot_id)?;
    let ids = selected_ids(&page.view, segment_ids)?;
    if page.view.job_id.is_some() {
        return Err("実行中の翻訳を中断してからやり直してください".into());
    }
    let segments = page.view.segments.clone();
    let token = page.token.child_token();
    let job = uuid::Uuid::new_v4().to_string();
    page.view.error = None;
    page.view.job_id = Some(job.clone());
    state.jobs.lock().await.insert(job.clone(), token.clone());
    let job_id = job.clone();
    tokio::spawn(async move {
        let result = translate(
            &app,
            &session_id,
            &snapshot_id,
            &job_id,
            &segments,
            ids,
            token,
        )
        .await;
        let status = match &result {
            Ok(()) => "completed",
            Err(e) if e == "interrupted" => "interrupted",
            _ => "failed",
        };
        let state = app.state::<AppState>();
        if let Some(page) = state
            .browser
            .page
            .lock()
            .await
            .as_mut()
            .filter(|page| page.view.id == snapshot_id)
        {
            page.view.job_id = None;
            if let Err(error) = &result {
                if error != "interrupted" {
                    page.view.error = Some(error.clone());
                }
            }
        }
        let _ = app.emit_to("main", "browser-job", json!({"sessionId":session_id,"snapshotId":snapshot_id,"jobId":job_id,"status":status,"error":result.err()}));
        state.jobs.lock().await.remove(&job_id);
    });
    Ok(job)
}
#[tauri::command]
pub async fn browser_save(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    snapshot_id: String,
    project_id: Option<String>,
) -> Result<Document> {
    trusted(&webview)?;
    let _mutation = state.mutation_gate.lock().await;
    let _gate = state.browser.gate.lock().await;
    let status = native::status(&app, session_id.clone()).await?;
    let mut guard = state.browser.page.lock().await;
    let page = matching(&mut guard, &session_id, &snapshot_id)?;
    if page.view.generation != status.generation {
        return Err("ページが変わりました。再解析してください".into());
    }
    let document = saved_snapshot(&page.view)?;
    state
        .store
        .put_document_with_images(&document, project_id.as_deref(), &[])?;
    state.store.document(&document.id, &document.revision)
}
fn saved_snapshot(source: &SnapshotView) -> Result<Document> {
    let mut document = Document {
        id: digest(source.url.as_bytes())[..24].into(),
        revision: digest(&serde_json::to_vec(&("web-original-v1", &source.segments, source.truncated)).map_err(|e| e.to_string())?),
        title: source.title.clone(), kind: "web".into(), source: source.url.clone(),
        created_at: now(), segments: source.segments.clone(), content: String::new(),
        warnings: vec!["元ページの本文を保存しました。コード・フォーム・非表示領域・フレームは含まず、元のサイトのレイアウトを再現するオフライン保存ではありません。".into()],
        language: None, ratio: 0, bilingual: false, position: None,
    };
    if document.title.trim().is_empty() {
        document.title = document.source.clone();
    }
    if source.truncated {
        document.warnings.push(
            "解析上限に達したため、保存した本文には元ページの一部が含まれていません。".into(),
        );
    }
    Ok(document)
}
pub fn shutdown() {
    native::shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_capture_keeps_its_warning_after_a_complete_capture_of_the_same_prose() {
        let store = crate::store::Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut source = SnapshotView {
            id: "snapshot".into(),
            session_id: "session".into(),
            generation: 1,
            title: "Page".into(),
            url: "https://example.org/".into(),
            segments: vec![],
            truncated: false,
            translations: HashMap::new(),
            job_id: None,
            error: None,
        };
        let complete = saved_snapshot(&source).unwrap();
        store
            .put_document_with_images(&complete, None, &[])
            .unwrap();
        source.truncated = true;
        let partial = saved_snapshot(&source).unwrap();
        store.put_document_with_images(&partial, None, &[]).unwrap();
        assert_ne!(complete.revision, partial.revision);
        assert!(store
            .document(&partial.id, &partial.revision)
            .unwrap()
            .warnings
            .iter()
            .any(|warning| warning.contains("解析上限")));
        assert!(!store
            .document(&complete.id, &complete.revision)
            .unwrap()
            .warnings
            .iter()
            .any(|warning| warning.contains("解析上限")));
    }

    #[test]
    fn navigation_rejects_credentials_files_and_local_literals() {
        for url in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "https://user:secret@example.org/",
            "http://127.1/private",
            "http://localhost/",
            "http://localhost./",
            "http://x.localhost./",
            "http://device.local/",
            "http://192.168.1.1/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::1]/",
        ] {
            assert!(navigation_url(url).is_err(), "accepted {url}");
        }
        assert_eq!(
            navigation_url("https://example.org/article#section").unwrap(),
            "https://example.org/article#section"
        );
    }

    #[test]
    fn browser_translation_accepts_only_eligible_snapshot_members() {
        let page = SnapshotView {
            id: "snapshot".into(),
            session_id: "session".into(),
            generation: 1,
            title: "Page".into(),
            url: "https://example.org/".into(),
            segments: vec![
                Segment {
                    id: "prose".into(),
                    block: 0,
                    order: 0,
                    text: "Read the page.".into(),
                    kind: "paragraph".into(),
                    eligible: true,
                    location: json!({"anchor":"web-v1-prose"}),
                },
                Segment {
                    id: "literal".into(),
                    block: 1,
                    order: 1,
                    text: "原文".into(),
                    kind: "paragraph".into(),
                    eligible: false,
                    location: json!({}),
                },
            ],
            truncated: false,
            translations: HashMap::new(),
            job_id: None,
            error: None,
        };
        assert!(selected_ids(&page, vec!["other-page".into()]).is_err());
        assert!(selected_ids(&page, vec!["literal".into()]).is_err());
        assert!(selected_ids(&page, vec!["prose".into(), "prose".into()]).is_err());
        assert!(selected_ids(&page, vec!["prose".into()])
            .unwrap()
            .contains("prose"));
    }

    #[test]
    fn ephemeral_cache_does_not_create_library_documents_or_bindings() {
        let store = crate::store::Store::open(std::path::Path::new(":memory:")).unwrap();
        store
            .cache_browser_translation("model-and-full-prompt", "日本語の本文")
            .unwrap();
        assert_eq!(
            store.cached("model-and-full-prompt").unwrap().as_deref(),
            Some("日本語の本文")
        );
        assert!(store.list().unwrap().is_empty());
        let count: i64 = store
            .0
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM translations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

#[cfg(not(windows))]
mod native {
    use super::*;
    pub async fn open(
        _: &AppHandle,
        _: String,
        _: String,
        _: std::path::PathBuf,
        _: BrowserBounds,
    ) -> Result<()> {
        Err("Web表示はWindows版で利用できます".into())
    }
    pub async fn close(_: &AppHandle, _: String) -> Result<()> {
        Ok(())
    }
    pub async fn status(_: &AppHandle, _: String) -> Result<BrowserStatus> {
        Err("Web表示はWindows版で利用できます".into())
    }
    pub async fn action(_: &AppHandle, _: String, _: BrowserAction) -> Result<()> {
        Err("Web表示はWindows版で利用できます".into())
    }
    pub async fn capture(_: &AppHandle, _: &str, _: u64) -> Result<CapturedPage> {
        Err("Web表示はWindows版で利用できます".into())
    }
    pub async fn display(_: &AppHandle, _: &str, _: u64, _: Value, _: bool) -> Result<Value> {
        Err("Web表示はWindows版で利用できます".into())
    }
    pub fn shutdown() {}
}
