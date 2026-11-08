use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub block: usize,
    pub order: usize,
    pub text: String,
    pub kind: String,
    pub eligible: bool,
    pub location: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub revision: String,
    pub title: String,
    pub kind: String,
    pub source: String,
    #[serde(default)]
    pub created_at: u64,
    pub segments: Vec<Segment>,
    pub content: String,
    pub warnings: Vec<String>,
    pub language: Option<String>,
    pub ratio: u8,
    #[serde(default)]
    pub bilingual: bool,
    pub position: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub document_keys: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub id: String,
    pub segment_id: String,
    pub revision: String,
    pub text: String,
    pub translation: Option<String>,
    pub location: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub status: String,
    pub references: Vec<Reference>,
    pub created_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub llama_path: String,
    pub model_path: String,
    pub gpu_layers: u32,
    pub codex_path: String,
    pub codex_model: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            llama_path: "llama-server.exe".into(),
            model_path: String::new(),
            gpu_layers: 0,
            codex_path: "codex.exe".into(),
            codex_model: String::new(),
        }
    }
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
pub type Result<T> = std::result::Result<T, String>;
