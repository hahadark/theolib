//! 자동 업데이트: 새 판 확인·내려받기(서명 검증 포함)·설치·재시작.
//! 토큰은 키체인의 "app_github_url" 항목(없으면 설치된 GitHub 출처 주소)에서 읽으며 로그·화면에 남기지 않는다.
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use theolib_core::{Home, secret, source};

const SID: &str = "app_github_url";

struct Ready {
    update: Update,
    bytes: Vec<u8>,
}
static READY: Mutex<Option<Ready>> = Mutex::new(None);
static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Serialize, Clone, Default)]
pub struct UpdateState {
    pub current: String,
    /// none(최신) | ready(내려받아 설치 대기) | no_token | error | busy
    pub status: String,
    pub version: String,
    pub message: String,
}

fn token() -> Option<String> {
    let home = Home::default_location().ok()?;
    let tok = |u: &str| source::parse_github(u).and_then(|g| g.2);
    if let Ok(u) = secret::load(&home, SID) {
        let u = u.trim();
        // 주소 형태면 토큰만 뽑고, 아니면 값 자체를 토큰으로 본다.
        return tok(u).or_else(|| if u.is_empty() || u.contains("://") { None } else { Some(u.to_string()) });
    }
    for si in source::list_sources(&home).into_iter().flat_map(|s| s.sources) {
        if let Ok(u) = secret::load(&home, &format!("src-{}", si.key)) {
            if let Some(t) = tok(&u) {
                return Some(t);
            }
        }
    }
    None
}

pub fn set_token(url: &str) -> Result<(), String> {
    let home = Home::default_location().map_err(|x| x.to_string())?;
    let url = url.trim();
    if url.is_empty() {
        return secret::delete(&home, SID).map_err(|x| x.to_string());
    }
    secret::store(&home, SID, url).map_err(|x| x.to_string())
}

fn state(app: &AppHandle, status: &str, version: &str, message: &str) -> UpdateState {
    UpdateState { current: app.package_info().version.to_string(), status: status.into(), version: version.into(), message: message.into() }
}

/// 시험용: THEOLIB_UPDATE_ENDPOINT 가 loopback 주소일 때만 확인 주소를 바꾼다(서명 검증은 그대로).
fn endpoint_override() -> Option<url::Url> {
    let v = std::env::var("THEOLIB_UPDATE_ENDPOINT").ok()?;
    let u = url::Url::parse(&v).ok()?;
    matches!(u.host_str(), Some("127.0.0.1") | Some("localhost")).then_some(u)
}

pub fn current_state(app: &AppHandle) -> UpdateState {
    if let Some(r) = READY.lock().unwrap().as_ref() {
        return state(app, "ready", &r.update.version, "");
    }
    state(app, "none", "", "")
}

/// manual=true 면 토큰 없음·실패도 알린다. false 면 조용히 넘어간다.
pub async fn check(app: &AppHandle, manual: bool) -> UpdateState {
    use std::sync::atomic::Ordering;
    if let Some(r) = READY.lock().unwrap().as_ref() {
        return state(app, "ready", &r.update.version, "");
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return state(app, "busy", "", "이미 확인 중입니다.");
    }
    let out = check_inner(app, manual).await;
    BUSY.store(false, Ordering::SeqCst);
    out
}

async fn check_inner(app: &AppHandle, manual: bool) -> UpdateState {
    // 공개 저장소면 토큰 없이 확인한다(비공개 저장소일 때만 토큰을 붙인다).
    let tok = token();
    let quiet_err = |m: &str| if manual { state(app, "error", "", m) } else { state(app, "none", "", "") };
    let mut b = app.updater_builder();
    if let Some(u) = endpoint_override() {
        b = match b.endpoints(vec![u]) {
            Ok(b) => b,
            Err(_) => return quiet_err("확인 주소가 올바르지 않습니다."),
        };
    }
    let b = match tok {
        Some(tok) => match b.header("Authorization", format!("Bearer {tok}")) {
            Ok(b) => b,
            Err(_) => return quiet_err("토큰 형식이 올바르지 않습니다."),
        },
        None => b,
    };
    let updater = match b.build() {
        Ok(u) => u,
        Err(_) => return quiet_err("업데이트를 준비하지 못했습니다."),
    };
    let upd = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return state(app, "none", "", "지금 최신 판입니다."),
        Err(_) => return quiet_err("업데이트를 확인하지 못했습니다(네트워크 또는 접근 권한)."),
    };
    let ver = upd.version.clone();
    let (mut done, a2) = (0u64, app.clone());
    let v2 = ver.clone();
    let bytes = upd
        .download(
            move |n, total| {
                done += n as u64;
                let _ = a2.emit("update-progress", serde_json::json!({ "version": v2, "done": done, "total": total.unwrap_or(0) }));
            },
            || {},
        )
        .await;
    match bytes {
        Ok(bytes) => {
            *READY.lock().unwrap() = Some(Ready { update: upd, bytes });
            let s = state(app, "ready", &ver, "");
            let _ = app.emit("update-ready", s.clone());
            // 시험 전용: 확인 주소를 loopback 으로 바꾼 경우에만, 환경변수로 사용자 클릭을 대신한다.
            if endpoint_override().is_some() && std::env::var("THEOLIB_UPDATE_AUTOINSTALL").is_ok() {
                let _ = install_and_restart(app);
            }
            s
        }
        // 서명이 틀리거나 받기 실패: 설치하지 않는다.
        Err(err) => {
            let m = err.to_string();
            quiet_err(if m.to_lowercase().contains("signature") { "서명 검증에 실패해 설치하지 않았습니다." } else { "새 판을 내려받지 못했습니다." })
        }
    }
}

pub fn install_and_restart(app: &AppHandle) -> Result<(), String> {
    let r = READY.lock().unwrap().take().ok_or("설치할 새 판이 없습니다.")?;
    r.update.install(&r.bytes).map_err(|_| "설치하지 못했습니다.".to_string())?;
    app.restart()
}

/// 앱 시작 30초 뒤, 이후 24시간마다 조용히 확인.
pub fn spawn_auto(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(30)).await;
        loop {
            let _ = check(&app, false).await;
            tokio_sleep(Duration::from_secs(24 * 3600)).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}
