use super::*;

fn document(revision: &str) -> Document {
    serde_json::from_value(json!({"id":"book","revision":revision,"title":"Book","kind":"text","source":"book.txt","segments":[],"content":"Original","warnings":[],"ratio":0,"position":null})).unwrap()
}
fn message(id: &str, session: Option<&str>) -> ChatMessage {
    serde_json::from_value(json!({"id":id,"sessionId":session,"role":"user","text":format!("Question {id}"),"status":"completed","references":[],"createdAt":1})).unwrap()
}

#[test]
fn sessions_keep_messages_and_account_threads_separate_on_the_same_revision() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    store.put_document(&document("v1"), None).unwrap();
    store.put_document(&document("v2"), None).unwrap();
    let first = store.create_session("book", "v1", false).unwrap();
    let second = store.create_session("book", "v1", false).unwrap();
    store
        .0
        .lock()
        .unwrap()
        .execute(
            "UPDATE chat_sessions SET created=1 WHERE doc='book' AND revision='v1'",
            [],
        )
        .unwrap();
    let other = store.create_session("book", "v2", false).unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(
        store.create_session("book", "v1", true).unwrap().id,
        first.id
    );
    for (session, id) in [(&first, "first"), (&second, "second"), (&other, "other")] {
        let rev = if id == "other" { "v2" } else { "v1" };
        store
            .save_message("book", rev, &message(id, Some(&session.id)))
            .unwrap();
        store.save_session_thread(&session.id, "alice", id).unwrap();
    }
    store
        .save_session_thread(&first.id, "bob", "bob-thread")
        .unwrap();
    assert_eq!(
        store.session_history("book", "v1", &first.id).unwrap()[0].text,
        "Question first"
    );
    assert_eq!(
        store.session_history("book", "v1", &second.id).unwrap()[0].text,
        "Question second"
    );
    assert_eq!(
        store.session_thread(&first.id, "alice").unwrap().as_deref(),
        Some("first")
    );
    assert_eq!(
        store
            .session_thread(&second.id, "alice")
            .unwrap()
            .as_deref(),
        Some("second")
    );
    assert_eq!(
        store.session_thread(&first.id, "bob").unwrap().as_deref(),
        Some("bob-thread")
    );
    assert_eq!(store.sessions("book", "v1").unwrap().len(), 2);
    assert!(store
        .sessions("book", "v1")
        .unwrap()
        .iter()
        .any(|s| s.id == first.id && s.title == "Question first"));
    assert!(store.session_history("book", "v2", &first.id).is_err());
    assert!(store
        .save_message("book", "v2", &message("forged", Some(&first.id)))
        .is_err());
    assert!(store.create_session("missing", "v1", false).is_err());
    assert!(store
        .save_session_thread("missing", "alice", "lost")
        .is_err());
}

#[test]
fn migration_retains_legacy_history_and_threads_once_and_recovers_interrupted_answers() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.db");
    let store = Store::open(&path).unwrap();
    store.put_document(&document("v1"), None).unwrap();
    store.put_document(&document("v2"), None).unwrap();
    let mut old = message("old", None);
    old.role = "assistant".into();
    old.status = "running".into();
    store.save_message("book", "v1", &old).unwrap();
    store
        .save_thread("book", "v1", "alice", "legacy-thread")
        .unwrap();
    assert_eq!(
        store.thread("book", "v1", "alice").unwrap().as_deref(),
        Some("legacy-thread")
    );
    store
        .save_thread("book", "v2", "bob", "thread-without-message")
        .unwrap();
    store
        .0
        .lock()
        .unwrap()
        .pragma_update(None, "user_version", 2)
        .unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    let first = store.sessions("book", "v1").unwrap().remove(0);
    let second = store.sessions("book", "v2").unwrap().remove(0);
    assert_eq!(first.title, "以前の会話");
    let history = store.session_history("book", "v1", &first.id).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].text, "Question old");
    assert_eq!(history[0].status, "interrupted");
    assert_eq!(history[0].session_id.as_deref(), Some(first.id.as_str()));
    assert_eq!(
        store.session_thread(&first.id, "alice").unwrap().as_deref(),
        Some("legacy-thread")
    );
    assert_eq!(
        store.session_thread(&second.id, "bob").unwrap().as_deref(),
        Some("thread-without-message")
    );
    assert!(store.history("book", "v1").unwrap().is_empty());
    drop(store);
    let restored = Store::open(&path).unwrap();
    assert_eq!(restored.sessions("book", "v1").unwrap().len(), 1);
    assert_eq!(restored.sessions("book", "v1").unwrap()[0].id, first.id);
    assert_eq!(
        restored
            .session_history("book", "v1", &first.id)
            .unwrap()
            .len(),
        1
    );
}
