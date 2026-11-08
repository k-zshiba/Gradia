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
          CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE);
          CREATE TABLE IF NOT EXISTS project_documents(project TEXT NOT NULL,doc TEXT NOT NULL,revision TEXT NOT NULL,
            PRIMARY KEY(project,doc,revision),
            FOREIGN KEY(project) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY(doc,revision) REFERENCES documents(id,revision));
          PRAGMA user_version=2;").map_err(|e|e.to_string())?;
        // In-flight messages cannot still be running after a process restart.
        db.execute("UPDATE chats SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running'",[]).map_err(|e|e.to_string())?;
        Ok(Self(Mutex::new(db)))
    }
    pub fn put_document(&self, doc: &Document, project: Option<&str>) -> Result<()> {
        let mut db = self.0.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO documents VALUES(?1,?2,?3,?4)",
            params![
                doc.id,
                doc.revision,
                serde_json::to_string(doc).map_err(|e| e.to_string())?,
                doc.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
        if let Some(project) = project {
            tx.execute(
                "INSERT OR IGNORE INTO project_documents VALUES(?1,?2,?3)",
                params![project, doc.id, doc.revision],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        let db = self.0.lock().map_err(|e| e.to_string())?;
        let mut projects = db
            .prepare("SELECT id,name FROM projects ORDER BY name COLLATE NOCASE,id")
            .map_err(|e| e.to_string())?;
        let mut members = db.prepare("SELECT doc || ':' || revision FROM project_documents WHERE project=?1 ORDER BY doc,revision")
            .map_err(|e| e.to_string())?;
        let rows = projects
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (id, name) = row.map_err(|e| e.to_string())?;
            let document_keys = members
                .query_map([&id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Project {
                id,
                name,
                document_keys,
            })
        })
        .collect()
    }
    pub fn create_project(&self, name: &str) -> Result<Project> {
        let name = project_name(name)?;
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            document_keys: Vec::new(),
        };
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT INTO projects VALUES(?1,?2)",
                params![project.id, project.name],
            )
            .map_err(project_write_error)?;
        Ok(project)
    }
    pub fn rename_project(&self, id: &str, name: &str) -> Result<()> {
        let name = project_name(name)?;
        let changed = self
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .execute("UPDATE projects SET name=?2 WHERE id=?1", params![id, name])
            .map_err(project_write_error)?;
        if changed == 0 {
            return Err("プロジェクトが見つかりません".into());
        }
        Ok(())
    }
    pub fn delete_project(&self, id: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM projects WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn project_document(
        &self,
        project: &str,
        id: &str,
        revision: &str,
        add: bool,
    ) -> Result<()> {
        let db = self.0.lock().map_err(|e| e.to_string())?;
        if add {
            db.execute(
                "INSERT OR IGNORE INTO project_documents VALUES(?1,?2,?3)",
                params![project, id, revision],
            )
            .map_err(|_| "プロジェクトまたは資料が見つかりません".to_string())?;
        } else {
            db.execute(
                "DELETE FROM project_documents WHERE project=?1 AND doc=?2 AND revision=?3",
                params![project, id, revision],
            )
            .map_err(|e| e.to_string())?;
        }
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

fn project_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("プロジェクト名は改行を含めず1〜80文字で入力してください".into());
    }
    Ok(name.to_string())
}

fn project_write_error(error: rusqlite::Error) -> String {
    if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
    {
        "同じ名前のプロジェクトがすでにあります".into()
    } else {
        error.to_string()
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
    fn document(revision: &str) -> Document {
        Document {
            id: "source".into(),
            revision: revision.into(),
            title: "Book".into(),
            kind: "text".into(),
            source: "C:/books/book.md".into(),
            created_at: 1,
            segments: vec![],
            content: "Original text.".into(),
            warnings: vec![],
            language: None,
            ratio: 50,
            position: Some("sentence".into()),
        }
    }
    #[test]
    fn projects_share_documents_without_losing_versions_preferences_or_translations() {
        let s = Store::open(Path::new(":memory:")).unwrap();
        let rust = s.create_project(" Rust ").unwrap();
        let books = s.create_project("Books").unwrap();
        assert_eq!(rust.name, "Rust");
        s.put_document(&document("v1"), Some(&rust.id)).unwrap();
        s.put_document(&document("v2"), None).unwrap();
        s.translation("source", "v1", "a", "key", "訳文").unwrap();
        s.save_message(
            "source",
            "v1",
            &ChatMessage {
                id: "message".into(),
                role: "assistant".into(),
                text: "Answer".into(),
                status: "completed".into(),
                references: vec![],
                created_at: 1,
            },
        )
        .unwrap();
        s.project_document(&books.id, "source", "v1", true).unwrap();
        s.project_document(&books.id, "source", "v1", true).unwrap();
        s.rename_project(&rust.id, "Learning Rust").unwrap();
        assert_eq!(
            s.projects()
                .unwrap()
                .iter()
                .find(|p| p.id == books.id)
                .unwrap()
                .document_keys,
            vec!["source:v1"]
        );
        s.project_document(&rust.id, "source", "v1", false).unwrap();
        assert!(s
            .projects()
            .unwrap()
            .iter()
            .find(|p| p.id == rust.id)
            .unwrap()
            .document_keys
            .is_empty());
        s.delete_project(&books.id).unwrap();
        assert_eq!(s.list().unwrap().len(), 2);
        let original = s.document("source", "v1").unwrap();
        assert_eq!(original.content, "Original text.");
        assert_eq!(original.ratio, 50);
        assert_eq!(original.position.as_deref(), Some("sentence"));
        assert_eq!(s.translations("source", "v1").unwrap()["a"]["text"], "訳文");
        assert_eq!(s.history("source", "v1").unwrap()[0].text, "Answer");
    }
    #[test]
    fn projects_survive_restart_and_existing_documents_remain_available() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("study.sqlite3");
        let id;
        {
            let s = Store::open(&path).unwrap();
            s.put_document(&document("v1"), None).unwrap();
            s.0.lock()
                .unwrap()
                .execute_batch(
                    "DROP TABLE project_documents; DROP TABLE projects; PRAGMA user_version=1;",
                )
                .unwrap();
        }
        {
            let s = Store::open(&path).unwrap();
            assert_eq!(s.list().unwrap().len(), 1);
            assert!(s.projects().unwrap().is_empty());
            let p = s.create_project("Reading").unwrap();
            id = p.id;
            s.project_document(&id, "source", "v1", true).unwrap();
        }
        let s = Store::open(&path).unwrap();
        let projects = s.projects().unwrap();
        assert_eq!(projects[0].id, id);
        assert_eq!(projects[0].document_keys, vec!["source:v1"]);
    }
    #[test]
    fn invalid_projects_do_not_create_orphan_documents() {
        let s = Store::open(Path::new(":memory:")).unwrap();
        assert!(s.put_document(&document("v1"), Some("missing")).is_err());
        assert!(s.list().unwrap().is_empty());
        assert!(s.project_document("missing", "source", "v1", true).is_err());
        for name in ["", "  ", "line\nbreak", &"a".repeat(81)] {
            assert!(s.create_project(name).is_err());
        }
        let p = s.create_project("Rust").unwrap();
        assert!(s.create_project("rust").is_err());
        assert!(s.rename_project("missing", "Other").is_err());
        assert!(s.project_document(&p.id, "missing", "v1", true).is_err());
    }
}
