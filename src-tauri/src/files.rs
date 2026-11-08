use crate::{model::*, AppState};
use serde_json::{json, Value};
use tauri::State;
const MAX_FILE: u64 = 100 * 1024 * 1024;
#[tauri::command]
pub async fn read_file(path: String, state: State<'_, AppState>) -> Result<Value> {
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|e| e.to_string())?;
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return Err("100 MB以下のファイルを選択してください".into());
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    let source = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let fingerprint = digest(&bytes);
    let blob = state.root.join("snapshots").join(&fingerprint);
    if !blob.exists() {
        tokio::fs::write(&blob, &bytes)
            .await
            .map_err(|e| e.to_string())?;
    }
    state
        .imports
        .lock()
        .await
        .insert(source.clone(), fingerprint);
    if ext == "pdf" {
        return Ok(json!({"path":source,"name":name,"kind":"pdf","bytes":bytes}));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| "UTF-8のテキストファイルに対応しています".to_string())?;
    if text.contains('\0') {
        return Err("バイナリファイルは開けません".into());
    }
    if text.len() > 5 * 1024 * 1024 {
        return Err("コード・テキストは5 MB以下にしてください".into());
    }
    Ok(
        json!({"path":source,"name":name,"kind":if ["txt","md","rst"].contains(&ext.as_str()){"text"}else{"code"},"content":text}),
    )
}
#[tauri::command]
pub async fn list_folder(path: String) -> Result<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in walkdir::WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                ![".git", "node_modules", "target", ".tools", ".venv"]
                    .contains(&e.file_name().to_string_lossy().as_ref())
            })
        {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let ext = entry
                .path()
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase();
            if [
                "rs", "py", "js", "jsx", "ts", "tsx", "c", "h", "cpp", "hpp", "cc", "java", "go",
                "cs", "json", "html", "css", "sh", "md", "toml", "yaml", "yml", "txt", "pdf",
            ]
            .contains(&ext.as_str())
            {
                out.push(entry.path().to_string_lossy().to_string());
            }
            if out.len() >= 2000 {
                return Err(
                    "対象ファイルが2000件以上あります。サブフォルダーを選択してください".into(),
                );
            }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn http_url(input: &str) -> Result<url::Url> {
    let url = url::Url::parse(input).map_err(|_| "URLが正しくありません".to_string())?;
    if !["https", "http"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("http/httpsのURLを指定してください".into());
    }
    Ok(url)
}
#[tauri::command]
pub async fn fetch_page(url: String) -> Result<Value> {
    crate::web::fetch_public_page(&url).await
}
#[tauri::command]
pub async fn save_document(mut document: Document, state: State<'_, AppState>) -> Result<Document> {
    if document.segments.len() > 100_000 {
        return Err("文の数が多すぎます".into());
    }
    let mut seen = std::collections::HashSet::new();
    if document.segments.iter().any(|s| !seen.insert(&s.id)) {
        return Err("文IDが重複しています".into());
    }
    document.id = digest(document.source.as_bytes())[..24].to_string();
    document.revision = if document.kind == "web" {
        digest(
            serde_json::to_string(&document.segments)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
    } else {
        state
            .imports
            .lock()
            .await
            .get(&document.source)
            .cloned()
            .ok_or("ファイルを再選択してください")?
    };
    document.created_at = now();
    state.store.put_document(&document)?;
    state.store.document(&document.id, &document.revision)
}
#[tauri::command]
pub async fn read_snapshot(
    id: String,
    revision: String,
    state: State<'_, AppState>,
) -> Result<Vec<u8>> {
    let doc = state.store.document(&id, &revision)?;
    if doc.kind != "pdf" {
        return Err("PDFではありません".into());
    }
    if !revision.chars().all(|c| c.is_ascii_hexdigit()) || revision.len() != 64 {
        return Err("資料の版が不正です".into());
    }
    tokio::fs::read(state.root.join("snapshots").join(revision))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_url(url: String) -> Result<()> {
    http_url(&url)?;
    webbrowser::open(&url).map_err(|e| e.to_string())
}

pub fn hidden(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let _ = command;
}
pub fn executable(path: &str) -> Result<&str> {
    if path.trim().is_empty() {
        Err("実行ファイルのパスを設定してください".into())
    } else {
        Ok(path)
    }
}
