use crate::{model::*, AppState};
use serde_json::{json, Value};
use tauri::State;
const MAX_FILE: u64 = 100 * 1024 * 1024;
#[derive(Clone, Default)]
pub struct ImportSource {
    pub fingerprint: Option<String>,
    pub folder: Option<std::path::PathBuf>,
}
#[tauri::command]
pub async fn read_file(
    path: String,
    include_images: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value> {
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
    let content = if ext == "pdf" {
        None
    } else {
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "UTF-8のテキストファイルに対応しています".to_string())?;
        if text.contains('\0') {
            return Err("バイナリファイルは開けません".into());
        }
        if text.len() > 5 * 1024 * 1024 {
            return Err("コード・テキストは5 MB以下にしてください".into());
        }
        Some(text)
    };
    let blob = state.root.join("snapshots").join(&fingerprint);
    let mut imports = state.imports.lock().await;
    let folder = if include_images.unwrap_or(false) {
        Some(
            imports
                .get(&source)
                .and_then(|s| s.folder.clone())
                .filter(|root| path.starts_with(root))
                .ok_or("フォルダーを選択し直してください")?,
        )
    } else {
        None
    };
    if !blob.exists() {
        tokio::fs::write(&blob, &bytes)
            .await
            .map_err(|e| e.to_string())?;
    }
    imports.insert(
        source.clone(),
        ImportSource {
            fingerprint: Some(fingerprint),
            folder,
        },
    );
    drop(imports);
    if ext == "pdf" {
        return Ok(json!({"path":source,"name":name,"kind":"pdf","bytes":bytes}));
    }
    Ok(
        json!({"path":source,"name":name,"kind":if ["txt","md","markdown","rst"].contains(&ext.as_str()){"text"}else{"code"},"content":content}),
    )
}
#[tauri::command]
pub async fn list_folder(path: String, state: State<'_, AppState>) -> Result<Vec<String>> {
    let root = tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| e.to_string())?;
    let files = scan_folder(path).await?;
    let mut imports = state.imports.lock().await;
    for path in &files {
        if ["md", "markdown"].contains(
            &std::path::Path::new(path)
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase()
                .as_str(),
        ) {
            imports.entry(path.clone()).or_default().folder = Some(root.clone());
        }
    }
    Ok(files)
}
async fn scan_folder(path: String) -> Result<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !path.is_dir() {
            return Err("フォルダーを選択してください".into());
        }
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
                "cs", "json", "html", "css", "sh", "md", "markdown", "toml", "yaml", "yml", "txt",
                "pdf",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_markdown_segmentation_creates_a_separate_revision() {
        let segment = Segment {
            id: "m0s0".into(),
            block: 0,
            order: 0,
            text: "Read the value.".into(),
            kind: "paragraph".into(),
            eligible: true,
            location: json!({"line":1,"endLine":1}),
        };
        let original =
            markdown_revision("Read the value.", std::slice::from_ref(&segment)).unwrap();
        assert_ne!(original, digest(b"Read the value."));
        assert_eq!(
            original,
            markdown_revision("Read the value.", std::slice::from_ref(&segment)).unwrap()
        );
        let changed = Segment {
            text: "Changed extraction.".into(),
            ..segment
        };
        assert_ne!(
            original,
            markdown_revision("Read the value.", &[changed]).unwrap()
        );
    }

    #[tokio::test]
    async fn folder_import_finds_nested_materials_but_excludes_dependencies_and_binary_assets() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["nested", "node_modules", ".git", "target", ".tools"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        for name in [
            "book.pdf",
            "nested/code.rs",
            "nested/notes.md",
            "image.png",
            "node_modules/index.js",
            ".git/config.txt",
            "target/build.rs",
            ".tools/setup.txt",
        ] {
            std::fs::write(dir.path().join(name), "Original text").unwrap();
        }
        let paths = scan_folder(dir.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let names: Vec<_> = paths
            .iter()
            .map(|p| {
                std::path::Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert_eq!(names, ["book.pdf", "code.rs", "notes.md"]);
        assert!(
            scan_folder(dir.path().join("book.pdf").to_string_lossy().to_string())
                .await
                .is_err()
        );
    }
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
pub async fn save_document(
    mut document: Document,
    project_id: Option<String>,
    image_urls: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Document> {
    let _gate = state.mutation_gate.lock().await;
    validate_segments(&document.segments)?;
    document.id = digest(document.source.as_bytes())[..24].to_string();
    let mut imports = state.imports.lock().await;
    document.revision = if document.kind == "web" {
        digest(
            serde_json::to_string(&document.segments)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
    } else {
        imports
            .get(&document.source)
            .and_then(|s| s.fingerprint.clone())
            .ok_or("ファイルを再選択してください")?
    };
    let mut images = Vec::new();
    if document.kind == "text" && document.language.as_deref() == Some("markdown") {
        document.revision = markdown_revision(&document.content, &document.segments)?;
        if let Some(folder) = imports.get(&document.source).and_then(|s| s.folder.clone()) {
            let source = document.source.clone();
            let urls = image_urls.unwrap_or_default();
            let (loaded, warnings) = tokio::task::spawn_blocking(move || {
                crate::images::load(&folder, std::path::Path::new(&source), urls)
            })
            .await
            .map_err(|e| e.to_string())?;
            images = loaded;
            document.warnings.extend(warnings);
            if !images.is_empty() {
                document.revision = crate::images::revision(&document.revision, &images)?;
            }
        }
    }
    document.created_at = now();
    state
        .store
        .put_document_with_images(&document, project_id.as_deref(), &images)?;
    imports.remove(&document.source);
    state.store.document(&document.id, &document.revision)
}

fn validate_segments(segments: &[Segment]) -> Result<()> {
    if segments.len() > 100_000 {
        return Err("文の数が多すぎます".into());
    }
    let mut seen = std::collections::HashSet::new();
    if segments.iter().any(|s| !seen.insert(&s.id)) {
        return Err("文IDが重複しています".into());
    }
    Ok(())
}

fn markdown_revision(content: &str, segments: &[Segment]) -> Result<String> {
    // Reusing the old file hash would attach old conversations to different sentence IDs.
    let snapshot =
        serde_json::to_vec(&("markdown-v1", content, segments)).map_err(|e| e.to_string())?;
    Ok(digest(&snapshot))
}

#[tauri::command]
pub async fn upgrade_markdown(
    id: String,
    revision: String,
    segments: Vec<Segment>,
    state: State<'_, AppState>,
) -> Result<Document> {
    let _gate = state.mutation_gate.lock().await;
    let mut document = state.store.document(&id, &revision)?;
    let extension = std::path::Path::new(&document.source)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if !["text", "code"].contains(&document.kind.as_str())
        || !["md", "markdown"].contains(&extension.as_str())
    {
        return Err("Markdown資料を選択してください".into());
    }
    validate_segments(&segments)?;
    let old_position = document
        .segments
        .iter()
        .find(|s| Some(&s.id) == document.position.as_ref())
        .and_then(|s| s.location["line"].as_u64());
    document.kind = "text".into();
    document.language = Some("markdown".into());
    document.revision = markdown_revision(&document.content, &segments)?;
    let images = state.store.images(&id, &revision)?;
    if !images.is_empty() {
        document.revision = crate::images::revision(&document.revision, &images)?;
    }
    document.segments = segments;
    document.position = old_position.and_then(|line| {
        document
            .segments
            .iter()
            .min_by_key(|s| {
                let start = s.location["line"].as_u64().unwrap_or(1);
                let end = s.location["endLine"].as_u64().unwrap_or(start);
                if line < start {
                    start - line
                } else {
                    line.saturating_sub(end)
                }
            })
            .map(|s| s.id.clone())
    });
    document.created_at = now();
    state.store.upgrade_document(&document, &revision)?;
    state.store.document(&document.id, &document.revision)
}

fn snapshot_key(document: &Document) -> Option<String> {
    if document.kind == "web" {
        return None;
    }
    let key = if document.kind == "pdf" {
        document.revision.clone()
    } else {
        digest(document.content.as_bytes())
    };
    (key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())).then_some(key)
}

#[tauri::command]
pub async fn delete_document(
    id: String,
    revision: String,
    all_versions: bool,
    state: State<'_, AppState>,
) -> Result<Value> {
    let _gate = state.mutation_gate.lock().await;
    state.store.document(&id, &revision)?;
    state.cancel_and_wait(None).await?;
    let imports = state.imports.lock().await;
    let deleted = state.store.delete_document(&id, &revision, all_versions)?;
    let remaining = state.store.list()?;
    let mut retained: std::collections::HashSet<String> =
        remaining.iter().filter_map(snapshot_key).collect();
    retained.extend(imports.values().filter_map(|s| s.fingerprint.clone()));
    let candidates: std::collections::HashSet<String> =
        deleted.iter().filter_map(snapshot_key).collect();
    let mut cleanup_errors = Vec::new();
    for key in candidates.difference(&retained) {
        if let Err(error) = tokio::fs::remove_file(state.root.join("snapshots").join(key)).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                cleanup_errors.push(error.to_string());
            }
        }
    }
    Ok(
        json!({"deleted":deleted.iter().map(|d| json!({"id":d.id,"revision":d.revision})).collect::<Vec<_>>(),"cleanupErrors":cleanup_errors}),
    )
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
