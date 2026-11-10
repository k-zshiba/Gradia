use crate::{emit, files::hidden, model::*, AppState};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, sync::LazyLock, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

pub struct Engine {
    pub child: Child,
    pub endpoint: String,
    pub model_hash: String,
    pub model_stamp: String,
    api_key: String,
}
fn model_stamp(state: &AppState) -> Result<String> {
    let settings = state.store.settings()?;
    let metadata = std::fs::metadata(&settings.model_path).ok();
    Ok(format!(
        "{}:{:?}:{:?}",
        settings.model_path,
        metadata.as_ref().map(|m| m.len()),
        metadata.and_then(|m| m.modified().ok())
    ))
}
pub fn check_model_stamp(state: &AppState) -> Result<String> {
    let stamp = model_stamp(state)?;
    if state.store.get("model_stamp")?.as_deref() != Some(&stamp) {
        state
            .store
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM translations", [])
            .map_err(|e| e.to_string())?;
        state.store.set("model_stamp", &stamp)?;
    }
    Ok(stamp)
}
pub fn protect(text: &str) -> (String, Vec<String>) {
    static LITERALS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\$[^$\n]+\$|https?://[^\s)]+|\[\^[^\]\n]+\]|<[^>\n]+>|\*\*|__|~~|!\[|\[|[*_]|\\[\\`*_{}\[\]()#+.!~<>-]").expect("valid literal pattern")
    });
    let mut ranges: Vec<_> = LITERALS.find_iter(text).map(|m| m.range()).collect();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let escaped = bytes[..i].iter().rev().take_while(|&&b| b == b'\\').count() % 2 == 1;
        if bytes[i] == b'`' && !escaped {
            let length = bytes[i..].iter().take_while(|&&b| b == b'`').count();
            let mut j = i + length;
            while j < bytes.len() {
                if bytes[j] == b'`' {
                    let closing = bytes[j..].iter().take_while(|&&b| b == b'`').count();
                    if closing == length {
                        ranges.push(i..j + closing);
                        i = j + closing - 1;
                        break;
                    }
                    j += closing;
                } else {
                    j += 1;
                }
            }
        } else if bytes[i..].starts_with(b"](") && !escaped {
            let mut depth = 1;
            let mut j = i + 2;
            let mut angle = false;
            let mut quote = None;
            while j < bytes.len() {
                let b = bytes[j];
                if b == b'\\' {
                    j += 2;
                    continue;
                }
                if let Some(q) = quote {
                    if b == q {
                        quote = None;
                    }
                } else if angle {
                    if b == b'>' {
                        angle = false;
                    }
                } else if b == b'<' {
                    angle = true;
                } else if (b == b'\'' || b == b'"') && bytes[j - 1].is_ascii_whitespace() {
                    quote = Some(b);
                } else if b == b'(' {
                    depth += 1;
                } else if b == b')' {
                    depth -= 1;
                    if depth == 0 {
                        ranges.push(i..j + 1);
                        i = j;
                        break;
                    }
                }
                j += 1;
            }
        }
        i += 1;
    }
    ranges.sort_by_key(|range| (range.start, std::cmp::Reverse(range.end)));
    let mut saved = Vec::new();
    let mut masked = String::new();
    let mut cursor = 0;
    for range in ranges {
        if range.start < cursor {
            continue;
        }
        masked.push_str(&text[cursor..range.start]);
        masked.push_str(&format!("⟦KEEP_{}⟧", saved.len()));
        saved.push(text[range.clone()].to_string());
        cursor = range.end;
    }
    masked.push_str(&text[cursor..]);
    (masked, saved)
}
pub fn restore(text: &str, saved: &[String]) -> Result<String> {
    let mut out = text.to_string();
    for (i, original) in saved.iter().enumerate() {
        let key = format!("⟦KEEP_{i}⟧");
        if out.matches(&key).count() != 1 {
            return Err("コード・数式の保持を確認できませんでした。原文を表示します".into());
        }
        out = out.replace(&key, original);
    }
    if out.contains("⟦KEEP_") {
        return Err("翻訳結果に不正な保護記号が含まれています".into());
    }
    Ok(out)
}
pub fn prompt(text: &str, context: &str) -> Result<(String, Vec<String>)> {
    if text.len() > 56_000 || text.chars().count() > 14_000 {
        return Err("この文は長すぎるため翻訳できません".into());
    }
    if text.contains("<|plamo:") || context.contains("<|plamo:") {
        return Err("翻訳モデルの制御記号を含む文は翻訳できません".into());
    }
    let (masked, saved) = protect(text);
    Ok((format!("<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>context<|plamo:msg|>{context}<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>{masked}<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>plain<|plamo:msg|>"),saved))
}
async fn ensure_engine(state: &AppState) -> Result<()> {
    let model_stamp = check_model_stamp(state)?;
    let mut guard = state.engine.lock().await;
    if let Some(engine) = guard.as_mut() {
        if engine.model_stamp == model_stamp
            && engine
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
        {
            return Ok(());
        }
        let _ = engine.child.kill().await;
        *guard = None;
    }
    let settings = state.store.settings()?;
    if settings.model_path.is_empty() {
        return Err("設定でPLaMoのGGUFファイルとllama-server.exeを指定してください".into());
    }
    let model = PathBuf::from(&settings.model_path);
    if !model.is_file() {
        return Err("モデルファイルが見つかりません".into());
    }
    let model_hash = tokio::task::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut f = std::fs::File::open(model).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut bytes = [0u8; 65536];
        loop {
            let n = f.read(&mut bytes).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hash.update(&bytes[..n]);
        }
        Ok::<String, String>(format!("{:x}", hash.finalize()))
    })
    .await
    .map_err(|e| e.to_string())??;
    let socket = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = socket.local_addr().map_err(|e| e.to_string())?.port();
    drop(socket);
    let api_key = uuid::Uuid::new_v4().to_string();
    let mut command = Command::new(crate::files::executable(&settings.llama_path)?);
    hidden(&mut command);
    command
        .args([
            "-m",
            &settings.model_path,
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--alias",
            "plamo-3-translate",
            "-c",
            "8192",
            "--jinja",
            "--no-prefill-assistant",
            "-ngl",
            &settings.gpu_layers.to_string(),
        ])
        // Loopback alone does not stop a web page from submitting inference requests.
        // Environment avoids exposing the key in the process command line.
        .env("LLAMA_API_KEY", &api_key)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("llama-serverを起動できません: {e}"))?;
    let endpoint = format!("http://127.0.0.1:{port}");
    for _ in 0..240 {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err(
                "llama-serverが終了しました。対応するバージョン・モデル・GPU設定を確認してください"
                    .into(),
            );
        }
        if state
            .local_http
            .get(format!("{endpoint}/health"))
            .timeout(Duration::from_secs(1))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            *guard = Some(Engine {
                child,
                endpoint,
                model_hash,
                model_stamp,
                api_key,
            });
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("翻訳モデルの起動がタイムアウトしました".into())
}
#[tauri::command]
pub async fn start_engine(state: State<'_, AppState>) -> Result<String> {
    ensure_engine(&state).await?;
    Ok("PLaMoの準備ができました".into())
}
#[tauri::command]
pub async fn stop_engine(state: State<'_, AppState>) -> Result<()> {
    if let Some(mut e) = state.engine.lock().await.take() {
        e.child.kill().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn run(
    app: &AppHandle,
    job: &str,
    doc: &Document,
    ids: Vec<String>,
    cancel: CancellationToken,
) -> Result<()> {
    let state = app.state::<AppState>();
    tokio::select! {_ = cancel.cancelled()=>return Err("interrupted".into()),r=ensure_engine(&state)=>r?}
    for id in ids {
        if cancel.is_cancelled() {
            return Err("interrupted".into());
        }
        let segment = doc
            .segments
            .iter()
            .find(|s| s.id == id)
            .ok_or("文が見つかりません")?;
        if !segment.eligible {
            continue;
        }
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err("interrupted".into()),
            result = translate_segment(&state, doc, segment) => result,
        };
        match result {
            Ok((text, cached)) => emit(
                app,
                json!({"jobId":job,"documentId":doc.id,"kind":"translation","status":"running","segmentId":id,"text":text,"cached":cached}),
            ),
            Err(e) if e == "interrupted" => return Err(e),
            Err(e) => emit(
                app,
                json!({"jobId":job,"documentId":doc.id,"kind":"translation","status":"running","segmentId":id,"error":e}),
            ),
        }
    }
    Ok(())
}
async fn translate_segment(
    state: &AppState,
    doc: &Document,
    segment: &Segment,
) -> Result<(String, bool)> {
    let context = doc
        .segments
        .iter()
        .skip(segment.order.saturating_sub(2))
        .take(5)
        .filter(|s| s.id != segment.id)
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(3000)
        .collect::<String>();
    let (prompt, saved) = prompt(&segment.text, &context)?;
    if prompt.chars().count() > 14000 {
        return Err("この文は長すぎるため翻訳できません".into());
    }
    let guard = state.engine.lock().await;
    let engine = guard.as_ref().ok_or("翻訳エンジンが停止しています")?;
    let key = digest(format!("pfml3-v1\n{}\n{prompt}", engine.model_hash).as_bytes());
    let cached = state.store.cached(&key)?;
    let from_cache = cached.is_some();
    let text = if let Some(text) = cached {
        text
    } else {
        let body: Value = state.local_http
            .post(format!("{}/v1/completions", engine.endpoint))
            .bearer_auth(&engine.api_key)
            .timeout(Duration::from_secs(180))
            .json(&json!({"model":"plamo-3-translate","prompt":prompt,"temperature":0,"max_tokens":2048,"stop":["<|plamo:tag|>","<|plamo:bos|>"]}))
            .send().await.map_err(|e| e.to_string())?
            .error_for_status().map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        if body["choices"][0]["finish_reason"] == "length" {
            return Err("翻訳が出力上限に達しました。原文を表示します".into());
        }
        let translated = body["choices"][0]["text"]
            .as_str()
            .ok_or("翻訳結果がありません")?
            .trim();
        if translated.is_empty() {
            return Err("翻訳結果が空です".into());
        }
        restore(translated, &saved)?
    };
    state
        .store
        .translation(&doc.id, &doc.revision, &segment.id, &key, &text)?;
    Ok((text, from_cache))
}
#[tauri::command]
pub async fn start_translation(
    document_id: String,
    revision: String,
    segment_ids: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String> {
    let _gate = state.mutation_gate.lock().await;
    let doc = state.store.document(&document_id, &revision)?;
    let mut seen = std::collections::HashSet::new();
    let ids = segment_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect::<Vec<_>>();
    let job = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    state.jobs.lock().await.insert(job.clone(), token.clone());
    let cloned = job.clone();
    tokio::spawn(async move {
        let result = run(&app, &cloned, &doc, ids, token).await;
        let status = match &result {
            Ok(_) => "completed",
            Err(e) if e == "interrupted" => "interrupted",
            _ => "failed",
        };
        emit(
            &app,
            json!({"jobId":cloned,"documentId":doc.id,"kind":"translation","status":status,"error":result.err()}),
        );
        app.state::<AppState>().jobs.lock().await.remove(&cloned);
    });
    Ok(job)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literals_survive() {
        let (masked, s) = protect("Use `foo.bar()` and $x^2$.");
        assert_eq!(restore(&masked, &s).unwrap(), "Use `foo.bar()` and $x^2$.");
        assert!(restore("失われた記号", &s).is_err());
    }
    #[test]
    fn markdown_formatting_multibacktick_code_and_relative_link_targets_survive_translation() {
        let input = "Read **safe** code ``a`b`` and [Docs](../guide_(intro).md \"Local (guide)\").";
        let (masked, saved) = protect(input);
        assert_eq!(
            saved,
            vec![
                "**",
                "**",
                "``a`b``",
                "[",
                "](../guide_(intro).md \"Local (guide)\")"
            ]
        );
        assert!(!masked.contains("a`b"));
        assert!(!masked.contains("guide_"));
        let translated = "⟦KEEP_0⟧安全な⟦KEEP_1⟧コード⟦KEEP_2⟧と⟦KEEP_3⟧資料⟦KEEP_4⟧を読みます。";
        assert_eq!(
            restore(translated, &saved).unwrap(),
            "**安全な**コード``a`b``と[資料](../guide_(intro).md \"Local (guide)\")を読みます。"
        );
        assert!(restore("⟦KEEP_0⟧失われた書式", &saved).is_err());
    }
    #[test]
    fn rejects_oversized_prose_before_scanning_markdown() {
        assert!(prompt(&"](".repeat(30_000), "")
            .unwrap_err()
            .contains("長すぎる"));
    }
    #[test]
    fn rejects_control_tokens() {
        assert!(prompt("<|plamo:tag|>", "").is_err());
    }
    #[test]
    fn prompt_separates_context() {
        let (p, _) = prompt("Read the value.", "Previous sentence.").unwrap();
        assert!(p.contains("context<|plamo:msg|>Previous sentence."));
        assert!(p.ends_with("plain<|plamo:msg|>"));
    }
}
