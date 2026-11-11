use crate::{model::*, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Component, Path, PathBuf},
};
use tauri::State;
#[cfg(test)]
#[path = "images_tests.rs"]
mod tests;

const MAX_IMAGE: u64 = 10 * 1024 * 1024;
const MAX_TOTAL: usize = 40 * 1024 * 1024;

pub struct DocumentImage {
    pub url: String,
    pub mime: String,
    pub data: Vec<u8>,
}

fn resolve(root: &Path, source: &Path, input: &str) -> Result<PathBuf> {
    if input.is_empty() || input.starts_with(['/', '\\']) || input.contains([':', '\\', '\0']) {
        return Err("フォルダー内の相対パスだけに対応しています".into());
    }
    let base = url::Url::from_file_path(source).map_err(|_| "Markdownのパスが不正です")?;
    let target = base.join(input).map_err(|_| "画像の参照先が不正です")?;
    let path = target
        .to_file_path()
        .map_err(|_| "ローカル画像を指定してください")?;
    if path
        .components()
        .any(|c| matches!(c,Component::Normal(part) if part.to_string_lossy().contains(':')))
    {
        return Err("画像の参照先が不正です".into());
    }
    let plain_root = url::Url::from_directory_path(root)
        .map_err(|_| "フォルダーのパスが不正です")?
        .to_file_path()
        .map_err(|_| "フォルダーのパスが不正です")?;
    let relative = path
        .strip_prefix(&plain_root)
        .map_err(|_| "選択したフォルダーの外は読み込めません")?;
    let mut candidate = root.to_path_buf();
    // Canonicalizing first can follow a junction to a network share before its scope is checked.
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("画像の参照先が不正です".into());
        }
        candidate.push(component);
        let metadata = std::fs::symlink_metadata(&candidate).map_err(|_| "画像が見つかりません")?;
        #[cfg(windows)]
        let link = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let link = metadata.file_type().is_symlink();
        if link {
            return Err("画像のシンボリックリンク・ジャンクション参照には対応していません".into());
        }
    }
    let path = std::fs::canonicalize(path).map_err(|_| "画像が見つかりません")?;
    if !source.starts_with(root) || !path.starts_with(root) {
        return Err("選択したフォルダーの外は読み込めません".into());
    }
    Ok(path)
}

fn image(root: &Path, source: &Path, url: String, remaining: usize) -> Result<DocumentImage> {
    let path = resolve(root, source, &url)?;
    let file = std::fs::File::open(path).map_err(|_| "画像を開けません")?;
    let metadata = file.metadata().map_err(|_| "画像の情報を取得できません")?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE {
        return Err("画像は1枚10 MB以下にしてください".into());
    }
    if metadata.len() > remaining as u64 {
        return Err("資料1件の画像合計は40 MB以下にしてください".into());
    }
    let mut data = Vec::new();
    file.take(MAX_IMAGE.min(remaining as u64) + 1)
        .read_to_end(&mut data)
        .map_err(|_| "画像を読み込めません")?;
    if data.len() as u64 > MAX_IMAGE {
        return Err("画像は1枚10 MB以下にしてください".into());
    }
    if data.len() > remaining {
        return Err("資料1件の画像合計は40 MB以下にしてください".into());
    }
    let mime = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif"
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        "image/webp"
    }
    // SVG and HTML can refer to active content or external resources; store only raster images.
    else {
        return Err("PNG・JPEG・GIF・WebPの画像に対応しています".into());
    };
    Ok(DocumentImage {
        url,
        mime: mime.into(),
        data,
    })
}

pub fn load(root: &Path, source: &Path, urls: Vec<String>) -> (Vec<DocumentImage>, Vec<String>) {
    let mut images = Vec::new();
    let mut warnings = Vec::new();
    let urls: BTreeSet<_> = urls.into_iter().collect();
    if urls.len() > 256 {
        return (
            images,
            vec!["画像の参照が256件を超えるため取り込みませんでした".into()],
        );
    }
    let mut total = 0;
    for url in urls {
        match image(root, source, url.clone(), MAX_TOTAL - total) {
            Ok(image) => {
                total += image.data.len();
                images.push(image);
            }
            Err(error) => warnings.push(format!("画像 {url}: {error}")),
        }
    }
    (images, warnings)
}

pub fn revision(base: &str, images: &[DocumentImage]) -> Result<String> {
    let mut manifest: Vec<_> = images
        .iter()
        .map(|image| (&image.url, &image.mime, digest(&image.data)))
        .collect();
    manifest.sort();
    Ok(digest(
        &serde_json::to_vec(&("markdown-images-v1", base, manifest)).map_err(|e| e.to_string())?,
    ))
}

#[tauri::command]
pub fn get_document_images(
    id: String,
    revision: String,
    state: State<'_, AppState>,
) -> Result<std::collections::BTreeMap<String, String>> {
    Ok(state
        .store
        .images(&id, &revision)?
        .into_iter()
        .map(|image| {
            (
                image.url,
                format!("data:{};base64,{}", image.mime, STANDARD.encode(image.data)),
            )
        })
        .collect())
}
