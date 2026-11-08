use crate::{model::Result, AppState};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const RELEASES_API: &str = "https://api.github.com/repos/k-zshiba/Gradia/releases/latest";
const ASSET_PREFIX: &str = "/repos/k-zshiba/Gradia/releases/assets/";

#[derive(Deserialize)]
struct Asset {
    name: String,
    url: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

struct Plan {
    version: String,
    manifest: Url,
    installer: Url,
}

fn asset_url(asset: &Asset) -> Result<Url> {
    let url = Url::parse(&asset.url).map_err(|e| e.to_string())?;
    let id = url.path().strip_prefix(ASSET_PREFIX).unwrap_or("");
    if url.scheme() != "https"
        || url.host_str() != Some("api.github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || id.is_empty()
        || !id.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("更新ファイルのURLが正しくありません".into());
    }
    Ok(url)
}

fn plan(release: &Release, current: &Version) -> Result<Option<Plan>> {
    if release.draft || release.prerelease {
        return Ok(None);
    }
    let version = release.tag_name.strip_prefix('v').unwrap_or("");
    let remote = Version::parse(version).map_err(|e| e.to_string())?;
    if !remote.pre.is_empty() || remote <= *current {
        return Ok(None);
    }
    let find = |name: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == name)
            .ok_or_else(|| format!("Releaseに{name}がありません"))
            .and_then(asset_url)
    };
    Ok(Some(Plan {
        version: version.into(),
        manifest: find("latest.json")?,
        installer: find(&format!("Gradia_{version}_x64-setup.exe"))?,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    rid: u32,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

/// Resolve public release assets through GitHub's API. The updater still parses
/// the signed manifest and verifies the installer with the embedded public key.
#[tauri::command]
pub async fn check_release_update(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfo>> {
    let response = state
        .http
        .get(RELEASES_API)
        .header(
            "User-Agent",
            format!("Gradia/{}", app.package_info().version),
        )
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let release = response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Release>()
        .await
        .map_err(|e| e.to_string())?;
    let Some(plan) = plan(&release, &app.package_info().version)? else {
        return Ok(None);
    };
    let updater = webview
        .updater_builder()
        .endpoints(vec![plan.manifest])
        .map_err(|e| e.to_string())?
        .header("Accept", "application/octet-stream")
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(mut update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if update.version != plan.version {
        return Err("Releaseと更新情報のバージョンが一致しません".into());
    }
    update.download_url = plan.installer;
    let metadata = UpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.raw_json["pub_date"].as_str().map(str::to_owned),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    };
    Ok(Some(metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release() -> Release {
        serde_json::from_value(serde_json::json!({
            "tag_name": "v0.2.1", "draft": false, "prerelease": false,
            "assets": [
                {"name": "latest.json", "url": format!("https://api.github.com{ASSET_PREFIX}123")},
                {"name": "Gradia_0.2.1_x64-setup.exe", "url": format!("https://api.github.com{ASSET_PREFIX}456")}
            ]
        })).unwrap()
    }

    #[test]
    fn resolves_a_new_stable_release() {
        let p = plan(&release(), &Version::new(0, 2, 0)).unwrap().unwrap();
        assert_eq!(p.version, "0.2.1");
        assert!(p.manifest.path().ends_with("/123"));
        assert!(p.installer.path().ends_with("/456"));
    }

    #[test]
    fn skips_old_equal_draft_and_prerelease_versions() {
        let mut r = release();
        for current in [Version::new(0, 2, 1), Version::new(1, 0, 0)] {
            assert!(plan(&r, &current).unwrap().is_none());
        }
        r.draft = true;
        assert!(plan(&r, &Version::new(0, 1, 0)).unwrap().is_none());
        r.draft = false;
        r.prerelease = true;
        assert!(plan(&r, &Version::new(0, 1, 0)).unwrap().is_none());
        r.prerelease = false;
        r.tag_name = "v0.3.0-rc.1".into();
        assert!(plan(&r, &Version::new(0, 1, 0)).unwrap().is_none());
    }

    #[test]
    fn rejects_unexpected_asset_urls() {
        for url in [
            "http://api.github.com/repos/k-zshiba/Gradia/releases/assets/1",
            "https://example.com/repos/k-zshiba/Gradia/releases/assets/1",
            "https://api.github.com/repos/other/Gradia/releases/assets/1",
            "https://api.github.com/repos/k-zshiba/Gradia/releases/assets/1?token=foo",
            "https://user@api.github.com/repos/k-zshiba/Gradia/releases/assets/1",
            "https://api.github.com/repos/k-zshiba/Gradia/releases/assets/abc",
        ] {
            assert!(asset_url(&Asset {
                name: "asset".into(),
                url: url.into()
            })
            .is_err());
        }
    }

    #[test]
    fn rejects_an_incomplete_release() {
        let mut r = release();
        r.assets.pop();
        assert!(plan(&r, &Version::new(0, 2, 0)).is_err());
    }
}
