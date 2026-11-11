use super::{BrowserBounds, BrowserStatus, CapturedPage};
use crate::model::Result;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
use windows::{
    core::{Interface, HSTRING, PWSTR},
    Win32::Foundation::RECT,
};

thread_local! {
    static OWNER: RefCell<Option<Owner>> = const { RefCell::new(None) };
    static CLOSED: RefCell<std::collections::VecDeque<String>> = const { RefCell::new(std::collections::VecDeque::new()) };
}
static OPERATION: AtomicU64 = AtomicU64::new(1);
type Reply = oneshot::Sender<Result<Value>>;
struct Owner {
    id: String,
    generation: u64,
    navigation_id: Option<u64>,
    token: CancellationToken,
    core: Option<ICoreWebView2>,
    controller: Option<ICoreWebView2Controller>,
    environment: Option<ICoreWebView2Environment>,
    receiver: Option<ICoreWebView2DevToolsProtocolEventReceiver>,
    initializing: Option<oneshot::Sender<Result<()>>>,
    pending: HashMap<u64, Reply>,
    contexts: HashMap<String, String>,
    object: Option<String>,
    loading: bool,
    error: Option<String>,
}
fn string(value: PWSTR) -> String {
    let text = unsafe { value.to_string().unwrap_or_default() };
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(value.0.cast())) };
    text
}
fn failure(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn with_owner<T>(id: &str, action: impl FnOnce(&mut Owner) -> Result<T>) -> Result<T> {
    OWNER.with(|owner| {
        let mut owner = owner.borrow_mut();
        let current = owner
            .as_mut()
            .filter(|owner| owner.id == id)
            .ok_or("Webページは閉じられました")?;
        action(current)
    })
}
async fn on_ui<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let (send, receive) = oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(action());
    })
    .map_err(failure)?;
    receive.await.map_err(failure)?
}
fn invalidate(owner: &mut Owner) {
    owner.generation += 1;
    owner.token.cancel();
    owner.token = CancellationToken::new();
    for (_, reply) in owner.pending.drain() {
        let _ = reply.send(Err("ページが変わったため処理を中断しました".into()));
    }
}
fn close_owner() {
    let owner = OWNER.with(|slot| slot.borrow_mut().take());
    if let Some(mut owner) = owner {
        invalidate(&mut owner);
        if let Some(reply) = owner.initializing.take() {
            let _ = reply.send(Err("Webページは閉じられました".into()));
        }
        if let Some(controller) = owner.controller.take() {
            unsafe {
                let _ = controller.Close();
            }
        }
    }
}
pub fn shutdown() {
    close_owner();
}

unsafe fn install(
    id: &str,
    controller: ICoreWebView2Controller,
    environment: ICoreWebView2Environment,
    profile: &PathBuf,
    trusted_profile: &PathBuf,
    bounds: BrowserBounds,
) -> windows::core::Result<()> {
    let mut actual = PWSTR::null();
    environment
        .cast::<ICoreWebView2Environment7>()?
        .UserDataFolder(&mut actual)?;
    let actual = std::fs::canonicalize(string(actual));
    let expected = std::fs::canonicalize(profile);
    if !matches!((actual, expected), (Ok(a), Ok(b)) if a == b && &a != trusted_profile) {
        controller.Close()?;
        return Err(windows::core::Error::from(
            windows::Win32::Foundation::E_ACCESSDENIED,
        ));
    }
    let core = controller.CoreWebView2()?;
    let settings = core.Settings()?;
    settings.SetIsWebMessageEnabled(false)?;
    settings.SetAreHostObjectsAllowed(false)?;
    settings.SetAreDefaultScriptDialogsEnabled(false)?;
    settings.SetAreDevToolsEnabled(false)?;
    settings.SetAreDefaultContextMenusEnabled(false)?;
    settings
        .cast::<ICoreWebView2Settings3>()?
        .SetAreBrowserAcceleratorKeysEnabled(false)?;
    settings
        .cast::<ICoreWebView2Settings4>()?
        .SetIsPasswordAutosaveEnabled(false)?;
    settings
        .cast::<ICoreWebView2Settings4>()?
        .SetIsGeneralAutofillEnabled(false)?;
    let mut event = 0;
    let session = id.to_string();
    core.add_NavigationStarting(
        &NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let args = args.ok_or_else(windows::core::Error::from_thread)?;
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            if super::navigation_url(&string(uri)).is_err() {
                args.SetCancel(true)?;
                let _ = with_owner(&session, |owner| {
                    owner.error = Some("このURLには移動できません".into());
                    Ok(())
                });
            } else {
                let mut navigation_id = 0;
                args.NavigationId(&mut navigation_id)?;
                let _ = with_owner(&session, |owner| {
                    invalidate(owner);
                    owner.navigation_id = Some(navigation_id);
                    owner.loading = true;
                    owner.error = None;
                    Ok(())
                });
            }
            Ok(())
        })),
        &mut event,
    )?;
    let session = id.to_string();
    core.add_SourceChanged(
        &SourceChangedEventHandler::create(Box::new(move |_, args| {
            let mut new_document = windows::core::BOOL::default();
            args.unwrap().IsNewDocument(&mut new_document)?;
            if !new_document.as_bool() {
                let _ = with_owner(&session, |owner| {
                    invalidate(owner);
                    Ok(())
                });
            }
            Ok(())
        })),
        &mut event,
    )?;
    core.add_FrameNavigationStarting(
        &NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let args = args.unwrap();
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = string(uri);
            if !["about:blank", "about:srcdoc"].contains(&uri.as_str())
                && super::navigation_url(&uri).is_err()
            {
                args.SetCancel(true)?;
            }
            Ok(())
        })),
        &mut event,
    )?;
    let session = id.to_string();
    core.add_NavigationCompleted(
        &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            let mut success = windows::core::BOOL::default();
            let args = args.unwrap();
            args.IsSuccess(&mut success)?;
            let mut navigation_id = 0;
            args.NavigationId(&mut navigation_id)?;
            let _ = with_owner(&session, |owner| {
                if owner.navigation_id != Some(navigation_id) {
                    return Ok(());
                }
                owner.loading = false;
                if !success.as_bool() {
                    owner.error =
                        Some("ページを読み込めませんでした。URLや接続を確認してください".into());
                }
                Ok(())
            });
            Ok(())
        })),
        &mut event,
    )?;
    core.add_PermissionRequested(
        &PermissionRequestedEventHandler::create(Box::new(|_, args| {
            args.unwrap().SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)
        })),
        &mut event,
    )?;
    core.add_NewWindowRequested(
        &NewWindowRequestedEventHandler::create(Box::new(|sender, args| {
            let args = args.unwrap();
            args.SetHandled(true)?;
            let mut user = windows::core::BOOL::default();
            args.IsUserInitiated(&mut user)?;
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = string(uri);
            if user.as_bool() && super::navigation_url(&uri).is_ok() {
                if let Some(core) = sender {
                    core.Navigate(&HSTRING::from(uri))?;
                }
            }
            Ok(())
        })),
        &mut event,
    )?;
    core.cast::<ICoreWebView2_4>()?.add_DownloadStarting(
        &DownloadStartingEventHandler::create(Box::new(|_, args| args.unwrap().SetCancel(true))),
        &mut event,
    )?;
    core.cast::<ICoreWebView2_18>()?
        .add_LaunchingExternalUriScheme(
            &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                args.unwrap().SetCancel(true)
            })),
            &mut event,
        )?;
    core.cast::<ICoreWebView2_10>()?
        .add_BasicAuthenticationRequested(
            &BasicAuthenticationRequestedEventHandler::create(Box::new(|_, args| {
                args.unwrap().SetCancel(true)
            })),
            &mut event,
        )?;
    core.cast::<ICoreWebView2_14>()?
        .add_ServerCertificateErrorDetected(
            &ServerCertificateErrorDetectedEventHandler::create(Box::new(|_, args| {
                args.unwrap()
                    .SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)
            })),
            &mut event,
        )?;
    let session = id.to_string();
    core.add_ProcessFailed(
        &ProcessFailedEventHandler::create(Box::new(move |_, _| {
            let _ = with_owner(&session, |owner| {
                invalidate(owner);
                owner.loading = false;
                owner.error = Some("Webページの表示が停止しました。再読み込みしてください".into());
                Ok(())
            });
            Ok(())
        })),
        &mut event,
    )?;
    let receiver =
        core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Runtime.executionContextCreated"))?;
    let session = id.to_string();
    receiver.add_DevToolsProtocolEventReceived(
        &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
            let mut data = PWSTR::null();
            args.unwrap().ParameterObjectAsJson(&mut data)?;
            if let Ok(value) = serde_json::from_str::<Value>(&string(data)) {
                if let (Some(name), Some(unique)) = (
                    value["context"]["name"].as_str(),
                    value["context"]["uniqueId"].as_str(),
                ) {
                    let _ = with_owner(&session, |owner| {
                        if name.starts_with("gradia-isolated-") {
                            owner.contexts.insert(name.into(), unique.into());
                        }
                        Ok(())
                    });
                }
            }
            Ok(())
        })),
        &mut event,
    )?;
    controller.SetBounds(rect(bounds))?;
    controller.SetIsVisible(true)?;
    let result = with_owner(id, |owner| {
        owner.core = Some(core);
        owner.controller = Some(controller.clone());
        owner.environment = Some(environment);
        owner.receiver = Some(receiver);
        Ok(())
    });
    if result.is_err() {
        controller.Close()?;
    }
    Ok(())
}
fn rect(bounds: BrowserBounds) -> RECT {
    RECT {
        left: bounds.x,
        top: bounds.y,
        right: bounds.x + bounds.width,
        bottom: bounds.y + bounds.height,
    }
}
pub async fn open(
    app: &AppHandle,
    id: String,
    url: String,
    profile: PathBuf,
    bounds: BrowserBounds,
) -> Result<()> {
    let deadline_id = id.clone();
    let (profile_send, profile_receive) = oneshot::channel();
    app.get_webview_window("main")
        .ok_or("メイン画面がありません")?
        .with_webview(move |webview| {
            let result = unsafe {
                webview
                    .environment()
                    .cast::<ICoreWebView2Environment7>()
                    .and_then(|environment| {
                        let mut path = PWSTR::null();
                        environment.UserDataFolder(&mut path)?;
                        Ok(string(path))
                    })
            }
            .map_err(failure)
            .and_then(|path| std::fs::canonicalize(path).map_err(failure));
            let _ = profile_send.send(result);
        })
        .map_err(failure)?;
    let trusted_profile = profile_receive.await.map_err(failure)??;
    let (reply, receive) = oneshot::channel();
    let handle = app.clone();
    on_ui(app, move || {
        if CLOSED.with(|closed| closed.borrow().contains(&id)) {
            return Err("Webページは閉じられました".into());
        }
        close_owner();
        let window = handle
            .get_webview_window("main")
            .ok_or("メイン画面がありません")?;
        let hwnd = window.hwnd().map_err(failure)?;
        OWNER.with(|slot| {
            *slot.borrow_mut() = Some(Owner {
                id: id.clone(),
                generation: 0,
                navigation_id: None,
                token: CancellationToken::new(),
                core: None,
                controller: None,
                environment: None,
                receiver: None,
                initializing: Some(reply),
                pending: HashMap::new(),
                contexts: HashMap::new(),
                object: None,
                loading: true,
                error: None,
            })
        });
        let failed_id = id.clone();
        let options = CoreWebView2EnvironmentOptions::default();
        #[cfg(debug_assertions)]
        if std::env::var_os("STUDY_TOOL_TEST_DATA_DIR").is_some() {
            if let Some(port) = std::env::var("STUDY_TOOL_BROWSER_TEST_DEBUG_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
            {
                unsafe {
                    options.set_additional_browser_arguments(format!(
                        "--remote-debugging-port={port}"
                    ));
                }
            }
        }
        let options: ICoreWebView2EnvironmentOptions = options.into();
        let result = unsafe {
            CreateCoreWebView2EnvironmentWithOptions(
                None,
                &HSTRING::from(profile.to_string_lossy().as_ref()),
                &options,
                &CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                    move |result, environment| {
                        let ready_id = id.clone();
                        let next_profile = profile.clone();
                        let trusted_profile = trusted_profile.clone();
                        let next_url = url.clone();
                        let result = result.and_then(|()| {
                            let environment =
                                environment.ok_or_else(windows::core::Error::from_thread)?;
                            let keep = environment.clone();
                            environment.CreateCoreWebView2Controller(
                                hwnd,
                                &CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
                                    move |result, controller| {
                                        let result = result.and_then(|()| {
                                            let controller = controller
                                                .ok_or_else(windows::core::Error::from_thread)?;
                                            if with_owner(&ready_id, |_| Ok(())).is_err() {
                                                controller.Close()?;
                                                return Ok(());
                                            }
                                            let installed = install(
                                                &ready_id,
                                                controller.clone(),
                                                keep,
                                                &next_profile,
                                                &trusted_profile,
                                                bounds,
                                            );
                                            if let Err(error) = installed {
                                                controller.Close()?;
                                                return Err(error);
                                            }
                                            let _ = with_owner(&ready_id, |owner| {
                                                owner
                                                    .core
                                                    .as_ref()
                                                    .ok_or("WebViewがありません")?
                                                    .Navigate(&HSTRING::from(next_url))
                                                    .map_err(failure)
                                            });
                                            Ok(())
                                        });
                                        let _ = with_owner(&ready_id, |owner| {
                                            if let Some(reply) = owner.initializing.take() {
                                                let _ = reply.send(result.map_err(failure));
                                            }
                                            Ok(())
                                        });
                                        Ok(())
                                    },
                                )),
                            )
                        });
                        if let Err(error) = result {
                            let _ = with_owner(&id, |owner| {
                                if let Some(reply) = owner.initializing.take() {
                                    let _ = reply.send(Err(failure(error)));
                                }
                                Ok(())
                            });
                        }
                        Ok(())
                    },
                )),
            )
        };
        if let Err(error) = result {
            let _ = with_owner(&failed_id, |owner| {
                if let Some(reply) = owner.initializing.take() {
                    let _ = reply.send(Err(failure(error)));
                }
                Ok(())
            });
        }
        Ok(())
    })
    .await?;
    match tokio::time::timeout(std::time::Duration::from_secs(30), receive).await {
        Ok(result) => result.map_err(failure)?,
        Err(_) => {
            close(app, deadline_id).await?;
            Err("Web表示の準備がタイムアウトしました".into())
        }
    }
}
pub async fn close(app: &AppHandle, id: String) -> Result<()> {
    on_ui(app, move || {
        CLOSED.with(|closed| {
            let mut closed = closed.borrow_mut();
            closed.push_back(id.clone());
            if closed.len() > 256 {
                closed.pop_front();
            }
        });
        if with_owner(&id, |_| Ok(())).is_ok() {
            close_owner();
        }
        Ok(())
    })
    .await
}
pub async fn status(app: &AppHandle, id: String) -> Result<BrowserStatus> {
    on_ui(app, move || {
        with_owner(&id, |owner| {
            let core = owner.core.as_ref().ok_or("Web表示の準備中です")?;
            let mut url = PWSTR::null();
            let mut title = PWSTR::null();
            let mut back = windows::core::BOOL::default();
            let mut forward = back;
            unsafe {
                core.Source(&mut url).map_err(failure)?;
                core.DocumentTitle(&mut title).map_err(failure)?;
                core.CanGoBack(&mut back).map_err(failure)?;
                core.CanGoForward(&mut forward).map_err(failure)?;
            }
            Ok(BrowserStatus {
                session_id: id.clone(),
                generation: owner.generation,
                url: string(url),
                title: string(title),
                loading: owner.loading,
                can_go_back: back.as_bool(),
                can_go_forward: forward.as_bool(),
                error: owner.error.clone(),
            })
        })
    })
    .await
}
pub async fn action(app: &AppHandle, id: String, action: super::BrowserAction) -> Result<()> {
    on_ui(app, move || {
        let (core, controller) = with_owner(&id, |owner| {
            Ok((
                owner.core.clone().ok_or("Web表示の準備中です")?,
                owner.controller.clone().ok_or("Web表示の準備中です")?,
            ))
        })?;
        unsafe {
            match action {
                super::BrowserAction::Navigate { url } => core.Navigate(&HSTRING::from(url)),
                super::BrowserAction::Back => core.GoBack(),
                super::BrowserAction::Forward => core.GoForward(),
                super::BrowserAction::Reload => core.Reload(),
                super::BrowserAction::Bounds { bounds } => controller.SetBounds(rect(bounds)),
                super::BrowserAction::Focus => {
                    controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
                }
            }
            .map_err(failure)
        }
    })
    .await
}
async fn cdp(
    app: &AppHandle,
    id: &str,
    generation: u64,
    method: &'static str,
    parameters: Value,
) -> Result<Value> {
    let operation = OPERATION.fetch_add(1, Ordering::Relaxed);
    let (reply, receive) = oneshot::channel();
    let session = id.to_string();
    on_ui(app, move || {
        let core = with_owner(&session, |owner| {
            if owner.generation != generation { return Err("ページが変わったため処理を中断しました".into()); }
            let core = owner.core.clone().ok_or("Web表示の準備中です")?;
            owner.pending.insert(operation, reply); Ok(core)
        })?;
        let callback_id = session.clone();
        let result = unsafe { core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(parameters.to_string()), &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, text| {
            let _ = with_owner(&callback_id, |owner| {
                if let Some(reply) = owner.pending.remove(&operation) {
                    let result = result.map_err(failure).and_then(|()| serde_json::from_str::<Value>(&text).map_err(failure)).and_then(|value| {
                        if value.get("error").is_some() || value.get("exceptionDetails").is_some() { Err("ページの本文を処理できませんでした。再解析してください".into()) } else { Ok(value) }
                    });
                    let _ = reply.send(result);
                } Ok(())
            }); Ok(())
        }))) };
        if let Err(error) = result { let _ = with_owner(&session, |owner| { if let Some(reply) = owner.pending.remove(&operation) { let _ = reply.send(Err(failure(error))); } Ok(()) }); }
        Ok(())
    }).await?;
    match tokio::time::timeout(std::time::Duration::from_secs(15), receive).await {
        Ok(result) => result.map_err(failure)?,
        Err(_) => {
            let session = id.to_string();
            let _ = on_ui(app, move || {
                with_owner(&session, |owner| {
                    owner.pending.remove(&operation);
                    Ok(())
                })
            })
            .await;
            Err("ページの処理がタイムアウトしました".into())
        }
    }
}
pub async fn capture(app: &AppHandle, id: &str, generation: u64) -> Result<CapturedPage> {
    let session = id.to_string();
    let (old, token) = on_ui(app, move || {
        with_owner(&session, |owner| {
            if owner.generation != generation {
                return Err("ページが変わりました".into());
            }
            Ok((owner.object.clone(), owner.token.clone()))
        })
    })
    .await?;
    if let Some(old) = old {
        // A same-document route keeps the translated DOM alive; recapturing it would lose the originals.
        let _ = cdp(app, id, generation, "Runtime.callFunctionOn", json!({"objectId":old,"functionDeclaration":include_str!("browser_apply.js"),"arguments":[{"value":[]},{"value":false}],"returnByValue":true})).await;
        let _ = cdp(
            app,
            id,
            generation,
            "Runtime.releaseObject",
            json!({"objectId":old}),
        )
        .await;
    }
    cdp(app, id, generation, "Runtime.enable", json!({})).await?;
    let tree = cdp(app, id, generation, "Page.getFrameTree", json!({})).await?;
    let frame = tree["frameTree"]["frame"]["id"]
        .as_str()
        .ok_or("ページがありません")?;
    let name = format!("gradia-isolated-{}", uuid::Uuid::new_v4());
    cdp(
        app,
        id,
        generation,
        "Page.createIsolatedWorld",
        json!({"frameId":frame,"worldName":name,"grantUniveralAccess":false}),
    )
    .await?;
    let session = id.to_string();
    let context = on_ui(app, move || {
        with_owner(&session, |owner| {
            owner
                .contexts
                .remove(&name)
                .ok_or("安全な本文解析を開始できません".into())
        })
    })
    .await?;
    let object = cdp(app, id, generation, "Runtime.evaluate", json!({"expression":include_str!("browser_dom.js"),"uniqueContextId":context,"returnByValue":false})).await?;
    let object = object["result"]["objectId"]
        .as_str()
        .ok_or("本文を解析できません")?
        .to_string();
    let session = id.to_string();
    let retained = object.clone();
    on_ui(app, move || {
        with_owner(&session, |owner| {
            if owner.generation != generation {
                return Err("ページが変わりました".into());
            }
            owner.object = Some(retained);
            Ok(())
        })
    })
    .await?;
    let metadata = cdp(app, id, generation, "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":"function(){return {segments:this.segments,title:this.title,url:this.url,truncated:this.truncated};}","returnByValue":true})).await?;
    let mut page: CapturedPage =
        serde_json::from_value(metadata["result"]["value"].clone()).map_err(failure)?;
    page.token = token;
    Ok(page)
}
pub async fn display(
    app: &AppHandle,
    id: &str,
    generation: u64,
    updates: Value,
    bilingual: bool,
) -> Result<Value> {
    let session = id.to_string();
    let object = on_ui(app, move || {
        with_owner(&session, |owner| {
            if owner.generation != generation {
                return Err("ページが変わりました。再解析してください".into());
            }
            owner.object.clone().ok_or("本文を解析してください".into())
        })
    })
    .await?;
    let response = cdp(app, id, generation, "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":include_str!("browser_apply.js"),"arguments":[{"value":updates},{"value":bilingual}],"returnByValue":true})).await?;
    Ok(response["result"]["value"].clone())
}
