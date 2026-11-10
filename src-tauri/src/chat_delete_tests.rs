use super::*;
use serde_json::json;

#[test]
fn document_deletion_also_removes_session_history_and_resume_ids() {
    let state = test_state(PathBuf::new());
    let doc: Document = serde_json::from_value(json!({"id":"book","revision":"v1","title":"Book","source":"book.txt","kind":"text","content":"Original","segments":[],"warnings":[],"ratio":0,"position":null})).unwrap();
    state.store.put_document(&doc, None).unwrap();
    let session = state.store.create_session("book", "v1", false).unwrap();
    let message: ChatMessage = serde_json::from_value(json!({"id":"answer","sessionId":session.id,"role":"assistant","text":"Answer","status":"completed","references":[],"createdAt":1})).unwrap();
    state.store.save_message("book", "v1", &message).unwrap();
    state
        .store
        .save_session_thread(&session.id, "account", "thread")
        .unwrap();
    state.store.delete_document("book", "v1", false).unwrap();
    assert!(state.store.sessions("book", "v1").unwrap().is_empty());
    assert!(state
        .store
        .session_thread(&session.id, "account")
        .unwrap()
        .is_none());
    assert!(state.store.save_message("book", "v1", &message).is_err());
    let rows: usize = state
        .store
        .0
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM session_messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn deleting_a_conversation_waits_for_its_answer_and_preserves_other_work() {
    let state = std::sync::Arc::new(test_state(PathBuf::new()));
    let doc: Document = serde_json::from_value(json!({"id":"book","revision":"v1","title":"Book","source":"book.txt","kind":"text","content":"Original","segments":[],"warnings":[],"ratio":0,"position":null})).unwrap();
    state.store.put_document(&doc, None).unwrap();
    let first = state.store.create_session("book", "v1", false).unwrap();
    let other = state.store.create_session("book", "v1", false).unwrap();
    let message: ChatMessage = serde_json::from_value(json!({"id":"answer","sessionId":first.id,"role":"assistant","text":"Partial","status":"running","references":[],"createdAt":1})).unwrap();
    state.store.save_message("book", "v1", &message).unwrap();
    state
        .store
        .save_session_thread(&first.id, "account", "thread-one")
        .unwrap();
    state
        .store
        .save_session_thread(&other.id, "account", "thread-two")
        .unwrap();
    state
        .store
        .translation("book", "v1", "s1", "cache", "訳文")
        .unwrap();
    let token = CancellationToken::new();
    let unrelated = CancellationToken::new();
    state
        .jobs
        .lock()
        .await
        .insert("answer".into(), token.clone());
    state
        .jobs
        .lock()
        .await
        .insert("translation".into(), unrelated.clone());
    let worker = state.clone();
    let saved = message.clone();
    tokio::spawn(async move {
        token.cancelled().await;
        worker.store.save_message("book", "v1", &saved).unwrap();
        worker.jobs.lock().await.remove("answer");
    });
    assert!(state
        .delete_chat("book", "wrong-revision", &first.id)
        .await
        .is_err());
    state.delete_chat("book", "v1", &first.id).await.unwrap();
    assert!(!unrelated.is_cancelled());
    assert!(state.store.document("book", "v1").is_ok());
    assert_eq!(
        state.store.cached("cache").unwrap().as_deref(),
        Some("訳文")
    );
    assert_eq!(state.store.sessions("book", "v1").unwrap()[0].id, other.id);
    assert!(state
        .store
        .session_history("book", "v1", &first.id)
        .is_err());
    assert!(state
        .store
        .session_thread(&first.id, "account")
        .unwrap()
        .is_none());
    assert_eq!(
        state
            .store
            .session_thread(&other.id, "account")
            .unwrap()
            .as_deref(),
        Some("thread-two")
    );
    assert!(state.store.save_message("book", "v1", &message).is_err());
    assert!(state
        .store
        .save_session_thread(&first.id, "account", "late")
        .is_err());
    state.delete_chat("book", "v1", &other.id).await.unwrap();
    assert!(state.store.sessions("book", "v1").unwrap().is_empty());
    let fresh = state.store.create_session("book", "v1", false).unwrap();
    assert!(state
        .store
        .session_history("book", "v1", &fresh.id)
        .unwrap()
        .is_empty());
    assert!(state
        .store
        .session_thread(&fresh.id, "account")
        .unwrap()
        .is_none());
}
