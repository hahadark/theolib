//! 구독형 AI 명령줄 도구(Claude Code CLI `claude`, Codex CLI `codex`)를 찾아 실행한다.
//!
//! 웹판 실행기의 `run_claude`·`run_codex`·`LIMIT_RE`·`_kill` 과
//! 같은 동작(명령 인자·stdin·출력 해석·오류·한도·멈춤 처리)을 Rust 로 옮긴다.
//! 설계 기준: `docs/AI_STUDY_DESIGN.md` 2.3 절.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use serde_json::{json, Value};

/// 실행 시간 제한(40분, 밀리초).
const TIMEOUT_MS: u64 = 40 * 60 * 1000;
/// `--version` 확인 시간 제한(초).
const VERSION_TIMEOUT_S: u64 = 5;
/// `quick_test` 시간 제한(초).
const QUICK_TIMEOUT_S: u64 = 60;
/// stdout 줄을 받는 본 루프의 채널 수신 시간 제한(밀리초).
const CHANNEL_POLL_MS: u64 = 200;
/// 오류 문구에 싣는 stderr 끝부분 길이.
const ERR_TAIL: usize = 2000;
/// 도구 결과 글로 올리는 최대 길이.
const TOOL_RESULT_MAX: usize = 4000;
/// `quick_test` 답 최대 길이.
const QUICK_ANSWER_MAX: usize = 200;
/// Windows `CREATE_NO_WINDOW`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// claude stream-json result 이벤트의 usage 네 칸.
const USAGE_KEYS: [&str; 4] = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
];

/// study.py `LIMIT_RE` 를 대소문자 무시 부분 문자열로 옮긴 목록.
const LIMIT_PATTERNS: [&str; 10] = [
    "usage limit",
    "rate limit",
    "limit reached",
    "hit your limit",
    "5-hour",
    "weekly limit",
    "reset at",
    "resets at",
    "overloaded",
    "credit balance",
];

/// 찾은(또는 못 찾은) CLI 정보.
pub struct CliInfo {
    pub id: String,
    pub found: bool,
    pub path: String,
    pub version: String,
}

/// 실행 요청.
pub struct CliReq {
    pub system: String,
    pub user: String,
    pub model: String,
    pub mcp_url: String,
    pub max_turns: u32,
    pub work_dir: PathBuf,
    pub resume: Option<String>,
}

/// 진행 단계 한 칸. 도구 호출이면 `on` 의 둘째 값 `Some((도구 이름, 인자))` 가 함께 온다.
pub struct Step {
    /// info|tool|think|write|tool_result|error
    pub kind: String,
    pub text: String,
    /// 도구 호출 식별자(API `tool_calls[].id`, claude `tool_use.id` ↔ `tool_result.tool_use_id`, codex `item.id`).
    /// tool 과 tool_result 단계에서 채운다(결과가 왔을 때 제목을 고쳐 쓰기 위해).
    pub call_id: Option<String>,
}

/// 실행 결과.
pub struct RunOut {
    /// done|error|stopped|limit
    pub status: String,
    pub md: String,
    pub error: String,
    pub engine: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cost: Option<f64>,
    pub tokens: Value,
    pub turns_used: Option<i64>,
}

/// `detect(id)` 결과 60초 메모리 캐시.
static DETECT_CACHE: OnceLock<Mutex<HashMap<String, (Instant, CliInfo)>>> = OnceLock::new();

fn detect_cache() -> &'static Mutex<HashMap<String, (Instant, CliInfo)>> {
    DETECT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn clone_info(i: &CliInfo) -> CliInfo {
    CliInfo {
        id: i.id.clone(),
        found: i.found,
        path: i.path.clone(),
        version: i.version.clone(),
    }
}

/// MCP 임시 파일의 수명을 묶는 Drop 가드. 함수가 모든 경로로 끝날 때 파일을 지운다.
struct McpFileGuard(Option<PathBuf>);

impl Drop for McpFileGuard {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            let _ = fs::remove_file(&f);
        }
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// 출력(오류 포함)에 토큰이 든 MCP 주소가 보이면 `…` 로 가린다.
fn mask_mcp_url(mcp_url: &str, text: &str) -> String {
    if mcp_url.is_empty() {
        text.to_string()
    } else {
        text.replace(mcp_url, "…")
    }
}

// ---------------------------------------------------------------------------
// 찾기
// ---------------------------------------------------------------------------

/// Windows 레지스트리의 사용자·시스템 PATH 를 읽어 후보 디렉터리 목록을 돌려준다.
/// 설치 직후 앱 프로세스의 PATH 가 옛 값이므로 `reg query` 로 직접 읽는다.
#[cfg(windows)]
fn registry_path_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for key in [
        r"HKCU\Environment",
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    ] {
        let cmd = Command::new("reg")
            .arg("query")
            .arg(key)
            .arg("/v")
            .arg("Path")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        if let Ok(o) = cmd {
            let text = String::from_utf8_lossy(&o.stdout);
            // "    Path    REG_EXPAND_SZ    C:\a;C:\b" 꼴. 마지막 값 필드만 취한다.
            if let Some(line) = text.lines().find(|l| l.trim_start().starts_with("Path")) {
                if let Some(idx) = line.find("REG_") {
                    let val = line[idx..].trim();
                    // REG_SZ / REG_EXPAND_SZ / REG_MULTI_SZ 접미 제거
                    for suffix in ["REG_EXPAND_SZ", "REG_MULTI_SZ", "REG_SZ"] {
                        if let Some(rest) = val.strip_prefix(suffix) {
                            for d in rest.split(';') {
                                let d = d.trim();
                                if !d.is_empty() {
                                    out.push(PathBuf::from(d));
                                }
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn registry_path_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// `find_in_path` 후보를 넓힌 목록(PATH + 레지스트리 PATH + 흔한 설치 자리).
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    dirs.extend(registry_path_dirs());
    // 흔한 설치 자리(설계서 2.3 절)
    if let Some(h) = dirs::home_dir() {
        dirs.push(h.join(r".local\bin"));
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(r".codex\bin"));
        dirs.push(h.join(".codex/bin"));
    }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        let lp = PathBuf::from(l);
        dirs.push(lp.join("Programs"));
        dirs.push(lp.join("bin"));
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(a).join("npm"));
    }
    dirs
}

/// 파일이름(확장자 포함)으로 후보 디렉터리를 훎는다.
fn find_in_dirs(name: &str, exts: &[&str]) -> Option<PathBuf> {
    for dir in search_dirs() {
        for ext in exts {
            let leaf = if ext.is_empty() {
                name.to_string()
            } else {
                format!("{name}{ext}")
            };
            let p = dir.join(&leaf);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// `--version` 을 실행해 첫 줄을 돌려준다. 실패하면 빈 문자열.
fn probe_version(path: &Path) -> String {
    let mut cmd = new_command(path);
    cmd.arg("--version");
    apply_no_window(&mut cmd);
    let mut child = match cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let started = Instant::now();
    loop {
        if child.try_wait().map(|r| r.is_some()).unwrap_or(false) {
            break;
        }
        if started.elapsed() > Duration::from_secs(VERSION_TIMEOUT_S) {
            kill_tree(child.id());
            let _ = child.wait();
            return String::new();
        }
        thread::sleep(Duration::from_millis(50));
    }
    let mut raw = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_end(&mut raw);
    }
    let mut err = Vec::new();
    if let Some(mut se) = child.stderr.take() {
        let _ = se.read_to_end(&mut err);
    }
    let _ = child.wait();
    let text = if !raw.is_empty() {
        String::from_utf8_lossy(&raw)
    } else {
        String::from_utf8_lossy(&err)
    };
    text.lines().next().unwrap_or("").trim().to_string()
}

/// CLI 를 찾고 `--version` 으로 확인한다. 결과는 프로세스 안에서 60초 기억한다.
pub fn detect(id: &str) -> CliInfo {
    {
        let cache = detect_cache();
        if let Ok(m) = cache.lock() {
            if let Some((t, info)) = m.get(id) {
                if t.elapsed() < Duration::from_secs(60) {
                    return clone_info(info);
                }
            }
        }
    }
    let info = detect_uncached(id);
    if let Ok(mut m) = detect_cache().lock() {
        m.insert(id.to_string(), (Instant::now(), clone_info(&info)));
    }
    info
}

fn detect_uncached(id: &str) -> CliInfo {
    match id {
        "claude" => detect_claude(),
        "codex" => detect_codex(),
        _ => CliInfo {
            id: id.to_string(),
            found: false,
            path: String::new(),
            version: String::new(),
        },
    }
}

fn detect_claude() -> CliInfo {
    let home = dirs::home_dir();
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(h) = &home {
        cands.push(h.join(r".local\bin\claude.exe"));
        cands.push(h.join(".local/bin/claude"));
    }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        cands.push(PathBuf::from(l).join(r"bin\claude.exe"));
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        cands.push(PathBuf::from(a).join(r"npm\claude.cmd"));
    }
    cands.push(PathBuf::from("/usr/local/bin/claude"));
    cands.push(PathBuf::from("/opt/homebrew/bin/claude"));
    if let Some(h) = &home {
        cands.push(h.join("npm/bin/claude"));
    }

    for cand in cands {
        if cand.is_file() {
            let version = probe_version(&cand);
            return CliInfo {
                id: "claude".into(),
                found: true,
                path: cand.to_string_lossy().into_owned(),
                version,
            };
        }
    }
    if let Some(p) = find_in_dirs("claude", &[".exe", "", ".cmd", ".bat"]) {
        let version = probe_version(&p);
        return CliInfo {
            id: "claude".into(),
            found: true,
            path: p.to_string_lossy().into_owned(),
            version,
        };
    }
    CliInfo {
        id: "claude".into(),
        found: false,
        path: String::new(),
        version: String::new(),
    }
}

fn detect_codex() -> CliInfo {
    let home = dirs::home_dir();
    // npm 패키지 안 실제 exe 를 `.cmd` 보다 먼저 찾는다.
    let real_exe_rel = r"AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe";
    if let Some(h) = &home {
        let p = h.join(real_exe_rel);
        if p.is_file() {
            let version = probe_version(&p);
            return CliInfo {
                id: "codex".into(),
                found: true,
                path: p.to_string_lossy().into_owned(),
                version,
            };
        }
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        let p = PathBuf::from(a).join(r"npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe");
        if p.is_file() {
            let version = probe_version(&p);
            return CliInfo {
                id: "codex".into(),
                found: true,
                path: p.to_string_lossy().into_owned(),
                version,
            };
        }
    }
    // .cmd 후보.
    if let Some(a) = std::env::var_os("APPDATA") {
        let p = PathBuf::from(a).join(r"npm\codex.cmd");
        if p.is_file() {
            let version = probe_version(&p);
            return CliInfo {
                id: "codex".into(),
                found: true,
                path: p.to_string_lossy().into_owned(),
                version,
            };
        }
    }
    if let Some(h) = &home {
        for rel in [".npm-global/bin/codex", ".local/bin/codex"] {
            let p = h.join(rel);
            if p.is_file() {
                let version = probe_version(&p);
                return CliInfo {
                    id: "codex".into(),
                    found: true,
                    path: p.to_string_lossy().into_owned(),
                    version,
                };
            }
        }
    }
    if let Some(p) = find_in_dirs("codex", &[".exe", "", ".cmd", ".bat"]) {
        let version = probe_version(&p);
        return CliInfo {
            id: "codex".into(),
            found: true,
            path: p.to_string_lossy().into_owned(),
            version,
        };
    }
    CliInfo {
        id: "codex".into(),
        found: false,
        path: String::new(),
        version: String::new(),
    }
}

/// 로그인하도록 터미널 창을 연다.
pub fn open_login(id: &str) -> Result<(), String> {
    let info = detect(id);
    if !info.found {
        let name = match id {
            "claude" => "Claude Code CLI",
            _ => "Codex CLI",
        };
        return Err(format!(
            "이 PC에 {name} 가 설치되어 있지 않습니다. 먼저 설치해 주세요."
        ));
    }
    let path = info.path;
    if cfg!(windows) {
        // Windows: cmd /c start "" cmd /k "<경로>" (codex 는 뒤에 " login").
        let inner = if id == "codex" {
            format!("{} login", path)
        } else {
            path
        };
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg("start").arg("").arg("cmd").arg("/k").arg(&inner);
        cmd.stdin(Stdio::null());
        apply_no_window(&mut cmd);
        let _ = cmd.spawn();
    }
    Ok(())
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = cmd;
}

// ---------------------------------------------------------------------------
// 구독 CLI 안내·로그인 상태(설계서 SETTINGS_DESIGN.md 2.3 절)
// ---------------------------------------------------------------------------

/// 구독 CLI 안내 한 묶음(화면에서 세 단계 점검표로 그린다).
#[derive(Clone, Debug, Serialize)]
pub struct CliGuide {
    pub id: String,
    pub name: String,
    pub found: bool,
    pub path: String,
    pub version: String,
    pub logged_in: Option<bool>,
    pub install_cmd: String,
    pub login_cmd: String,
    pub docs: String,
    pub plan: String,
}

/// 설치·로그인·문서·요금제 문구(설계서 2.3 절, 2026-11 확인).
fn guide_literal(id: &str) -> (String, String, String, String, String) {
    if id == "claude" {
        let install = if cfg!(windows) {
            "irm https://claude.ai/install.ps1 | iex".to_string()
        } else {
            "curl -fsSL https://claude.ai/install.sh | bash".to_string()
        };
        (
            "클로드 구독".into(),
            install,
            "claude".into(),
            "https://code.claude.com/docs/en/quickstart".into(),
            "클로드 Pro·Max 구독 계정으로 로그인합니다. 구독 사용량에서 쓰이고 따로 요금이 붙지 않습니다.".into(),
        )
    } else {
        let install = if cfg!(windows) {
            "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"".to_string()
        } else {
            "curl -fsSL https://chatgpt.com/codex/install.sh | sh".to_string()
        };
        (
            "챗GPT 구독".into(),
            install,
            "codex login".into(),
            "https://developers.openai.com/codex/cli".into(),
            "챗GPT Plus·Pro 등 구독 계정으로 로그인합니다(Sign in with ChatGPT).".into(),
        )
    }
}

/// `claude auth status` 의 loggedIn, `codex login status` 의 종료 코드로 로그인 여부를 본다.
fn logged_in_status(id: &str, info: &CliInfo) -> Option<bool> {
    if !info.found || info.path.is_empty() {
        return None;
    }
    let path = PathBuf::from(&info.path);
    let outcome = if id == "claude" {
        run_capture(&path, &["auth", "status"], VERSION_TIMEOUT_S)
    } else {
        run_capture(&path, &["login", "status"], VERSION_TIMEOUT_S)
    };
    match outcome {
        Some((code, out, _err)) => {
            if id == "claude" {
                // {"loggedIn": true, ...} JSON 을 본다.
                serde_json::from_str::<Value>(out.trim())
                    .ok()
                    .and_then(|j| j.get("loggedIn").and_then(|v| v.as_bool()))
                    .or_else(|| {
                        // JSON 이 아니면 텍스트에서 확인
                        let lower = out.to_lowercase();
                        Some(
                            code == Some(0)
                                && (lower.contains("logged in") || lower.contains("true"))
                                && !lower.contains("not logged")
                                && !lower.contains("false"),
                        )
                    })
            } else {
                // codex login status: 종료 코드 0 이면 로그인됨.
                Some(code == Some(0))
            }
        }
        None => None,
    }
}

/// 명령을 실행하고 (종료코드, stdout, stderr) 를 돌려준다. 시간초과·실패면 None.
fn run_capture(
    path: &Path,
    args: &[&str],
    timeout_s: u64,
) -> Option<(Option<i32>, String, String)> {
    let mut cmd = new_command(path);
    for a in args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    loop {
        if child.try_wait().map(|r| r.is_some()).unwrap_or(false) {
            break;
        }
        if started.elapsed() > Duration::from_secs(timeout_s) {
            kill_tree(child.id());
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let mut out = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_end(&mut out);
    }
    let mut err = Vec::new();
    if let Some(mut se) = child.stderr.take() {
        let _ = se.read_to_end(&mut err);
    }
    let code = child.wait().ok().map(|s| s.code()).flatten();
    Some((code, String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned()))
}

/// 구독 CLI 안내 묶음. detect(60초 캐시) 를 쓴다.
pub fn guide(id: &str) -> CliGuide {
    let info = detect(id);
    let (name, install_cmd, login_cmd, docs, plan) = guide_literal(id);
    let logged_in = logged_in_status(id, &info);
    CliGuide {
        id: id.to_string(),
        name,
        found: info.found,
        path: info.path.clone(),
        version: info.version.clone(),
        logged_in,
        install_cmd,
        login_cmd,
        docs,
        plan,
    }
}

/// 설치 명령을 실행하는 터미널 창을 연다(사용자가 단추를 눌렀을 때만).
/// 설치 뒤 창에 안내 문구가 보이게 `Write-Host` 를 덧붙인다.
pub fn open_install(id: &str) -> Result<(), String> {
    let (_, install_cmd, _, _, _) = guide_literal(id);
    if cfg!(windows) {
        // cmd /c start "" powershell -NoExit -Command "<설치 명령>; Write-Host '...'"
        let inner = format!(
            "{}; Write-Host '설치가 끝났습니다. 이 창을 닫고 앱에서 [다시 확인]을 눌러 주세요.'",
            install_cmd
        );
        let mut cmd = Command::new("cmd");
        cmd.arg("/c")
            .arg("start")
            .arg("")
            .arg("powershell")
            .arg("-NoExit")
            .arg("-Command")
            .arg(&inner);
        cmd.stdin(Stdio::null());
        apply_no_window(&mut cmd);
        let _ = cmd.spawn().map_err(|e| format!("설치 창을 열 수 없습니다: {e}"))?;
    } else {
        // 맥: Terminal 에서 실행
        let mut cmd = Command::new("osascript");
        cmd.arg("-e")
            .arg(format!(
                "tell application \"Terminal\" to do script \"{}; echo '설치가 끝났습니다. 이 창을 닫고 앱에서 [다시 확인]을 눌러 주세요.'\"",
                install_cmd.replace('"', "\\\"")
            ));
        cmd.stdin(Stdio::null());
        let _ = cmd.spawn().map_err(|e| format!("설치 창을 열 수 없습니다: {e}"))?;
    }
    Ok(())
}

/// detect 캐시를 비운다(설치 직후 다시 확인할 때).
pub fn refresh() {
    if let Ok(mut m) = detect_cache().lock() {
        m.clear();
    }
}

/// `.cmd`/`.bat` 여부(대소문자 무시).
fn is_script(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

/// CLI 를 실행할 Command 를 만든다. `.cmd`/`.bat` 이면 `cmd /c` 로 감싼다(가능하면 exe 를 직접).
fn new_command(path: &Path) -> Command {
    if is_script(path) {
        let mut c = Command::new("cmd");
        c.arg("/c");
        c.arg(path);
        c
    } else {
        Command::new(path)
    }
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.arg("/T").arg("/F").arg("/PID").arg(pid.to_string());
        c.stdin(Stdio::null());
        c.stdout(Stdio::null());
        c.stderr(Stdio::null());
        apply_no_window(&mut c);
        let _ = c.spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

// ---------------------------------------------------------------------------
// 실행 공통
// ---------------------------------------------------------------------------

/// stdout·stderr 를 줄 단위로 읽는 스레드 → 채널. `String::from_utf8_lossy` 에 해당하는 동작은
/// `BufRead::lines` 가 유효하지 않은 UTF-8 줄을 `Err` 로 보고 건너뛰므로, 손실을 막기 위해
/// 바이트로 읽어 lossy 변환한다.
fn spawn_line_reader<R: Read + Send + 'static>(reader: R) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut br = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match br.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let s = String::from_utf8_lossy(&buf).into_owned();
                    let s = s.trim_end_matches(['\r', '\n']);
                    if tx.send(s.to_string()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    rx
}

fn rand_hex(n: usize) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut s = format!("{t:x}{:x}", std::process::id());
    while s.len() < n {
        s.push('0');
    }
    s.truncate(n);
    s
}

fn write_mcp_file(work_dir: &Path, mcp_url: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(work_dir).map_err(|e| format!("작업 폴더를 만들 수 없습니다: {e}"))?;
    let mut path = work_dir.join(format!("mcp-{}.json", rand_hex(8)));
    let mut n = 0;
    while path.exists() {
        n += 1;
        path = work_dir.join(format!("mcp-{}-{}.json", rand_hex(8), n));
    }
    let content = json!({
        "mcpServers": {
            "theology": {"type": "http", "url": mcp_url}
        }
    });
    fs::write(&path, content.to_string())
        .map_err(|e| format!("MCP 설정 파일을 쓸 수 없습니다: {e}"))?;
    Ok(path)
}

/// 한도 문구가 있는지(대소문자 무시).
fn looks_like_limit(text: &str) -> bool {
    let lower = text.to_lowercase();
    LIMIT_PATTERNS.iter().any(|p| lower.contains(p))
}

/// 도구 이름에서 마지막 `__` 뒤만 남긴다(`mcp__theology__read_pages` → `read_pages`).
fn short_tool_name(name: &str) -> String {
    match name.rfind("__") {
        Some(i) => name[i + 2..].to_string(),
        None => name.to_string(),
    }
}

fn emit(
    on: &mut dyn FnMut(Step, Option<(String, Value)>),
    kind: &str,
    text: String,
    tool: Option<(String, Value)>,
) {
    emit_id(on, kind, text, tool, None);
}

fn emit_id(
    on: &mut dyn FnMut(Step, Option<(String, Value)>),
    kind: &str,
    text: String,
    tool: Option<(String, Value)>,
    call_id: Option<String>,
) {
    on(
        Step {
            kind: kind.to_string(),
            text,
            call_id,
        },
        tool,
    );
}

fn not_found_out(engine: &str, model: &str, name: &str) -> RunOut {
    RunOut {
        status: "error".into(),
        md: String::new(),
        error: format!("{name} CLI 경로를 찾을 수 없습니다."),
        engine: engine.into(),
        model: model.into(),
        session_id: None,
        cost: None,
        tokens: Value::Null,
        turns_used: None,
    }
}

/// stderr 누적에서 끝 2000자를 뽑는다.
fn stderr_tail(buf: &[String]) -> String {
    let joined: String = buf.concat();
    let rev: String = joined.chars().rev().take(ERR_TAIL).collect();
    rev.chars().rev().collect()
}

fn child_running(c: &mut Child) -> bool {
    c.try_wait().ok().flatten().is_none()
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

pub fn run_claude(
    info: &CliInfo,
    req: &CliReq,
    on: &mut dyn FnMut(Step, Option<(String, Value)>),
    cancel: &AtomicBool,
) -> RunOut {
    if !info.found || info.path.is_empty() {
        return not_found_out("claude", &req.model, "클로드");
    }
    let path = PathBuf::from(&info.path);

    let mcp_file = match write_mcp_file(&req.work_dir, &req.mcp_url) {
        Ok(f) => f,
        Err(e) => {
            return RunOut {
                status: "error".into(),
                md: String::new(),
                error: e,
                engine: "claude".into(),
                model: req.model.clone(),
                session_id: None,
                cost: None,
                tokens: Value::Null,
                turns_used: None,
            };
        }
    };
    let _guard = McpFileGuard(Some(mcp_file.clone()));

    let mut cmd = new_command(&path);
    cmd.arg("-p")
        .arg("--model")
        .arg(&req.model)
        .arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg(&mcp_file)
        .arg("--allowedTools")
        .arg("mcp__theology")
        .arg("--tools")
        .arg("")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--max-turns")
        .arg(req.max_turns.to_string())
        .arg("--append-system-prompt")
        .arg(&req.system);
    if let Some(r) = &req.resume {
        cmd.arg("--resume").arg(r);
    }
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("PYTHONHOME");
    cmd.current_dir(&req.work_dir);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOut {
                status: "error".into(),
                md: String::new(),
                error: format!("클로드를 실행할 수 없습니다: {e}"),
                engine: "claude".into(),
                model: req.model.clone(),
                session_id: None,
                cost: None,
                tokens: Value::Null,
                turns_used: None,
            };
        }
    };

    {
        let stdin = child.stdin.take();
        if let Some(mut si) = stdin {
            let _ = si.write_all(req.user.as_bytes());
            let _ = si.flush();
        }
    }
    let stdout_rx = if let Some(so) = child.stdout.take() {
        spawn_line_reader(so)
    } else {
        mpsc::channel().1
    };
    let stderr_rx = if let Some(se) = child.stderr.take() {
        spawn_line_reader(se)
    } else {
        mpsc::channel().1
    };

    let mut sid: Option<String> = None;
    let mut result_ev: Option<Value> = None;
    let mut texts: Vec<String> = Vec::new();
    let mut stderr_buf: Vec<String> = Vec::new();
    let started = Instant::now();
    let mut stopped = false;

    loop {
        if cancel.load(Ordering::SeqCst) {
            stopped = true;
            break;
        }
        if started.elapsed().as_millis() as u64 > TIMEOUT_MS {
            emit(on, "error", "40분이 넘어 멈춤".into(), None);
            stopped = true;
            break;
        }
        match stdout_rx.recv_timeout(Duration::from_millis(CHANNEL_POLL_MS)) {
            Ok(line) => {
                let ev: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(s) = ev.get("session_id").and_then(Value::as_str) {
                    if !s.is_empty() {
                        sid = Some(s.to_string());
                    }
                }
                match ev.get("type").and_then(Value::as_str) {
                    Some("assistant") => handle_assistant_claude(&ev, &mut texts, on),
                    Some("user") => handle_user_claude(&ev, on),
                    Some("result") => result_ev = Some(ev),
                    _ => {}
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !child_running(&mut child) {
                    if let Err(RecvTimeoutError::Disconnected) =
                        stdout_rx.recv_timeout(Duration::from_millis(10))
                    {
                        break;
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        while let Ok(s) = stderr_rx.try_recv() {
            stderr_buf.push(s);
            if stderr_buf.len() > 200 {
                stderr_buf.remove(0);
            }
        }
    }

    if stopped {
        kill_tree(child.id());
    }
    let _ = child.wait();

    if stopped {
        return RunOut {
            status: "stopped".into(),
            md: String::new(),
            error: String::new(),
            engine: "claude".into(),
            model: req.model.clone(),
            session_id: sid,
            cost: None,
            tokens: Value::Null,
            turns_used: None,
        };
    }

    let rtext = result_ev
        .as_ref()
        .and_then(|r| r.get("result"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let mut alltxt = rtext.clone();
    let tail = stderr_tail(&stderr_buf);
    if !tail.is_empty() {
        alltxt.push(' ');
        alltxt.push_str(&tail);
    }

    let is_error = result_ev
        .as_ref()
        .and_then(|r| r.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let no_result = result_ev.is_none();

    if (no_result || is_error) && looks_like_limit(&alltxt) {
        return RunOut {
            status: "limit".into(),
            md: String::new(),
            error: truncate_chars(&mask_mcp_url(&req.mcp_url, &alltxt), 300),
            engine: "claude".into(),
            model: req.model.clone(),
            session_id: sid,
            cost: None,
            tokens: Value::Null,
            turns_used: None,
        };
    }

    if no_result || is_error || rtext.trim().is_empty() {
        let sub = result_ev
            .as_ref()
            .and_then(|r| r.get("subtype"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if sub == "error_max_turns" && !texts.is_empty() {
            let mut md = texts.last().cloned().unwrap_or_default();
            md.push_str("\n\n> (도구 사용 횟수 한도에 닿아 여기서 마무리했습니다.)");
            return RunOut {
                status: "done".into(),
                md,
                error: String::new(),
                engine: "claude".into(),
                model: req.model.clone(),
                session_id: sid,
                cost: result_ev
                    .as_ref()
                    .and_then(|r| r.get("total_cost_usd"))
                    .and_then(Value::as_f64),
                tokens: usage_tokens(result_ev.as_ref()),
                turns_used: result_ev
                    .as_ref()
                    .and_then(|r| r.get("num_turns"))
                    .and_then(Value::as_i64),
            };
        }
        let masked = mask_mcp_url(&req.mcp_url, &alltxt);
        let err = truncate_chars(&masked, 500);
        return RunOut {
            status: "error".into(),
            md: String::new(),
            error: if err.is_empty() {
                "클로드가 결과 없이 끝났습니다.".into()
            } else {
                err
            },
            engine: "claude".into(),
            model: req.model.clone(),
            session_id: sid,
            cost: None,
            tokens: Value::Null,
            turns_used: None,
        };
    }

    RunOut {
        status: "done".into(),
        md: rtext.trim().to_string(),
        error: String::new(),
        engine: "claude".into(),
        model: req.model.clone(),
        session_id: sid,
        cost: result_ev
            .as_ref()
            .and_then(|r| r.get("total_cost_usd"))
            .and_then(Value::as_f64),
        tokens: usage_tokens(result_ev.as_ref()),
        turns_used: result_ev
            .as_ref()
            .and_then(|r| r.get("num_turns"))
            .and_then(Value::as_i64),
    }
}

fn handle_assistant_claude(
    ev: &Value,
    texts: &mut Vec<String>,
    on: &mut dyn FnMut(Step, Option<(String, Value)>),
) {
    let Some(content) = ev
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for c in content {
        match c.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                let name = c.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let input = c.get("input").cloned().unwrap_or(Value::Null);
                let call_id = c.get("id").and_then(Value::as_str).map(|s| s.to_string());
                let short = short_tool_name(&name);
                emit_id(on, "tool", String::new(), Some((short, input)), call_id);
            }
            Some("text") => {
                if let Some(t) = c.get("text").and_then(Value::as_str) {
                    if !t.trim().is_empty() {
                        texts.push(t.to_string());
                        if t.chars().count() < 400 {
                            emit(on, "think", t.trim().to_string(), None);
                        } else {
                            emit(on, "write", "보고서 쓰는 중…".into(), None);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn handle_user_claude(ev: &Value, on: &mut dyn FnMut(Step, Option<(String, Value)>)) {
    let Some(content) = ev
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for c in content {
        if c.get("type").and_then(Value::as_str) == Some("tool_result") {
            let call_id = c
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let mut text = String::new();
            if let Some(arr) = c.get("content").and_then(Value::as_array) {
                for part in arr {
                    if let Some(t) = part.get("text").and_then(Value::as_str) {
                        text.push_str(t);
                    }
                }
            }
            if !text.is_empty() {
                emit_id(on, "tool_result", truncate_chars(&text, TOOL_RESULT_MAX), None, call_id);
            }
        }
    }
}

fn usage_tokens(result_ev: Option<&Value>) -> Value {
    let Some(u) = result_ev.and_then(|r| r.get("usage")) else {
        return Value::Null;
    };
    let mut out = serde_json::Map::new();
    for k in USAGE_KEYS {
        if let Some(v) = u.get(k) {
            out.insert(k.to_string(), v.clone());
        }
    }
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

pub fn run_codex(
    info: &CliInfo,
    req: &CliReq,
    on: &mut dyn FnMut(Step, Option<(String, Value)>),
    cancel: &AtomicBool,
) -> RunOut {
    if !info.found || info.path.is_empty() {
        return not_found_out("codex", &req.model, "코덱스");
    }
    let path = PathBuf::from(&info.path);

    let _ = fs::create_dir_all(&req.work_dir);
    let out_file = req.work_dir.join(format!("codex-result-{}.txt", rand_hex(8)));

    let url_arg = format!(r#"mcp_servers.theology.url="{}""#, req.mcp_url);

    let mut cmd = new_command(&path);
    cmd.arg("exec")
        .arg("--ignore-user-config")
        .arg("--skip-git-repo-check")
        .arg("--ephemeral")
        .arg("-s")
        .arg("read-only")
        .arg("-m")
        .arg(&req.model)
        .arg("-c")
        .arg("model_reasoning_effort=medium")
        .arg("-c")
        .arg(&url_arg)
        .arg("-c")
        .arg(r#"mcp_servers.theology.default_tools_approval_mode="approve""#)
        .arg("--json")
        .arg("-o")
        .arg(&out_file)
        .arg("-");
    cmd.env_remove("OPENAI_API_KEY");
    cmd.env_remove("PYTHONHOME");
    cmd.current_dir(&req.work_dir);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&out_file);
            return RunOut {
                status: "error".into(),
                md: String::new(),
                error: mask_mcp_url(&req.mcp_url, &format!("코덱스를 실행할 수 없습니다: {e}")),
                engine: "codex".into(),
                model: req.model.clone(),
                session_id: None,
                cost: None,
                tokens: Value::Null,
                turns_used: None,
            };
        }
    };

    {
        let stdin = child.stdin.take();
        if let Some(mut si) = stdin {
            let prompt = format!("{}\n\n{}", req.system, req.user);
            let _ = si.write_all(prompt.as_bytes());
            let _ = si.flush();
        }
    }
    let stdout_rx = if let Some(so) = child.stdout.take() {
        spawn_line_reader(so)
    } else {
        mpsc::channel().1
    };
    let stderr_rx = if let Some(se) = child.stderr.take() {
        spawn_line_reader(se)
    } else {
        mpsc::channel().1
    };

    let mut usage: Value = Value::Null;
    let mut errs: Vec<String> = Vec::new();
    let started = Instant::now();
    let mut stopped = false;

    loop {
        if cancel.load(Ordering::SeqCst) {
            stopped = true;
            break;
        }
        if started.elapsed().as_millis() as u64 > TIMEOUT_MS {
            stopped = true;
            break;
        }
        match stdout_rx.recv_timeout(Duration::from_millis(CHANNEL_POLL_MS)) {
            Ok(line) => {
                let ev: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        let lower = line.to_lowercase();
                        if lower.contains("error") && !lower.contains("403") {
                            errs.push(truncate_chars(line.trim(), 300));
                        }
                        continue;
                    }
                };
                let item = ev.get("item").cloned().unwrap_or(Value::Null);
                let itype = ev.get("type").and_then(Value::as_str).unwrap_or("");
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                match itype {
                    "item.started" if item_type == "mcp_tool_call" => {
                        let tool = item
                            .get("tool")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                        let call_id = item.get("id").and_then(Value::as_str).map(|s| s.to_string());
                        let short = short_tool_name(&tool);
                        emit_id(on, "tool", String::new(), Some((short, args)), call_id);
                    }
                    "item.completed" if item_type == "agent_message" => {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            if !t.trim().is_empty() {
                                if t.chars().count() < 400 {
                                    emit(on, "think", t.trim().to_string(), None);
                                } else {
                                    emit(on, "write", "보고서 쓰는 중…".into(), None);
                                }
                            }
                        }
                    }
                    "item.completed" if item_type == "mcp_tool_call" => {
                        if let Some(output) = item.get("output") {
                            if let Some(t) = output.get("text").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    let call_id = item.get("id").and_then(Value::as_str).map(|s| s.to_string());
                                    emit_id(on, "tool_result", truncate_chars(t, TOOL_RESULT_MAX), None, call_id);
                                }
                            }
                        }
                    }
                    "turn.completed" => {
                        if let Some(u) = ev.get("usage") {
                            usage = u.clone();
                        }
                    }
                    "error" | "turn.failed" => {
                        errs.push(truncate_chars(&ev.to_string(), 300));
                    }
                    _ => {}
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !child_running(&mut child) {
                    if let Err(RecvTimeoutError::Disconnected) =
                        stdout_rx.recv_timeout(Duration::from_millis(10))
                    {
                        break;
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        while let Ok(s) = stderr_rx.try_recv() {
            let lower = s.to_lowercase();
            if lower.contains("error") && !lower.contains("403") {
                errs.push(truncate_chars(s.trim(), 300));
            }
        }
    }

    if stopped {
        kill_tree(child.id());
    }
    let _ = child.wait();

    if stopped {
        let _ = fs::remove_file(&out_file);
        return RunOut {
            status: "stopped".into(),
            md: String::new(),
            error: String::new(),
            engine: "codex".into(),
            model: req.model.clone(),
            session_id: None,
            cost: None,
            tokens: Value::Null,
            turns_used: None,
        };
    }

    let md = fs::read_to_string(&out_file)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let _ = fs::remove_file(&out_file);

    if md.is_empty() {
        let masked: Vec<String> = errs
            .iter()
            .map(|e| mask_mcp_url(&req.mcp_url, e))
            .collect();
        return RunOut {
            status: "error".into(),
            md: String::new(),
            error: truncate_chars(&format!("챗GPT 실패: {}", masked.join(" / ")), 500),
            engine: "codex".into(),
            model: req.model.clone(),
            session_id: None,
            cost: None,
            tokens: usage,
            turns_used: None,
        };
    }

    RunOut {
        status: "done".into(),
        md,
        error: String::new(),
        engine: "codex".into(),
        model: req.model.clone(),
        session_id: None,
        cost: None,
        tokens: usage,
        turns_used: None,
    }
}

// ---------------------------------------------------------------------------
// quick_test
// ---------------------------------------------------------------------------

/// 도구·MCP 없이 "OK 한 단어로만 답해" 를 한 번 실행해 답(앞 200자)을 돌려준다.
/// 로그인이 안 되어 있으면 한국어 안내 오류로 바꾼다.
pub fn quick_test(info: &CliInfo) -> Result<String, String> {
    if !info.found || info.path.is_empty() {
        return Err(format!(
            "이 PC에 {} 가 설치되어 있지 않습니다. 먼저 설치해 주세요.",
            if info.id == "claude" {
                "Claude Code CLI"
            } else {
                "Codex CLI"
            }
        ));
    }
    let path = PathBuf::from(&info.path);
    let prompt = "OK 한 단어로만 답해";

    if info.id == "claude" {
        quick_test_claude(&path, prompt)
    } else {
        quick_test_codex(&path, prompt)
    }
}

fn quick_test_claude(path: &Path, prompt: &str) -> Result<String, String> {
    let mut cmd = new_command(path);
    cmd.arg("-p")
        .arg("--model")
        .arg("sonnet")
        .arg("--tools")
        .arg("")
        .arg("--output-format")
        .arg("json")
        .arg("--max-turns")
        .arg("1");
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("PYTHONHOME");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("클로드를 실행할 수 없습니다: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(prompt.as_bytes());
    }

    let started = Instant::now();
    loop {
        if child.try_wait().map(|r| r.is_some()).unwrap_or(false) {
            break;
        }
        if started.elapsed() > Duration::from_secs(QUICK_TIMEOUT_S) {
            kill_tree(child.id());
            let _ = child.wait();
            return Err("시간이 초과되었습니다.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }

    let mut raw = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_end(&mut raw);
    }
    let mut err = Vec::new();
    if let Some(mut se) = child.stderr.take() {
        let _ = se.read_to_end(&mut err);
    }
    let _ = child.wait();

    let text = String::from_utf8_lossy(&raw).into_owned();
    let answer = if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        v.get("result")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                v.get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default()
    } else {
        text.lines().next().unwrap_or("").trim().to_string()
    };

    if answer.is_empty() {
        let etxt = String::from_utf8_lossy(&err).into_owned();
        if looks_like_limit(&etxt) || looks_like_limit(&text) {
            return Err("사용 한도에 걸렸습니다.".into());
        }
        return Err(not_logged_in_msg());
    }
    Ok(truncate_chars(answer.trim(), QUICK_ANSWER_MAX))
}

fn quick_test_codex(path: &Path, prompt: &str) -> Result<String, String> {
    let work_dir = std::env::temp_dir();
    let out_file = work_dir.join(format!("codex-quick-{}.txt", rand_hex(8)));

    let mut cmd = new_command(path);
    cmd.arg("exec")
        .arg("--ignore-user-config")
        .arg("--skip-git-repo-check")
        .arg("--ephemeral")
        .arg("-s")
        .arg("read-only")
        .arg("--json")
        .arg("-o")
        .arg(&out_file)
        .arg("-");
    cmd.env_remove("OPENAI_API_KEY");
    cmd.env_remove("PYTHONHOME");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("코덱스를 실행할 수 없습니다: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(prompt.as_bytes());
    }

    let started = Instant::now();
    let mut finished = false;
    loop {
        if child.try_wait().map(|r| r.is_some()).unwrap_or(false) {
            finished = true;
            break;
        }
        if started.elapsed() > Duration::from_secs(QUICK_TIMEOUT_S) {
            kill_tree(child.id());
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if let Some(mut so) = child.stdout.take() {
        let mut buf = Vec::new();
        let _ = so.read_to_end(&mut buf);
    }
    if let Some(mut se) = child.stderr.take() {
        let mut buf = Vec::new();
        let _ = se.read_to_end(&mut buf);
    }
    let _ = child.wait();

    if !finished {
        let _ = fs::remove_file(&out_file);
        return Err("시간이 초과되었습니다.".into());
    }

    match fs::read_to_string(&out_file) {
        Ok(s) => {
            let _ = fs::remove_file(&out_file);
            let s = s.trim();
            if s.is_empty() {
                Err(not_logged_in_msg())
            } else {
                Ok(truncate_chars(s, QUICK_ANSWER_MAX))
            }
        }
        Err(_) => {
            let _ = fs::remove_file(&out_file);
            Err(not_logged_in_msg())
        }
    }
}

// ---------------------------------------------------------------------------
// 한 번 묻고 답 받기(도구·MCP 없음). 주석 글 보정처럼 글만 주고받는 일에 쓴다.
// ---------------------------------------------------------------------------

/// 한 번 실행한 결과.
#[derive(Clone, Debug, Default)]
pub struct OneShot {
    pub text: String,
    pub tok_in: u64,
    pub tok_out: u64,
    /// 클로드가 알려 주는 환산 금액(구독에서는 실제로 청구되지 않는다).
    pub cost: Option<f64>,
}

/// 클로드 Code 의 긴 기본 지시문 대신 넣는 짧은 지시문(실제 지시는 stdin 글에 있다).
const ONE_SHOT_SYSTEM: &str = "You are a careful text proofreader. Follow the instructions in the user message exactly and reply with the requested text only.";

/// 자식 프로세스를 돌려 stdout·stderr 를 모은다. 긴 글에서 서로 막히지 않게 stdin 은 따로 쓴다.
fn run_collect(mut cmd: Command, stdin_text: &str, timeout_s: u64, cancel: &AtomicBool, name: &str) -> Result<(String, String), String> {
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("{name}를 실행할 수 없습니다: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        let t = stdin_text.to_string();
        thread::spawn(move || {
            let _ = si.write_all(t.as_bytes());
            let _ = si.flush();
        });
    }
    let out_rx = child.stdout.take().map(spawn_line_reader);
    let err_rx = child.stderr.take().map(spawn_line_reader);
    let (mut out, mut err): (Vec<String>, Vec<String>) = (vec![], vec![]);
    let started = Instant::now();
    loop {
        if let Some(rx) = &out_rx {
            while let Ok(l) = rx.try_recv() {
                out.push(l);
            }
        }
        if let Some(rx) = &err_rx {
            while let Ok(l) = rx.try_recv() {
                err.push(l);
            }
        }
        if cancel.load(Ordering::Relaxed) {
            kill_tree(child.id());
            let _ = child.wait();
            return Err("멈췄습니다.".into());
        }
        if started.elapsed() > Duration::from_secs(timeout_s) {
            kill_tree(child.id());
            let _ = child.wait();
            return Err("시간이 초과되었습니다.".into());
        }
        if !child_running(&mut child) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.wait();
    for (rx, buf) in [(&out_rx, &mut out), (&err_rx, &mut err)] {
        if let Some(rx) = rx {
            while let Ok(l) = rx.recv_timeout(Duration::from_millis(800)) {
                buf.push(l);
            }
        }
    }
    Ok((out.join("\n"), err.join("\n")))
}

fn u64_at(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// 답이 비었을 때의 오류 문장(한도·로그인 구분).
fn empty_answer_err(stdout: &str, stderr: &str) -> String {
    if looks_like_limit(stderr) || looks_like_limit(stdout) {
        return "사용 한도에 걸렸습니다.".into();
    }
    let tail = stderr_tail(&stderr.lines().map(str::to_string).collect::<Vec<_>>());
    if tail.trim().is_empty() { not_logged_in_msg() } else { format!("답을 받지 못했습니다. {}", truncate_chars(tail.trim(), 300)) }
}

/// 구독 CLI 에 글 하나를 주고 답 하나를 받는다(도구·MCP 없음).
/// `effort` 는 추론 강도(빈 문자열이면 클로드는 기본값, 코덱스는 low).
pub fn one_shot(info: &CliInfo, model: &str, effort: &str, prompt: &str, timeout_s: u64, cancel: &AtomicBool) -> Result<OneShot, String> {
    if !info.found || info.path.is_empty() {
        return Err(format!("이 PC에 {} 가 설치되어 있지 않습니다.", if info.id == "claude" { "Claude Code CLI" } else { "Codex CLI" }));
    }
    let path = PathBuf::from(&info.path);
    let work_dir = std::env::temp_dir();
    if info.id == "claude" {
        let mut cmd = new_command(&path);
        cmd.arg("-p").arg("--model").arg(model).arg("--tools").arg("").arg("--strict-mcp-config").arg("--disable-slash-commands");
        cmd.arg("--system-prompt").arg(ONE_SHOT_SYSTEM).arg("--output-format").arg("json").arg("--max-turns").arg("1");
        if !effort.is_empty() {
            cmd.arg("--effort").arg(effort);
        }
        cmd.env_remove("ANTHROPIC_API_KEY");
        cmd.env_remove("PYTHONHOME");
        cmd.current_dir(&work_dir);
        let (out, err) = run_collect(cmd, prompt, timeout_s, cancel, "클로드")?;
        let v: Value = serde_json::from_str(out.trim()).unwrap_or(Value::Null);
        let text = v.get("result").and_then(Value::as_str).unwrap_or("").to_string();
        if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
            if looks_like_limit(&text) || looks_like_limit(&err) {
                return Err("사용 한도에 걸렸습니다.".into());
            }
            return Err(if text.trim().is_empty() { empty_answer_err(&out, &err) } else { truncate_chars(text.trim(), 300) });
        }
        if text.trim().is_empty() {
            return Err(empty_answer_err(&out, &err));
        }
        let u = v.get("usage").cloned().unwrap_or(Value::Null);
        return Ok(OneShot {
            text,
            tok_in: u64_at(&u, "input_tokens") + u64_at(&u, "cache_read_input_tokens") + u64_at(&u, "cache_creation_input_tokens"),
            tok_out: u64_at(&u, "output_tokens"),
            cost: v.get("total_cost_usd").and_then(Value::as_f64),
        });
    }
    let out_file = work_dir.join(format!("codex-one-{}.txt", rand_hex(8)));
    let mut cmd = new_command(&path);
    cmd.arg("exec").arg("--ignore-user-config").arg("--skip-git-repo-check").arg("--ephemeral").arg("-s").arg("read-only");
    cmd.arg("-m").arg(model).arg("-c").arg(format!("model_reasoning_effort={}", if effort.is_empty() { "low" } else { effort }));
    cmd.arg("--json").arg("-o").arg(&out_file).arg("-");
    cmd.env_remove("OPENAI_API_KEY");
    cmd.env_remove("PYTHONHOME");
    cmd.current_dir(&work_dir);
    let res = run_collect(cmd, prompt, timeout_s, cancel, "코덱스");
    let text = fs::read_to_string(&out_file).unwrap_or_default();
    let _ = fs::remove_file(&out_file);
    let (out, err) = res?;
    if text.trim().is_empty() {
        return Err(empty_answer_err(&out, &err));
    }
    let (mut tok_in, mut tok_out) = (0, 0);
    for line in out.lines() {
        if let Ok(ev) = serde_json::from_str::<Value>(line) {
            if let Some(u) = ev.get("usage") {
                tok_in = u64_at(u, "input_tokens");
                tok_out = u64_at(u, "output_tokens");
            }
        }
    }
    Ok(OneShot { text, tok_in, tok_out, cost: None })
}

fn not_logged_in_msg() -> String {
    "로그인이 필요합니다. [로그인 창 열기]를 눌러 로그인해 주세요.".into()
}

#[cfg(test)]
mod guide_tests {
    use super::*;

    #[test]
    fn claude_guide_literals() {
        let (name, install, login, docs, plan) = guide_literal("claude");
        assert_eq!(name, "클로드 구독");
        assert_eq!(login, "claude");
        assert_eq!(docs, "https://code.claude.com/docs/en/quickstart");
        assert!(plan.contains("구독"));
        if cfg!(windows) {
            assert!(install.contains("claude.ai/install.ps1"));
        } else {
            assert!(install.contains("claude.ai/install.sh"));
        }
    }

    #[test]
    fn codex_guide_literals() {
        let (name, install, login, docs, plan) = guide_literal("codex");
        assert_eq!(name, "챗GPT 구독");
        assert_eq!(login, "codex login");
        assert_eq!(docs, "https://developers.openai.com/codex/cli");
        assert!(plan.contains("챗GPT"));
        assert!(install.contains("chatgpt.com/codex"));
    }

    #[cfg(windows)]
    #[test]
    fn registry_path_dirs_reads_environment() {
        // 실제 사용자·시스템 PATH 가 있으므로 후보가 비어 있지 않아야 한다.
        let dirs = search_dirs();
        assert!(!dirs.is_empty(), "검색 후보 디렉터리가 비어 있음");
    }

    /// codex login status / claude auth status 해석용 가짜 CLI .cmd 를 만든다.
    #[cfg(windows)]
    fn write_fake_status_cli(dir: &Path) -> PathBuf {
        let p = dir.join("fake-status-cli.cmd");
        let content = "@echo off\r\nif /I \"%~1\"==\"login\" (if /I \"%~2\"==\"status\" (exit /b %FAKE_CODE%))\r\nif /I \"%~1\"==\"auth\" (if /I \"%~2\"==\"status\" (echo %FAKE_AUTH_JSON%\r\nexit /b 0))\r\n";
        fs::write(&p, content).unwrap();
        p
    }

    #[cfg(windows)]
    fn set_test_env(k: &str, v: &str) {
        unsafe { std::env::set_var(k, v) };
    }

    #[cfg(windows)]
    fn clear_test_env(k: &str) {
        unsafe { std::env::remove_var(k) };
    }

    #[cfg(windows)]
    fn status_info(path: &Path, id: &str) -> CliInfo {
        CliInfo { id: id.to_string(), found: true, path: path.to_string_lossy().into_owned(), version: "fake".into() }
    }

    #[cfg(windows)]
    #[test]
    fn codex_login_status_zero_is_logged_in() {
        let dir = temp_dir();
        let cli = write_fake_status_cli(&dir);
        set_test_env("FAKE_CODE", "0");
        let info = status_info(&cli, "codex");
        assert_eq!(logged_in_status("codex", &info), Some(true));
        set_test_env("FAKE_CODE", "1");
        assert_eq!(logged_in_status("codex", &info), Some(false));
        clear_test_env("FAKE_CODE");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn claude_auth_status_parses_logged_in() {
        let dir = temp_dir();
        let cli = write_fake_status_cli(&dir);
        set_test_env("FAKE_AUTH_JSON", "{\"loggedIn\":true}");
        let info = status_info(&cli, "claude");
        assert_eq!(logged_in_status("claude", &info), Some(true));
        set_test_env("FAKE_AUTH_JSON", "{\"loggedIn\":false}");
        assert_eq!(logged_in_status("claude", &info), Some(false));
        clear_test_env("FAKE_AUTH_JSON");
        let _ = fs::remove_dir_all(&dir);
    }

    fn temp_dir() -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("studycli-guide-{:?}-{}", std::process::id(), n));
        fs::create_dir_all(&d).unwrap();
        d
    }
}
