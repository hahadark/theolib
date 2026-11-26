//! 웹 서재 세션(로그인·쿠키)과 API 호출.
//! 쿠키·MCP 주소는 보안 저장소(서비스 `theolib-web`, 계정 cookie/mcp)에 둔다.
//! THEOLIB_KEYSTORE=file 이면 <root>/study/web.json(시험용).
use crate::Home;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// 빌드할 때 THEOLIB_DEFAULT_BASE 환경변수로 넣는 기본 서재 주소. 없으면 빈 문자열(사용자가 설정에서 넣는다).
pub const DEFAULT_BASE: &str = match option_env!("THEOLIB_DEFAULT_BASE") { Some(v) => v, None => "" };

/// 서재 주소가 비었을 때의 오류 문구.
pub const NO_BASE_MSG: &str = "서재 주소가 설정되지 않았습니다. 설정의 계정에서 서재 주소를 넣어 주세요.";
pub const SERVICE: &str = "theolib-web";
pub const COOKIE_ACCOUNT: &str = "cookie";
pub const MCP_ACCOUNT: &str = "mcp";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WebStatus {
    pub base: String,
    pub logged_in: bool,
    pub user: String,
    pub role: String,
    pub owner: bool,
    pub pc_off: bool,
    pub has_mcp: bool,
}

impl Default for WebStatus {
    fn default() -> Self {
        WebStatus { base: String::new(), logged_in: false, user: String::new(), role: String::new(), owner: false, pc_off: false, has_mcp: false }
    }
}

/// 서재 자료 받기 주소(2.1 절). `url` 은 비밀값이므로 오류·로그에 넣지 않는다.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppSource {
    pub can: bool,
    /// "github" | "server" | "" (can 이 false 거나 아무 주소도 없을 때 빈 문자열).
    pub kind: String,
    /// 주소(비밀값). 없으면 null 로 직렬화된다.
    pub url: Option<String>,
    pub files: Value,
}

// ---- 키 저장(secret.rs 와 같은 정책, 서비스만 theolib-web) ----

fn use_file() -> bool {
    std::env::var("THEOLIB_KEYSTORE").map(|v| v == "file").unwrap_or(false)
}

fn web_file(home: &Home) -> std::path::PathBuf {
    crate::study::study_dir(home).join("web.json")
}

fn read_map(home: &Home) -> BTreeMap<String, String> {
    std::fs::read(web_file(home)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_map(home: &Home, m: &BTreeMap<String, String>) -> Result<()> {
    let d = crate::study::study_dir(home);
    std::fs::create_dir_all(&d)?;
    std::fs::write(web_file(home), serde_json::to_vec(m)?)?;
    Ok(())
}

/// 보안 저장소에 값을 저장한다(웹·MCP 공용).
pub fn store_secret(home: &Home, account: &str, val: &str) -> Result<()> {
    if use_file() {
        let mut m = read_map(home);
        m.insert(account.into(), val.into());
        return write_map(home, &m);
    }
    keyring::Entry::new(SERVICE, account)?.set_password(val).context("보안 저장소에 저장하지 못했습니다")
}

pub fn load_secret(home: &Home, account: &str) -> Option<String> {
    if use_file() {
        return read_map(home).get(account).cloned();
    }
    keyring::Entry::new(SERVICE, account).ok().and_then(|e| e.get_password().ok())
}

pub fn clear_secret(home: &Home, account: &str) -> Result<()> {
    if use_file() {
        let mut m = read_map(home);
        m.remove(account);
        return write_map(home, &m);
    }
    if let Ok(e) = keyring::Entry::new(SERVICE, account) {
        let _ = e.delete_credential();
    }
    Ok(())
}

// ---- 쿠키/요청 ----

/// 웹 서재 주소. THEOLIB_WEB_BASE(실행 때, 시험용) → settings.web_base → DEFAULT_BASE 순.
/// 끝의 `/` 는 뗀다. 모두 비면 빈 문자열(연결을 시도하지 않는다).
pub fn base(home: &Home) -> String {
    if let Ok(b) = std::env::var("THEOLIB_WEB_BASE") {
        let b = b.trim().trim_end_matches('/');
        if !b.is_empty() {
            return b.to_string();
        }
    }
    let s = crate::study::settings::load(home);
    let s = s.web_base.trim().trim_end_matches('/');
    if !s.is_empty() {
        return s.to_string();
    }
    DEFAULT_BASE.trim().trim_end_matches('/').to_string()
}

/// 주소가 비어 있으면 연결을 시도하지 않고 오류를 돌려준다.
fn need_base(home: &Home) -> Result<String> {
    let b = base(home);
    if b.is_empty() {
        bail!(NO_BASE_MSG);
    }
    Ok(b)
}

/// 화면(설정의 계정)이 읽는 서재 주소 상태.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaseInfo {
    pub base: String,
    /// 빌드에 든 기본값을 쓰는 중인가.
    #[serde(rename = "default")]
    pub is_default: bool,
    /// 빌드에 기본값이 들어 있는가.
    pub has_default: bool,
}

pub fn base_info(home: &Home) -> BaseInfo {
    let b = base(home);
    let built = DEFAULT_BASE.trim().trim_end_matches('/');
    let has_default = !built.is_empty();
    BaseInfo { base: b.clone(), is_default: has_default && b == built, has_default }
}

// ---- 기본 브라우저로 웹 서재 화면 열기 ----

/// 브라우저로 열어도 되는 웹 서재 화면. 그 밖의 경로는 거절한다(열린 주소로 무엇이든 열지 않게).
const OPEN_PATHS: [&str; 6] = ["/signup", "/login", "/", "/#/profile", "/#/study", "/#/me/sermons"];

pub fn allowed_open_path(path: &str) -> bool {
    OPEN_PATHS.contains(&path)
}

/// 브라우저로 열 주소를 만든다(순수 함수 — 실제로 열지 않는다).
/// 허용하지 않은 경로면 오류, 서재 주소가 비어 있으면 [`NO_BASE_MSG`].
pub fn browser_url(home: &Home, path: &str) -> Result<String> {
    if !allowed_open_path(path) {
        bail!("허용되지 않은 주소입니다.");
    }
    let base = need_base(home)?;
    Ok(format!("{base}{path}"))
}

/// 웹 서재 화면(가입·로그인·프로필)을 기본 브라우저로 연다. 허용한 path 만.
pub fn open_in_browser(home: &Home, path: &str) -> Result<()> {
    let url = browser_url(home, path)?;
    let mut c = if cfg!(windows) {
        // cmd 를 거치면 & 같은 글자가 문제가 되므로 rundll32 로 바로 넘긴다.
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(&url);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    // 검은 콘솔 창이 뜨지 않게 한다(Windows).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.spawn().map_err(|x| anyhow::anyhow!("브라우저를 열지 못했습니다. ({x})"))?;
    Ok(())
}

/// 시험용으로 http://127.0.0.1·http://localhost 도 받는다(그 밖에는 https:// 만).
fn plain_http_ok(u: &str) -> bool {
    for h in ["http://127.0.0.1", "http://localhost"] {
        if let Some(rest) = u.strip_prefix(h) {
            if rest.starts_with(':') || rest.starts_with('/') {
                return true;
            }
        }
    }
    false
}

/// 서재 주소를 settings.json 의 web_base 에 저장한다. 빈 문자열이면 web_base 를 지워 기본값으로 돌린다.
/// 주소가 바뀌므로 로그인 상태(쿠키·MCP 주소)와 status 캐시를 지운다.
pub fn set_base(home: &Home, url: &str) -> Result<()> {
    let u = url.trim().trim_end_matches('/');
    if u.is_empty() {
        clear_web_base(home)?;
    } else {
        if !(u.starts_with("https://") || plain_http_ok(u)) {
            bail!("서재 주소는 https:// 로 시작해야 합니다.");
        }
        crate::study::settings::save(home, &json!({ "web_base": u }))?;
    }
    clear_secret(home, COOKIE_ACCOUNT)?;
    clear_secret(home, MCP_ACCOUNT)?;
    clear_cache();
    Ok(())
}

/// settings.json 에서 web_base 칸만 지운다(다른 칸은 그대로).
fn clear_web_base(home: &Home) -> Result<()> {
    let p = crate::study::settings::settings_path(home);
    let mut cur: Value = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    if let Some(o) = cur.as_object_mut() {
        o.remove("web_base");
    }
    let d = crate::study::study_dir(home);
    std::fs::create_dir_all(&d)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&cur)?)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

fn cookie_header(home: &Home) -> String {
    load_secret(home, COOKIE_ACCOUNT).unwrap_or_default()
}

fn set_cookie_value(home: &Home, set_cookie: &str) -> Result<()> {
    // "이름=값; Path=/; …" 에서 이름=값 만 떼어 낸다.
    let name_val = set_cookie.split(';').next().unwrap_or("").trim().to_string();
    if name_val.contains('=') {
        store_secret(home, COOKIE_ACCOUNT, &name_val)?;
    }
    Ok(())
}

fn error_of(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Timeout(_) | ureq::Error::Io(_) => anyhow::anyhow!("서재 서버에 연결하지 못했습니다."),
        other => anyhow::anyhow!("서재 서버에 연결하지 못했습니다 ({}).", other.to_string().chars().take(40).collect::<String>()),
    }
}

/// 상태 코드별 오류. 쿠키·주소는 넣지 않는다.
pub fn explain_status(code: u16) -> String {
    match code {
        401 => "로그인이 풀렸습니다. 다시 로그인해 주세요.".into(),
        403 => "권한이 없습니다.".into(),
        404 => "요청한 자료를 찾지 못했습니다.".into(),
        _ => format!("서재 서버가 오류를 돌려주었습니다({code})."),
    }
}

fn agent(timeout_s: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_body(Some(Duration::from_secs(timeout_s)))
        .http_status_as_error(false)
        .max_redirects(0) // 리다이렉트를 따라가지 않는다(303 의 Set-Cookie 를 읽어야 한다)
        .build()
        .into()
}

fn read_body(r: &mut ureq::http::Response<ureq::Body>) -> String {
    let mut s = String::new();
    let _ = r.body_mut().as_reader().take(8 << 20).read_to_string(&mut s);
    s
}

/// POST BASE/login (form id, pw 퍼센트 인코딩). 303 + Set-Cookie 면 성공.
pub fn login(home: &Home, id: &str, pw: &str) -> Result<WebStatus> {
    let base = need_base(home)?;
    let form = format!("id={}&pw={}", pct(id), pct(pw));
    let r = agent(30)
        .post(&format!("{base}/login"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .send(&form)
        .map_err(error_of)?;
    let code = r.status().as_u16();
    if code == 303 || code == 302 {
        let set_cookie = r.headers().get("set-cookie").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if set_cookie.is_empty() {
            bail!("로그인 응답에 세션이 없습니다.");
        }
        set_cookie_value(home, &set_cookie)?;
        // MCP 주소 받기(관리자만). 403 이면 그냥 둔다.
        let _ = fetch_mcp(home);
        clear_cache();
        return Ok(status(home));
    }
    if code == 401 || code == 400 {
        bail!("아이디나 비밀번호가 맞지 않습니다.");
    }
    bail!(explain_status(code));
}

fn pct(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 로그인 뒤 GET /api/me/mcp 로 {url} 을 받아 저장(관리자만. 403 이면 그냥 둔다).
fn fetch_mcp(home: &Home) -> Result<()> {
    let base = need_base(home)?;
    let mut r = agent(30)
        .get(&format!("{base}/api/me/mcp"))
        .header("Cookie", &cookie_header(home))
        .header("Accept", "application/json")
        .call()
        .map_err(error_of)?;
    if r.status().as_u16() != 200 {
        return Ok(());
    }
    let body = read_body(&mut r);
    if let Ok(j) = serde_json::from_str::<Value>(&body) {
        if let Some(u) = j.get("url").and_then(|v| v.as_str()) {
            crate::mcp::set_url(home, u)?;
        }
    }
    Ok(())
}

pub fn logout(home: &Home) -> Result<()> {
    clear_secret(home, COOKIE_ACCOUNT)?;
    clear_secret(home, MCP_ACCOUNT)?;
    clear_cache();
    Ok(())
}

/// 게스트 로그인. POST BASE/guest (form `pw`). 303 + Set-Cookie 면 성공.
/// 실패 문구 "공통 비밀번호가 맞지 않습니다."
pub fn guest_login(home: &Home, pw: &str) -> Result<WebStatus> {
    let base = need_base(home)?;
    let form = format!("pw={}", pct(pw));
    let r = agent(30)
        .post(&format!("{base}/guest"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .send(&form)
        .map_err(error_of)?;
    let code = r.status().as_u16();
    if code == 303 || code == 302 {
        let set_cookie = r.headers().get("set-cookie").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if set_cookie.is_empty() {
            bail!("로그인 응답에 세션이 없습니다.");
        }
        set_cookie_value(home, &set_cookie)?;
        clear_cache();
        return Ok(status(home));
    }
    // 서버가 주는 실패 문구(공통 비밀번호)를 그대로 쓴다.
    bail!("공통 비밀번호가 맞지 않습니다.");
}

/// 회원·게스트용 서버 AI 키 정보(GET /api/me/aikeys). 로그인 상태에서만 부르며, 실패하면 None.
pub fn aikeys(home: &Home) -> Option<Value> {
    let st = status(home);
    if !st.logged_in {
        return None;
    }
    api(home, "GET", "/api/me/aikeys", None).ok().filter(|o| o.status == 200).map(|o| o.body)
}

/// 서재 자료 받기 주소. GET /api/me/app-key → {can, url, github, files}.
/// github 가 있으면 kind "github", 없고 url 이 있으면 "server",
/// 둘 다 없으면 POST /api/me/app-key(본문 {})로 새 주소를 발급받는다(주소가 이미 있을 땐 POST 하지 않는다).
pub fn app_source(home: &Home) -> Result<AppSource> {
    let base = need_base(home)?;
    let cookie = cookie_header(home);
    let mut r = agent(30)
        .get(&format!("{base}/api/me/app-key"))
        .header("Cookie", &cookie)
        .header("Accept", "application/json")
        .call()
        .map_err(error_of)?;
    let code = r.status().as_u16();
    if code == 401 {
        bail!("로그인이 풀렸습니다. 다시 로그인해 주세요.");
    }
    if code != 200 {
        bail!(explain_status(code));
    }
    let body = read_body(&mut r);
    let j: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let can = j.get("can").and_then(|v| v.as_bool()).unwrap_or(false);
    let files = j.get("files").cloned().unwrap_or(Value::Null);
    if !can {
        return Ok(AppSource { can: false, kind: String::new(), url: None, files });
    }
    if let Some(gh) = j.get("github").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Ok(AppSource { can: true, kind: "github".into(), url: Some(gh.to_string()), files });
    }
    if let Some(u) = j.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Ok(AppSource { can: true, kind: "server".into(), url: Some(u.to_string()), files });
    }
    // 주소가 하나도 없을 때만 POST 로 새로 발급받는다(기존 주소를 바꾸지 않게).
    let mut mr = agent(30)
        .post(&format!("{base}/api/me/app-key"))
        .header("Cookie", &cookie)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Origin", &base)
        .send(b"{}")
        .map_err(error_of)?;
    let mcode = mr.status().as_u16();
    let mbody = read_body(&mut mr);
    let mj: Value = serde_json::from_str(&mbody).unwrap_or(json!({}));
    if mcode == 200 {
        if let Some(u) = mj.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            return Ok(AppSource { can: true, kind: "server".into(), url: Some(u.to_string()), files });
        }
    }
    Ok(AppSource { can: true, kind: String::new(), url: None, files })
}

// ---- status 캐시(60초, 프로세스 안) ----

struct Cache {
    at: Instant,
    st: WebStatus,
}
static CACHE: std::sync::Mutex<Option<Cache>> = std::sync::Mutex::new(None);

fn clear_cache() {
    *CACHE.lock().unwrap() = None;
}

/// GET /api/me 로 세션 확인. 쿠키 없으면 기본. 401 이면 logged_in=false 로 쿠키 지움.
/// 서재 주소가 비어 있으면 연결을 시도하지 않고 logged_in=false, base="" 를 돌려준다.
pub fn status(home: &Home) -> WebStatus {
    let base = base(home);
    if base.is_empty() {
        return WebStatus::default();
    }
    {
        let g = CACHE.lock().unwrap();
        if let Some(c) = g.as_ref() {
            if c.st.base == base && c.at.elapsed() < Duration::from_secs(60) {
                return c.st.clone();
            }
        }
    }
    let mut st = WebStatus { base: base.clone(), ..Default::default() };
    st.has_mcp = load_secret(home, MCP_ACCOUNT).is_some();
    let cookie = cookie_header(home);
    if cookie.is_empty() {
        let _ = CACHE.lock().unwrap().replace(Cache { at: Instant::now(), st: st.clone() });
        return st;
    }
    match agent(30).get(&format!("{base}/api/me")).header("Cookie", &cookie).header("Accept", "application/json").call() {
        Ok(mut r) => {
            let code = r.status().as_u16();
            let body = read_body(&mut r);
            if code == 200 {
                if let Ok(j) = serde_json::from_str::<Value>(&body) {
                    st.logged_in = true;
                    st.user = j.get("user").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    st.role = j.get("role").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    st.owner = j.get("owner").and_then(|v| v.as_bool()).unwrap_or(false);
                    st.pc_off = j.get("pc_off").and_then(|v| v.as_bool()).unwrap_or(false);
                }
            } else if code == 401 {
                // 쿠키 지움
                let _ = clear_secret(home, COOKIE_ACCOUNT);
                st.logged_in = false;
            }
        }
        Err(_) => {
            // 연결 실패면 쿠키는 두고 로그인 상태만 표시하지 않는다.
        }
    }
    let _ = CACHE.lock().unwrap().replace(Cache { at: Instant::now(), st: st.clone() });
    st
}

// ---- api() ----

#[derive(Clone, Debug)]
pub struct ApiOut {
    pub status: u16,
    pub body: Value,
}

/// 허용 경로 목록. `/api/study/` 는 접두사, 나머지는 정확히 일치. `?` 앞부분으로 판정.
const ALLOWED: [&str; 21] = [
    "/api/me",
    "/api/me/sermons",
    "/api/me/mcp",
    "/api/me/sermon-preferences",
    "/api/me/ai-pref",
    "/api/me/aikeys",
    "/api/me/aitest",
    "/api/me/app-key",
    "/api/study/",
    "/api/pages",
    "/api/page",
    "/api/toc",
    "/api/search",
    "/api/books",
    "/api/passage",
    "/api/meta",
    // 설교 설계도와 담아 둔 자료
    "/api/me/plans",
    "/api/me/plans/",
    "/api/me/clips",
    "/api/me/basket",
    // 주석 글 AI 보정본 나누기(올리기·받기)
    "/api/fix/",
];

pub fn allowed_path(path: &str) -> bool {
    // .. 이나 // 가 든 경로는 거절
    if path.contains("..") || path.contains("//") {
        return false;
    }
    let query = path.split('?').next().unwrap_or(path);
    for a in ALLOWED {
        if a.ends_with('/') {
            if query.starts_with(a) {
                return true;
            }
        } else if query == a {
            return true;
        }
    }
    false
}

/// 웹 서재 API 호출. path 는 쿼리 포함 문자열, 허용 경로만.
pub fn api(home: &Home, method: &str, path: &str, body: Option<&Value>) -> Result<ApiOut> {
    if !allowed_path(path) {
        bail!("허용되지 않은 경로입니다.");
    }
    if method != "GET" && method != "POST" {
        bail!("허용되지 않은 방법입니다.");
    }
    let base = need_base(home)?;
    let url = format!("{base}{path}");
    let cookie = cookie_header(home);
    let timeout = if path.starts_with("/api/study/") || path.contains("appprompt") { 90 } else { 30 };
    // 메서드에 따라 요청을 만든다(GET/POST 로 나빠진 타입을 피하려고 한 번에 보낸다).
    let mut r = if method == "POST" {
        let payload = body.map(|b| serde_json::to_vec(b).unwrap_or_default()).unwrap_or_default();
        if payload.is_empty() {
            agent(timeout)
                .post(&url)
                .header("Cookie", &cookie)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("Origin", &base)
                .send(b"")
        } else {
            agent(timeout)
                .post(&url)
                .header("Cookie", &cookie)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("Origin", &base)
                .send(payload.as_slice())
        }
    } else {
        agent(timeout)
            .get(&url)
            .header("Cookie", &cookie)
            .header("Accept", "application/json")
            .call()
    }
    .map_err(error_of)?;
    let code = r.status().as_u16();
    let text = read_body(&mut r);
    if code == 401 {
        bail!("로그인이 풀렸습니다. 다시 로그인해 주세요.");
    }
    let j: Value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or_else(|_| json!({"raw": text}))
    };
    if code == 503 && j.get("pc_off").is_some() {
        // pc_off 는 status() 가 표시하도록 캐시를 비운다.
        clear_cache();
    }
    Ok(ApiOut { status: code, body: j })
}

/// 원본 스캔 그림(GET /img?book=&page=, JPEG).
pub fn image(home: &Home, book: &str, page: i64) -> Result<Vec<u8>> {
    let base = need_base(home)?;
    let url = format!("{base}/img?book={}&page={page}", pct(book));
    let cookie = cookie_header(home);
    let r = agent(30).get(&url).header("Cookie", &cookie).call().map_err(error_of)?;
    let code = r.status().as_u16();
    if code != 200 {
        bail!(explain_status(code));
    }
    let mut buf = Vec::new();
    r.into_body().as_reader().take(32 << 20).read_to_end(&mut buf).context("그림을 끝까지 받지 못했습니다.")?;
    Ok(buf)
}

use std::io::Read;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_info_json_keys() {
        let i = BaseInfo { base: "https://x".into(), is_default: true, has_default: true };
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["base"], "https://x");
        assert_eq!(v["default"], true);
        assert_eq!(v["has_default"], true);
    }

    #[test]
    fn percent_encoding() {
        assert_eq!(pct("abc123"), "abc123");
        assert_eq!(pct("a b"), "a%20b");
        assert_eq!(pct("한글"), "%ED%95%9C%EA%B8%80");
    }

    #[test]
    fn allowed_paths() {
        assert!(allowed_path("/api/me"));
        assert!(allowed_path("/api/study/appprompt"));
        assert!(allowed_path("/api/me/sermons?ref=%ED%96%89%206&full=1"));
        assert!(!allowed_path("/api/me/sermons/12"));
        assert!(allowed_path("/api/study/sources?ref=x"));
        assert!(allowed_path("/api/pages?book=a&page=1"));
        assert!(!allowed_path("/api/study/../secret"));
        assert!(!allowed_path("/api//me"));
        assert!(!allowed_path("/etc/passwd"));
        assert!(!allowed_path("/api/other"));
        // .. 은 쿼리에도 막는다
        assert!(!allowed_path("/api/pages?x=../etc"));
    }
}
