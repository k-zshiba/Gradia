use super::*;
#[cfg(test)]
#[path = "store_chat_tests.rs"]
mod tests;

pub(super) fn migrate(db: &mut Connection) -> Result<()> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS chat_sessions(id TEXT PRIMARY KEY,doc TEXT NOT NULL,revision TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,
        FOREIGN KEY(doc,revision) REFERENCES documents(id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS sessions_document ON chat_sessions(doc,revision,created);
      CREATE TABLE IF NOT EXISTS session_messages(id TEXT PRIMARY KEY,session TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,
        FOREIGN KEY(session) REFERENCES chat_sessions(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS messages_session ON session_messages(session,created);
      CREATE TABLE IF NOT EXISTS session_threads(session TEXT NOT NULL,account TEXT NOT NULL,thread TEXT NOT NULL,PRIMARY KEY(session,account),
        FOREIGN KEY(session) REFERENCES chat_sessions(id) ON DELETE CASCADE);").map_err(|e| e.to_string())?;
    let version: u32 = tx
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version < 3 {
        let groups = {
            let mut q = tx.prepare("SELECT d.id,d.revision FROM documents d WHERE EXISTS(SELECT 1 FROM chats c WHERE c.doc=d.id AND c.revision=d.revision) OR EXISTS(SELECT 1 FROM threads t WHERE t.doc=d.id AND t.revision=d.revision)").map_err(|e| e.to_string())?;
            let rows = q
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for (doc, rev) in groups {
            let session = create(&tx, &doc, &rev, "以前の会話")?;
            tx.execute("INSERT INTO session_messages SELECT id,?3,json_set(data,'$.sessionId',?3),created FROM chats WHERE doc=?1 AND revision=?2",params![doc,rev,session.id]).map_err(|e|e.to_string())?;
            tx.execute("INSERT INTO session_threads SELECT ?3,account,thread FROM threads WHERE doc=?1 AND revision=?2",params![doc,rev,session.id]).map_err(|e|e.to_string())?;
            tx.execute(
                "DELETE FROM chats WHERE doc=?1 AND revision=?2",
                params![doc, rev],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM threads WHERE doc=?1 AND revision=?2",
                params![doc, rev],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.pragma_update(None, "user_version", 3)
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn create(db: &Connection, doc: &str, rev: &str, title: &str) -> Result<ChatSession> {
    let session = ChatSession {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.into(),
        created_at: now(),
        updated_at: now(),
    };
    db.execute("INSERT INTO chat_sessions SELECT ?1,?2,?3,?4,?5,?6 FROM documents WHERE id=?2 AND revision=?3", params![session.id,doc,rev,session.title,session.created_at,session.updated_at]).map_err(|e|e.to_string()).and_then(written)?;
    Ok(session)
}
fn written(rows: usize) -> Result<usize> {
    if rows == 0 {
        Err("資料または会話が見つかりません".into())
    } else {
        Ok(rows)
    }
}
fn row_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSession> {
    Ok(ChatSession {
        id: r.get(0)?,
        title: r.get(1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
    })
}

impl Store {
    pub fn sessions(&self, doc: &str, rev: &str) -> Result<Vec<ChatSession>> {
        let db = self.0.lock().map_err(|e| e.to_string())?;
        let mut q = db.prepare("SELECT id,title,created,updated FROM chat_sessions WHERE doc=?1 AND revision=?2 ORDER BY created,id").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![doc, rev], row_session)
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn create_session(&self, doc: &str, rev: &str, ensure: bool) -> Result<ChatSession> {
        let mut db = self.0.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let existing = if ensure {
            tx.query_row("SELECT id,title,created,updated FROM chat_sessions WHERE doc=?1 AND revision=?2 ORDER BY created,id LIMIT 1",params![doc,rev],row_session).optional().map_err(|e|e.to_string())?
        } else {
            None
        };
        let session = match existing {
            Some(s) => s,
            None => create(&tx, doc, rev, "新しい会話")?,
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(session)
    }
    pub fn require_session(&self, doc: &str, rev: &str, session: &str) -> Result<()> {
        let db = self.0.lock().map_err(|e| e.to_string())?;
        let count = db
            .query_row(
                "SELECT COUNT(*) FROM chat_sessions WHERE id=?1 AND doc=?2 AND revision=?3",
                params![session, doc, rev],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        written(count).map(|_| ())
    }
    pub fn session_history(&self, doc: &str, rev: &str, session: &str) -> Result<Vec<ChatMessage>> {
        self.require_session(doc, rev, session)?;
        let db = self.0.lock().map_err(|e| e.to_string())?;
        let mut q = db
            .prepare("SELECT data FROM session_messages WHERE session=?1 ORDER BY created,rowid")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([session], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn save_session_message(
        &self,
        doc: &str,
        rev: &str,
        session: &str,
        message: &ChatMessage,
    ) -> Result<()> {
        let mut db = self.0.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO session_messages(id,session,data,created) SELECT ?1,?2,?3,?4 FROM chat_sessions WHERE id=?2 AND doc=?5 AND revision=?6 ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE session_messages.session=excluded.session",params![message.id,session,serde_json::to_string(message).map_err(|e|e.to_string())?,message.created_at,doc,rev]).map_err(|e|e.to_string()).and_then(written)?;
        let first_user = message.role == "user" && tx.query_row("SELECT COUNT(*) FROM session_messages WHERE session=?1 AND json_extract(data,'$.role')='user'",[session],|r|r.get::<_,usize>(0)).map_err(|e|e.to_string())? == 1;
        let title: String = message.text.trim().chars().take(48).collect();
        tx.execute("UPDATE chat_sessions SET updated=?2,title=CASE WHEN ?3 THEN ?4 ELSE title END WHERE id=?1",params![session,now(),first_user,title]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn session_thread(&self, session: &str, account: &str) -> Result<Option<String>> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .query_row(
                "SELECT thread FROM session_threads WHERE session=?1 AND account=?2",
                params![session, account],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn save_session_thread(&self, session: &str, account: &str, thread: &str) -> Result<()> {
        self.0.lock().map_err(|e|e.to_string())?.execute("INSERT INTO session_threads SELECT ?1,?2,?3 FROM chat_sessions WHERE id=?1 ON CONFLICT(session,account) DO UPDATE SET thread=excluded.thread",params![session,account,thread]).map_err(|e|e.to_string()).and_then(written).map(|_|())
    }
}
