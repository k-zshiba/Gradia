use super::*;
fn document(revision: &str) -> Document {
    serde_json::from_value(json!({"id":"book","revision":revision,"title":"Book","kind":"text","source":"book.md","segments":[],"content":"Original","warnings":[],"ratio":0,"position":null})).unwrap()
}

#[test]
fn deleting_one_version_retains_other_versions_and_shared_translation_cache() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.create_project("Reading").unwrap();
    for version in ["old", "new"] {
        store
            .put_document(&document(version), Some(&project.id))
            .unwrap();
        store
            .translation("book", version, "s1", "shared", "共有訳")
            .unwrap();
        store
            .translation("book", version, "s2", version, "版ごとの訳")
            .unwrap();
        let message: ChatMessage = serde_json::from_value(json!({"id":version,"role":"user","text":"Question","status":"completed","references":[],"createdAt":1})).unwrap();
        store.save_message("book", version, &message).unwrap();
        store
            .save_thread("book", version, "account", version)
            .unwrap();
    }
    store.delete_document("book", "old", false).unwrap();
    assert!(store.document("book", "old").is_err());
    assert!(store.document("book", "new").is_ok());
    assert_eq!(store.cached("shared").unwrap().as_deref(), Some("共有訳"));
    assert_eq!(store.cached("old").unwrap(), None);
    assert_eq!(store.projects().unwrap()[0].document_keys, vec!["book:new"]);
    assert_eq!(store.history("book", "new").unwrap().len(), 1);
    assert_eq!(store.thread("book", "old", "account").unwrap(), None);
    assert!(store.history("book", "old").unwrap().is_empty());
    assert!(store
        .translation("book", "old", "s1", "late", "遅れた訳")
        .is_err());
    let late: ChatMessage = serde_json::from_value(json!({"id":"late","role":"assistant","text":"Late","status":"completed","references":[],"createdAt":2})).unwrap();
    assert!(store.save_message("book", "old", &late).is_err());
    assert!(store.save_thread("book", "old", "account", "late").is_err());
    store.delete_document("book", "new", true).unwrap();
    assert!(store.list().unwrap().is_empty());
    assert!(store.cached("shared").unwrap().is_none());
    assert!(store.projects().unwrap()[0].document_keys.is_empty());
}

#[test]
fn deleting_all_versions_does_not_delete_another_document_or_the_project() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.create_project("Reading").unwrap();
    for version in ["v1", "v2"] {
        store
            .put_document(&document(version), Some(&project.id))
            .unwrap();
    }
    let mut other = document("v1");
    other.id = "other".into();
    store.put_document(&other, Some(&project.id)).unwrap();
    assert_eq!(store.delete_document("book", "v2", true).unwrap().len(), 2);
    assert_eq!(store.list().unwrap()[0].id, "other");
    assert_eq!(store.projects().unwrap()[0].document_keys, vec!["other:v1"]);
}
