use crate::{emit, files::hidden, model::*, AppState};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

pub struct Engine {
    pub child: Child,
    pub endpoint: String,
    pub model_hash: String,
    pub model_stamp: String,
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
    let regex = regex::Regex::new(r"`[^`\n]*`|\$[^$\n]+\$|https?://[^\s)]+").unwrap();
    let mut saved = Vec::new();
    let masked = regex
        .replace_all(text, |m: &regex::Captures<'_>| {
            let id = saved.len();
            saved.push(m[0].to_string());
            format!("⟦KEEP_{id}⟧")
        })
        .into_owned();
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
        let start = segment.order.saturating_sub(2);
        let context = doc
            .segments
            .iter()
            .skip(start)
            .take(5)
            .filter(|s| s.id != id)
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(3000)
            .collect::<String>();
        let result:Result<(String,bool)>=async {
            let (prompt,saved)=prompt(&segment.text,&context)?;
            if prompt.chars().count()>14000{return Err("この文は長すぎるため翻訳できません".into());}
            let guard=state.engine.lock().await;let engine=guard.as_ref().ok_or("翻訳エンジンが停止しています")?;
            let key=digest(format!("pfml3-v1\n{}\n{prompt}",engine.model_hash).as_bytes());
            if let Some(text)=state.store.cached(&key)?{state.store.translation(&doc.id,&doc.revision,&id,&key,&text)?;return Ok((text,true));}
            let request=state.local_http.post(format!("{}/v1/completions",engine.endpoint)).timeout(Duration::from_secs(180)).json(&json!({"model":"plamo-3-translate","prompt":prompt,"temperature":0,"max_tokens":2048,"stop":["<|plamo:tag|>","<|plamo:bos|>"]})).send();
            let response=tokio::select!{_ = cancel.cancelled()=>return Err("interrupted".into()), r=request=>r.map_err(|e|e.to_string())?};
            let body:Value=response.error_for_status().map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
            if body["choices"][0]["finish_reason"]=="length"{return Err("翻訳が出力上限に達しました。原文を表示します".into());}
            let translated=body["choices"][0]["text"].as_str().ok_or("翻訳結果がありません")?.trim();
            if translated.is_empty(){return Err("翻訳結果が空です".into());}
            let text=restore(translated,&saved)?;
            state.store.translation(&doc.id,&doc.revision,&id,&key,&text)?;Ok((text,false))
        }.await;
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
#[tauri::command]
pub async fn start_translation(
    document_id: String,
    revision: String,
    segment_ids: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String> {
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
