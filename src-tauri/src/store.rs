use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};

pub struct Store(pub Mutex<Connection>);
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS documents(id TEXT NOT NULL, revision TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(id,revision));
          CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,text TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS translations(doc TEXT, revision TEXT, segment TEXT, key TEXT NOT NULL, PRIMARY KEY(doc,revision,segment));
          CREATE TABLE IF NOT EXISTS chats(doc TEXT, revision TEXT, id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS threads(doc TEXT, revision TEXT, account TEXT, thread TEXT NOT NULL, PRIMARY KEY(doc,revision,account));
          CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          PRAGMA user_version=1;").map_err(|e|e.to_string())?;
        // In-flight messages cannot still be running after a process restart.
        db.execute("UPDATE chats SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running'",[]).map_err(|e|e.to_string())?;
        Ok(Self(Mutex::new(db)))
    }
    pub fn put_document(&self, doc: &Document) -> Result<()> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT OR IGNORE INTO documents VALUES(?1,?2,?3,?4)",
                params![
                    doc.id,
                    doc.revision,
                    serde_json::to_string(doc).map_err(|e| e.to_string())?,
                    doc.created_at
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn document(&self, id: &str, revision: &str) -> Result<Document> {
        let raw: String = self
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .query_row(
                "SELECT data FROM documents WHERE id=?1 AND revision=?2",
                params![id, revision],
                |r| r.get(0),
            )
            .map_err(|_| "資料が見つかりません".to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
    pub fn list(&self) -> Result<Vec<Document>> {
        let db = self.0.lock().map_err(|e| e.to_string())?;
        let mut q = db
            .prepare("SELECT data FROM documents ORDER BY created DESC")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn preference(
        &self,
        id: &str,
        rev: &str,
        ratio: u8,
        position: Option<String>,
    ) -> Result<()> {
        let mut doc = self.document(id, rev)?;
        doc.ratio = ratio.min(100);
        doc.position = position;
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "UPDATE documents SET data=?3 WHERE id=?1 AND revision=?2",
                params![
                    id,
                    rev,
                    serde_json::to_string(&doc).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn get(&self, key: &str) -> Result<Option<String>> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .query_row("SELECT value FROM kv WHERE key=?1", [key], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT OR REPLACE INTO kv VALUES(?1,?2)",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Settings> {
        self.get("settings")?
            .map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
            .unwrap_or_else(|| Ok(Settings::default()))
    }
    pub fn cached(&self, key: &str) -> Result<Option<String>> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .query_row("SELECT text FROM cache WHERE key=?1", [key], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn translation(
        &self,
        doc: &str,
        rev: &str,
        segment: &str,
        key: &str,
        text: &str,
    ) -> Result<()> {
        let mut db = self.0.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO cache VALUES(?1,?2)",
            params![key, text],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO translations VALUES(?1,?2,?3,?4)",
            params![doc, rev, segment, key],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn translations(&self, id: &str, rev: &str) -> Result<Value> {
        let db = self.0.lock().map_err(|e| e.to_string())?;
        let mut q=db.prepare("SELECT segment,text,key FROM translations JOIN cache USING(key) WHERE doc=?1 AND revision=?2").map_err(|e|e.to_string())?;
        let mut out = serde_json::Map::new();
        let rows = q
            .query_map(params![id, rev], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, text, key) = row.map_err(|e| e.to_string())?;
            out.insert(
                id.clone(),
                json!({"segmentId":id,"text":text,"cacheKey":key,"status":"ready"}),
            );
        }
        Ok(Value::Object(out))
    }
    pub fn save_message(&self, doc: &str, rev: &str, msg: &ChatMessage) -> Result<()> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT OR REPLACE INTO chats VALUES(?1,?2,?3,?4,?5)",
                params![
                    doc,
                    rev,
                    msg.id,
                    serde_json::to_string(msg).map_err(|e| e.to_string())?,
                    msg.created_at
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn history(&self, doc: &str, rev: &str) -> Result<Vec<ChatMessage>> {
        let db = self.0.lock().map_err(|e| e.to_string())?;
        let mut q = db
            .prepare("SELECT data FROM chats WHERE doc=?1 AND revision=?2 ORDER BY created,rowid")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map(params![doc, rev], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn thread(&self, doc: &str, rev: &str, account: &str) -> Result<Option<String>> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .query_row(
                "SELECT thread FROM threads WHERE doc=?1 AND revision=?2 AND account=?3",
                params![doc, rev, account],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn save_thread(&self, doc: &str, rev: &str, account: &str, thread: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT OR REPLACE INTO threads VALUES(?1,?2,?3,?4)",
                params![doc, rev, account, thread],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_and_revision_are_separate() {
        let s = Store::open(Path::new(":memory:")).unwrap();
        s.translation("d", "v1", "a", "k1", "訳1").unwrap();
        s.translation("d", "v2", "a", "k2", "訳2").unwrap();
        assert_eq!(s.translations("d", "v1").unwrap()["a"]["text"], "訳1");
        assert_eq!(s.translations("d", "v2").unwrap()["a"]["text"], "訳2");
        assert_eq!(s.cached("missing").unwrap(), None);
    }
}
