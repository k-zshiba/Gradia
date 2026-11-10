use super::*;
use crate::store::Store;
use serde_json::json;

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("book");
    std::fs::create_dir_all(root.join("chapters")).unwrap();
    std::fs::create_dir_all(root.join("images")).unwrap();
    std::fs::write(root.join("chapters/reading.md"), "Original Markdown").unwrap();
    let source = std::fs::canonicalize(root.join("chapters/reading.md")).unwrap();
    (temp, std::fs::canonicalize(root).unwrap(), source)
}
fn png() -> Vec<u8> {
    b"\x89PNG\r\n\x1a\nfixture".to_vec()
}

#[test]
fn relative_and_encoded_image_paths_resolve_inside_the_selected_folder_only() {
    let (temp, root, source) = fixture();
    std::fs::write(root.join("images/図 one.png"), png()).unwrap();
    std::fs::create_dir(temp.path().join("book-other")).unwrap();
    std::fs::write(temp.path().join("book-other/secret.png"), png()).unwrap();
    let good = "../images/図%20one.png";
    let bad = [
        "../../book-other/secret.png",
        "https://example.org/image.png",
        "//server/share/image.png",
        "file:///etc/passwd",
        "data:image/png;base64,AA==",
        "C:/secret.png",
        "C:secret.png",
        "../images/図%20one.png%3Asecret",
        "missing.png",
    ];
    let (images, warnings) = load(
        &root,
        &source,
        std::iter::once(good.to_string())
            .chain(std::iter::once(good.to_string()))
            .chain(bad.iter().map(|s| s.to_string()))
            .collect(),
    );
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].url, good);
    assert_eq!(images[0].mime, "image/png");
    assert_eq!(images[0].data, png());
    assert_eq!(warnings.len(), bad.len());
    assert!(warnings.iter().any(|s| s.contains("フォルダーの外")));
    assert_eq!(
        std::fs::read_to_string(&source).unwrap(),
        "Original Markdown"
    );
    assert_eq!(
        std::fs::read(temp.path().join("book-other/secret.png")).unwrap(),
        png()
    );
}

#[test]
fn scripts_and_non_images_are_rejected_even_with_an_image_extension() {
    let (_temp, root, source) = fixture();
    for (name, bytes) in [
        ("image.png", b"<svg onload='alert(1)'/>".as_slice()),
        (
            "page.jpg",
            b"<html><script>alert(1)</script></html>".as_slice(),
        ),
        ("icon.gif", b"GIF89a fixture".as_slice()),
        ("photo.webp", b"RIFF0000WEBPfixture".as_slice()),
        ("photo.jpg", b"\xff\xd8\xfffixture".as_slice()),
    ] {
        std::fs::write(root.join("images").join(name), bytes).unwrap();
    }
    let (images, warnings) = load(
        &root,
        &source,
        [
            "image.png",
            "page.jpg",
            "icon.gif",
            "photo.webp",
            "photo.jpg",
        ]
        .map(|name| format!("../images/{name}"))
        .to_vec(),
    );
    assert_eq!(images.len(), 3);
    assert_eq!(warnings.len(), 2);
    assert!(images
        .iter()
        .all(|image| ["image/gif", "image/webp", "image/jpeg"].contains(&image.mime.as_str())));
}

#[test]
fn image_size_total_budget_and_reference_limits_are_enforced_before_loading() {
    let (_temp, root, source) = fixture();
    std::fs::File::create(root.join("images/huge.png"))
        .unwrap()
        .set_len(MAX_IMAGE + 1)
        .unwrap();
    let (images, warnings) = load(&root, &source, vec!["../images/huge.png".into()]);
    assert!(images.is_empty());
    assert!(warnings[0].contains("10 MB"));
    std::fs::write(root.join("images/small.png"), png()).unwrap();
    assert!(image(&root, &source, "../images/small.png".into(), 4)
        .err()
        .unwrap()
        .contains("40 MB"));
    let (images, warnings) = load(
        &root,
        &source,
        (0..257).map(|i| format!("{i}.png")).collect(),
    );
    assert!(images.is_empty());
    assert!(warnings[0].contains("256"));
}

#[test]
fn image_revisions_preserve_order_independence_and_detect_changed_bytes() {
    let mut images = vec![
        DocumentImage {
            url: "a.png".into(),
            mime: "image/png".into(),
            data: png(),
        },
        DocumentImage {
            url: "b.png".into(),
            mime: "image/png".into(),
            data: png(),
        },
    ];
    let original = revision("text-version", &images).unwrap();
    images.reverse();
    assert_eq!(revision("text-version", &images).unwrap(), original);
    images[0].data.push(1);
    assert_ne!(revision("text-version", &images).unwrap(), original);
    assert_ne!(revision("new-text-version", &images).unwrap(), original);
}

fn document(version: &str) -> Document {
    serde_json::from_value(json!({"id":"book","revision":version,"title":"Book","source":"book.md","kind":"text","language":"markdown","content":"![図](a.png)","segments":[],"warnings":[],"ratio":0,"position":null})).unwrap()
}
#[test]
fn image_copies_survive_restart_upgrade_and_delete_with_their_document_version() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let store = Store::open(&path).unwrap();
    let mut images = vec![DocumentImage {
        url: "a.png".into(),
        mime: "image/png".into(),
        data: png(),
    }];
    store
        .put_document_with_images(&document("old"), None, &images)
        .unwrap();
    images[0].data.push(1);
    store
        .put_document_with_images(&document("new"), None, &images)
        .unwrap();
    assert!(store
        .put_document_with_images(&document("invalid"), Some("missing-project"), &images)
        .is_err());
    assert!(store.images("book", "invalid").unwrap().is_empty());
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.images("book", "old").unwrap()[0].data, png());
    assert_eq!(store.images("book", "new").unwrap()[0].data, images[0].data);
    store
        .upgrade_document(&document("upgraded"), "old")
        .unwrap();
    assert_eq!(store.images("book", "upgraded").unwrap()[0].data, png());
    store.delete_document("book", "old", false).unwrap();
    assert!(store.images("book", "old").unwrap().is_empty());
    assert_eq!(store.images("book", "new").unwrap().len(), 1);
    store.delete_document("book", "new", true).unwrap();
    assert!(store.images("book", "upgraded").unwrap().is_empty());
}

#[test]
fn an_existing_library_gains_image_storage_without_losing_its_documents() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let store = Store::open(&path).unwrap();
    store.put_document(&document("existing"), None).unwrap();
    store
        .0
        .lock()
        .unwrap()
        .execute("DROP TABLE document_images", [])
        .unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.document("book", "existing").unwrap().content,
        "![図](a.png)"
    );
    assert!(store.images("book", "existing").unwrap().is_empty());
}
