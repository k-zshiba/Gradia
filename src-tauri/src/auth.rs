use crate::{emit, model::*, AppState};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub client_id: String,
    pub subject: String,
    pub email: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub id_token: String,
    pub scopes: String,
}
fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI is scoped to the current Windows user. Never fall back to plaintext storage.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Windows資格情報の保護処理に失敗しました: {}",
                std::io::Error::last_os_error()
            ));
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        Ok(result)
    }
}
#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> Result<Vec<u8>> {
    Err("認証情報の保存はWindowsに対応しています".into())
}
pub fn load(state: &AppState) -> Result<Option<Credentials>> {
    let path = state.root.join("account.dpapi");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut plain = crypt(&bytes, false)?;
    let result = serde_json::from_slice(&plain)
        .map_err(|_| "認証情報を読み込めません。再接続してください".into());
    use zeroize::Zeroize;
    plain.zeroize();
    result.map(Some)
}
fn save(state: &AppState, creds: &Credentials) -> Result<()> {
    let mut plain = serde_json::to_vec(creds).map_err(|e| e.to_string())?;
    let encrypted = crypt(&plain, true);
    use zeroize::Zeroize;
    plain.zeroize();
    let encrypted = encrypted?;
    let path = state.root.join("account.dpapi");
    // A backup keeps refresh credentials recoverable if a replace is interrupted on Windows.
    let temp = state.root.join("account.dpapi.new");
    std::fs::write(&temp, encrypted).map_err(|e| e.to_string())?;
    if path.exists() {
        std::fs::copy(&path, state.root.join("account.dpapi.bak")).map_err(|e| e.to_string())?;
    }
    std::fs::rename(temp, path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(state.root.join("account.dpapi.bak"));
    Ok(())
}
fn check_scopes(scopes: &str) -> Result<()> {
    if !scopes
        .split_whitespace()
        .any(|s| s == "chatgpt.tokens.use.direct")
    {
        Err("ChatGPT契約枠の利用が許可されていません。接続画面で権限と利用可能なプランを確認してください".into())
    } else {
        Ok(())
    }
}
async fn validate_id(
    state: &AppState,
    token: &str,
    client: &str,
    nonce: Option<&str>,
) -> Result<Value> {
    let header = jsonwebtoken::decode_header(token).map_err(|_| "IDトークンが不正です")?;
    if header.alg != jsonwebtoken::Algorithm::RS256 {
        return Err("IDトークンの署名形式が不正です".into());
    }
    let key_id = header.kid.ok_or("IDトークンの鍵IDがありません")?;
    let jwks: jsonwebtoken::jwk::JwkSet = state
        .http
        .get(format!("{ISSUER}/.well-known/jwks.json"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let key =
        jsonwebtoken::DecodingKey::from_jwk(jwks.find(&key_id).ok_or("署名鍵が見つかりません")?)
            .map_err(|e| e.to_string())?;
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let data = jsonwebtoken::decode::<Value>(token, &key, &validation)
        .map_err(|_| "IDトークンの検証に失敗しました")?
        .claims;
    if let Some(nonce) = nonce {
        if data["nonce"].as_str() != Some(nonce) {
            return Err("認証nonceが一致しません".into());
        }
    }
    Ok(data)
}
async fn token_request(state: &AppState, form: &[(&str, &str)]) -> Result<Value> {
    let response = state
        .http
        .post(format!("{ISSUER}/api/accounts/oauth/token"))
        .form(form)
        .send()
        .await
        .map_err(|_| "認証サーバーに接続できません")?;
    if !response.status().is_success() {
        return Err(format!(
            "認証の更新・交換に失敗しました（HTTP {}）。再接続してください",
            response.status()
        ));
    }
    response
        .json()
        .await
        .map_err(|_| "認証サーバーの応答が不正です".into())
}
pub async fn access(state: &AppState) -> Result<Credentials> {
    let _guard = state.auth_gate.lock().await;
    let mut creds = load(state)?.ok_or("設定からChatGPTに接続してください")?;
    check_scopes(&creds.scopes)?;
    if creds.expires_at > now() + 120_000 {
        return Ok(creds);
    }
    let tokens = token_request(
        state,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &creds.client_id),
            ("refresh_token", &creds.refresh_token),
            ("resource", RESOURCE),
        ],
    )
    .await?;
    if let Some(id) = tokens["id_token"].as_str() {
        let claims = validate_id(state, id, &creds.client_id, None).await?;
        if claims["sub"].as_str() != Some(&creds.subject) {
            return Err("更新後のアカウントが一致しません".into());
        }
        creds.id_token = id.into();
    }
    creds.access_token = tokens["access_token"]
        .as_str()
        .ok_or("アクセストークンがありません")?
        .into();
    if let Some(refresh) = tokens["refresh_token"].as_str() {
        creds.refresh_token = refresh.into();
    }
    if let Some(scopes) = tokens["scope"].as_str() {
        check_scopes(scopes)?;
        creds.scopes = scopes.into();
    }
    creds.expires_at = now() + tokens["expires_in"].as_u64().unwrap_or(3600) * 1000;
    save(state, &creds)?;
    Ok(creds)
}
async fn login(app: &AppHandle, cancel: tokio_util::sync::CancellationToken) -> Result<String> {
    let state = app.state::<AppState>();
    let _guard = state.auth_gate.lock().await;
    let existing = load(&state)?;
    let host = match state.store.get("auth_host")? {
        Some(h) => h,
        None => {
            let h = format!("urn:uuid:{}", uuid::Uuid::new_v4());
            state.store.set("auth_host", &h)?;
            h
        }
    };
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let redirect = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener.local_addr().map_err(|e| e.to_string())?.port()
    );
    let expected_state = random();
    let nonce = random();
    let verifier = random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url =
        url::Url::parse(&format!("{ISSUER}/api/accounts/authorize")).map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.extend_pairs([
            (
                "client_id",
                existing
                    .as_ref()
                    .map(|e| e.client_id.as_str())
                    .unwrap_or("dynamic_agent_client"),
            ),
            ("ext_agent_host_id", host.as_str()),
            ("response_type", "code"),
            ("redirect_uri", redirect.as_str()),
            (
                "scope",
                "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            ),
            ("resource", RESOURCE),
            ("state", expected_state.as_str()),
            ("nonce", nonce.as_str()),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
        ]);
        if let Some(existing) = &existing {
            query.append_pair("id_token_hint", &existing.id_token);
        } else {
            query.append_pair("agent_name_hint", "study-tool");
        }
    }
    webbrowser::open(url.as_str()).map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 2048];
            while bytes.len() < 16_384 {
                let n = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut chunk))
                    .await
                    .map_err(|_| "認証コールバックがタイムアウトしました")?
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&bytes);
            let target = request
                .lines()
                .next()
                .unwrap_or("")
                .split_whitespace()
                .nth(1)
                .unwrap_or("");
            let parsed = url::Url::parse(&format!("http://127.0.0.1{target}"))
                .map_err(|_| "認証コールバックが不正です")?;
            let query: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
            if parsed.path() != "/auth/callback" || query.get("state") != Some(&expected_state) {
                let _=socket.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
            let page = "Authentication received. You can close this tab and return to Study Tool.";
            let _=socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{page}",page.len()).as_bytes()).await;
            if query.contains_key("error") {
                return Err("ChatGPTへの接続がキャンセルされました".into());
            }
            let client = query
                .get("client_id")
                .cloned()
                .or_else(|| existing.as_ref().map(|e| e.client_id.clone()))
                .ok_or("アプリ登録が完了しませんでした")?;
            if existing.as_ref().is_some_and(|e| e.client_id != client) {
                return Err("アプリ登録IDが一致しません".into());
            }
            let code = query.get("code").ok_or("認証コードがありません")?;
            let tokens = token_request(
                &state,
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", &client),
                    ("code", code),
                    ("code_verifier", &verifier),
                    ("redirect_uri", &redirect),
                    ("resource", RESOURCE),
                ],
            )
            .await?;
            let id_token = tokens["id_token"]
                .as_str()
                .ok_or("IDトークンがありません")?;
            let claims = validate_id(&state, id_token, &client, Some(&nonce)).await?;
            let subject = claims["sub"].as_str().ok_or("アカウントIDがありません")?;
            if existing.as_ref().is_some_and(|e| e.subject != subject) {
                return Err("別のアカウントです。一度接続解除してください".into());
            }
            let scopes = tokens["scope"].as_str().ok_or("利用権限がありません")?;
            check_scopes(scopes)?;
            let creds = Credentials {
                client_id: client,
                subject: subject.into(),
                email: claims["email"].as_str().unwrap_or("ChatGPT").into(),
                access_token: tokens["access_token"]
                    .as_str()
                    .ok_or("アクセストークンがありません")?
                    .into(),
                refresh_token: tokens["refresh_token"]
                    .as_str()
                    .ok_or("更新トークンがありません")?
                    .into(),
                expires_at: now() + tokens["expires_in"].as_u64().unwrap_or(3600) * 1000,
                id_token: id_token.into(),
                scopes: scopes.into(),
            };
            save(&state, &creds)?;
            return Ok(creds.email);
        }
    });
    tokio::select! {_ = cancel.cancelled()=>Err("interrupted".into()), result=result=>result.map_err(|_|"認証がタイムアウトしました".to_string())?}
}
#[tauri::command]
pub async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    let job = uuid::Uuid::new_v4().to_string();
    let token = tokio_util::sync::CancellationToken::new();
    state.jobs.lock().await.insert(job.clone(), token.clone());
    let cloned = job.clone();
    tokio::spawn(async move {
        let result = login(&app, token).await;
        emit(
            &app,
            json!({"jobId":cloned,"documentId":"","kind":"auth","status":if result.is_ok(){"completed"}else{"failed"},"error":result.err()}),
        );
        app.state::<AppState>().jobs.lock().await.remove(&cloned);
    });
    Ok(job)
}
#[tauri::command]
pub async fn sign_out(state: State<'_, AppState>) -> Result<()> {
    let _guard = state.auth_gate.lock().await;
    // Stop any in-flight inference before dropping the app's credentials.
    for token in state.jobs.lock().await.values() {
        token.cancel();
    }
    for name in ["account.dpapi", "account.dpapi.new", "account.dpapi.bak"] {
        let path = state.root.join(name);
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn account_status(state: State<'_, AppState>) -> Result<Value> {
    Ok(match load(&state)? {
        Some(c) => json!({"connected":true,"email":c.email}),
        None => json!({"connected":false}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_plan_scope() {
        assert!(check_scopes("openid profile").is_err());
        assert!(check_scopes("openid chatgpt.tokens.use.direct").is_ok());
    }
}
