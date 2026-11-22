//! 앱(Tauri) 명령. 설계서 `docs/AI_STUDY_DESIGN.md` 3절의 명령을 그대로 노출한다.
//!
//! 화면 작업자와의 계약이므로 명령 이름·인자·응답 꼴을 설계서 표 그대로 맞춘다.
//! 오래 걸리는 것은 `spawn_blocking`, 오류는 한국어 문장(String)으로 돌려준다.

use std::sync::{Condvar, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use theolib_core::study;
use theolib_core::{Home, mcp, web};

type R<T> = Result<T, String>;
fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}
fn home() -> R<Home> {
    Home::default_location().map_err(e)
}

// ---- base64(새 의존성 없이 직접) ----

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { B64[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ---- 웹 서재 ----

#[tauri::command]
pub async fn web_status() -> R<web::WebStatus> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || Ok(web::status(&h)))
        .await
        .map_err(e)?
}

#[tauri::command]
pub async fn web_login(id: String, pw: String) -> R<web::WebStatus> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || web::login(&h, &id, &pw).map_err(e))
        .await
        .map_err(e)?
}

#[tauri::command]
pub async fn web_logout() -> R<()> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || web::logout(&h).map_err(e))
        .await
        .map_err(e)?
}

/// 서재 주소 상태(지금 주소·빌드에 든 기본값을 쓰는 중인가·기본값이 있는가).
#[tauri::command]
pub async fn web_base_get() -> R<web::BaseInfo> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || Ok(web::base_info(&h)))
        .await
        .map_err(e)?
}

/// 서재 주소를 바꾼다(빈 문자열이면 기본값으로 되돌린다). 바꾸면 로그인 상태를 지운다.
#[tauri::command]
pub async fn web_base_set(url: String) -> R<web::WebStatus> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        web::set_base(&h, &url).map_err(e)?;
        Ok(web::status(&h))
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn web_guest_login(pw: String) -> R<web::WebStatus> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || web::guest_login(&h, &pw).map_err(e))
        .await
        .map_err(e)?
}

#[derive(Serialize)]
pub struct ApiOut {
    status: u16,
    body: serde_json::Value,
}

#[tauri::command]
pub async fn web_api(method: String, path: String, body: Option<serde_json::Value>) -> R<ApiOut> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = web::api(&h, &method, &path, body.as_ref()).map_err(e)?;
        Ok(ApiOut { status: out.status, body: out.body })
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn web_image(book: String, page: i64) -> R<String> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = web::image(&h, &book, page).map_err(e)?;
        Ok(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)))
    })
    .await
    .map_err(e)?
}

// ---- MCP ----

#[tauri::command]
pub async fn mcp_status() -> R<serde_json::Value> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || Ok(serde_json::json!({"has": mcp::url(&h).is_some()})))
        .await
        .map_err(e)?
}

#[tauri::command]
pub async fn mcp_set(url: String) -> R<()> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        if url.trim().is_empty() {
            mcp::clear(&h).map_err(e)
        } else {
            mcp::set_url(&h, &url).map_err(e)
        }
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn mcp_test() -> R<serde_json::Value> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(url) = mcp::url(&h) else {
            return Ok(serde_json::json!({"ok": false, "error": "서재 연결 주소가 없습니다. 서재에 로그인하거나 AI 설정에서 연결 주소를 넣어 주세요."}));
        };
        match mcp::tools_list(&url) {
            Ok(tools) => Ok(serde_json::json!({"ok": true, "tools": tools.len()})),
            Err(err) => Ok(serde_json::json!({"ok": false, "error": err.to_string()})),
        }
    })
    .await
    .map_err(e)?
}

/// 서재 읽기 서랍: 서재에 로그인하지 않았어도 저장된 MCP 주소로 쪽을 읽는다.
/// `read_pages` 도구를 불러 `{text}` 를 돌려준다(count 는 1~3, 기본 1).
#[tauri::command]
pub async fn mcp_read(book: String, page: i64, count: Option<i64>) -> R<serde_json::Value> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let url = mcp::url(&h).ok_or_else(|| "서재 연결 주소가 없습니다.".to_string())?;
        let count = count.unwrap_or(1).clamp(1, 3);
        let args = serde_json::json!({"book_id": book, "page": page.max(1), "count": count});
        let out = mcp::tools_call(&url, "read_pages", &args).map_err(|x| study::redact(&x.to_string(), &[url.clone()]))?;
        if out.is_error {
            return Err(study::redact(&out.text, &[url.clone()]));
        }
        Ok(serde_json::json!({"text": out.text}))
    })
    .await
    .map_err(e)?
}

// ---- AI 엔진 ----

/// `ai_engines` 응답 한 칸(설계서 3절 표 그대로).
#[derive(Serialize)]
pub struct EngineInfo {
    id: String,
    kind: String,
    name: String,
    ready: bool,
    model: String,
    models: Vec<String>,
    note: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    keyurl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    found: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_url: Option<String>,
    allowed: bool,
}

#[tauri::command]
pub async fn ai_engines() -> R<Vec<EngineInfo>> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let st = study::settings::load(&h);
        let saved_keys = study::keys::saved(&h);
        let scope = study::access::scope(&h);

        let api = |id: &str| -> Option<study::llm::Engine> { study::llm::engine_by_id(id) };

        let mut out = Vec::new();

        // 1. 딥시크(API)
        if let Some(eng) = api("deepseek") {
            let mut models: Vec<String> = eng.models.iter().map(|s| s.to_string()).collect();
            let saved_model = study::keys::saved_model(&h, "deepseek");
            let model = st.model_for("deepseek", eng.default_model);
            if let Some(m) = saved_model.filter(|m| !models.iter().any(|x| x == m)) {
                models.push(m);
            }
            out.push(EngineInfo {
                id: "deepseek".into(),
                kind: "api".into(),
                name: eng.name.to_string(),
                ready: saved_keys.contains_key("deepseek"),
                model,
                models,
                note: eng.note.to_string(),
                hint: saved_keys.get("deepseek").cloned(),
                keyurl: Some(eng.keyurl.to_string()),
                found: None,
                version: None,
                custom_url: None,
                allowed: study::access::engine_allowed(&scope, "api"),
            });
        }

        // 2. 클로드 구독(CLI)
        {
            let info = theolib_core::studycli::detect("claude");
            let model = st.model_for("claude", "sonnet");
            out.push(EngineInfo {
                id: "claude".into(),
                kind: "cli".into(),
                name: "클로드 구독".into(),
                ready: info.found,
                model: model.clone(),
                models: vec!["sonnet".into(), "opus".into()],
                note: "이 PC에 설치·로그인된 Claude Code CLI로 연구합니다".into(),
                hint: None,
                keyurl: None,
                found: Some(info.found),
                version: if info.version.is_empty() { None } else { Some(info.version) },
                custom_url: None,
                allowed: study::access::engine_allowed(&scope, "cli"),
            });
        }

        // 3. 챗GPT 구독(CLI)
        {
            let info = theolib_core::studycli::detect("codex");
            let model = st.model_for("codex", "gpt-6-luna");
            out.push(EngineInfo {
                id: "codex".into(),
                kind: "cli".into(),
                name: "챗GPT 구독".into(),
                ready: info.found,
                model: model.clone(),
                models: vec!["gpt-6-luna".into()],
                note: "이 PC에 설치·로그인된 Codex CLI로 연구합니다".into(),
                hint: None,
                keyurl: None,
                found: Some(info.found),
                version: if info.version.is_empty() { None } else { Some(info.version) },
                custom_url: None,
                allowed: study::access::engine_allowed(&scope, "cli"),
            });
        }

        // 4. 서재 서버의 구독 AI(server)
        {
            let ws = web::status(&h);
            out.push(EngineInfo {
                id: "server".into(),
                kind: "server".into(),
                name: "서재 서버의 구독 AI (집 PC)".into(),
                ready: ws.logged_in,
                model: String::new(),
                models: vec![],
                note: "서재 서버에서 돌아갑니다(앱은 화면만)".into(),
                hint: None,
                keyurl: None,
                found: None,
                version: None,
                custom_url: None,
                allowed: study::access::engine_allowed(&scope, "server"),
            });
        }

        // 5~7. 제미나이·챗GPT API·클로드 API
        for id in ["gemini", "openai", "anthropic"] {
            if let Some(eng) = api(id) {
                let model = st.model_for(id, eng.default_model);
                out.push(EngineInfo {
                    id: id.into(),
                    kind: "api".into(),
                    name: eng.name.to_string(),
                    ready: saved_keys.contains_key(id),
                    model,
                    models: eng.models.iter().map(|s| s.to_string()).collect(),
                    note: eng.note.to_string(),
                    hint: saved_keys.get(id).cloned(),
                    keyurl: Some(eng.keyurl.to_string()),
                    found: None,
                    version: None,
                    custom_url: None,
                    allowed: study::access::engine_allowed(&scope, "api"),
                });
            }
        }

        // 8. 직접 넣기(custom)
        {
            let custom_url = st.custom_url.clone();
            out.push(EngineInfo {
                id: "custom".into(),
                kind: "api".into(),
                name: "직접 넣기".into(),
                ready: !custom_url.is_empty(),
                model: String::new(),
                models: vec![],
                note: "OpenAI 호환 chat/completions 주소 직접 지정".into(),
                hint: None,
                keyurl: None,
                found: None,
                version: None,
                custom_url: Some(custom_url.clone()),
                allowed: study::access::engine_allowed(&scope, "api"),
            });
        }

        // 9. 서버 BYOK(webkey) 엔진 — 로그인 상태에서 /api/me/aikeys 로 채운다(실패하면 뺀다).
        if let Some(aikeys_body) = web::aikeys(&h) {
            for j in study::access::webkey_engines(&scope, &aikeys_body) {
                out.push(EngineInfo {
                    id: j.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    kind: "webkey".into(),
                    name: j.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    ready: j.get("ready").and_then(|v| v.as_bool()).unwrap_or(false),
                    model: j.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    models: j.get("models").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                    note: j.get("note").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    hint: j.get("hint").and_then(|v| v.as_str()).map(str::to_string),
                    keyurl: j.get("keyurl").and_then(|v| v.as_str()).map(str::to_string),
                    found: None,
                    version: None,
                    custom_url: None,
                    allowed: j.get("allowed").and_then(|v| v.as_bool()).unwrap_or(false),
                });
            }
        }

        Ok(out)
    })
    .await
    .map_err(e)?
}

/// 계정 권한 요약(설계서 2.2 절).
#[tauri::command]
pub async fn ai_scope() -> R<serde_json::Value> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let s = study::access::scope(&h);
        let ws = web::status(&h);
        Ok(serde_json::json!({
            "scope": study::access::scope_id(&s),
            "label": study::access::label(&s),
            "user": if ws.logged_in { ws.user } else { String::new() },
            "local_allowed": study::access::local_allowed(&s),
            "note": study::access::note(&s),
        }))
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn ai_key_save(provider: String, key: String, model: String, url: Option<String>) -> R<()> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        // 키가 빈 문자열이면 모델·주소만 저장
        if key.trim().is_empty() {
            study::keys::save_meta(&h, &provider, &model, url.as_deref()).map_err(e)?;
        } else {
            let clean = study::keys::clean_key(&key).ok_or_else(|| format!("{} API 키 형식이 올바르지 않습니다.", study::engine_name(&provider)))?;
            study::keys::save(&h, &provider, &clean, &model, url.as_deref()).map_err(e)?;
        }
        Ok(())
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn ai_key_delete(provider: String) -> R<()> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || study::keys::delete(&h, &provider).map_err(e))
        .await
        .map_err(e)?
}

#[tauri::command]
pub async fn ai_test(engine: String, model: Option<String>, key: Option<String>, url: Option<String>) -> R<serde_json::Value> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        // CLI 엔진
        if engine == "claude" || engine == "codex" {
            let info = theolib_core::studycli::detect(&engine);
            if !info.found {
                return Ok(serde_json::json!({"ok": false, "error": format!("이 PC에 {} 명령줄 도구가 설치되어 있지 않습니다. AI 설정에서 확인해 주세요.", if engine == "claude" { "클로드 Code" } else { "Codex" })}));
            }
            match theolib_core::studycli::quick_test(&info) {
                Ok(detail) => Ok(serde_json::json!({"ok": true, "detail": detail})),
                Err(err) => Ok(serde_json::json!({"ok": false, "error": err})),
            }
        } else {
            // API 엔진
            let eng = if engine == "custom" {
                let custom_url = url.clone().or_else(|| {
                    let st = study::settings::load(&h);
                    if st.custom_url.is_empty() { None } else { Some(st.custom_url) }
                }).unwrap_or_default();
                study::llm::custom_engine(&custom_url)
            } else {
                match study::llm::engine_by_id(&engine) {
                    Some(eng) => eng,
                    None => return Ok(serde_json::json!({"ok": false, "error": "선택할 수 없는 AI입니다."})),
                }
            };
            // 키: key 인자 → 저장된 키 순서
            let key = key.clone()
                .filter(|k| !k.trim().is_empty())
                .or_else(|| study::keys::load(&h, &engine))
                .unwrap_or_default();
            let model = model.clone()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| {
                    if eng.default_model.is_empty() {
                        String::new()
                    } else {
                        study::settings::load(&h).model_for(&engine, eng.default_model)
                    }
                });
            match study::llm::test(&eng, &key, &model) {
                Ok(()) => Ok(serde_json::json!({"ok": true})),
                Err(err) => Ok(serde_json::json!({"ok": false, "error": err})),
            }
        }
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn ai_cli_login(engine: String) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || theolib_core::studycli::open_login(&engine).map_err(e))
        .await
        .map_err(e)?
}

#[tauri::command]
pub async fn ai_cli_guide(engine: String) -> R<theolib_core::studycli::CliGuide> {
    tauri::async_runtime::spawn_blocking(move || Ok(theolib_core::studycli::guide(&engine)))
        .await
        .map_err(e)?
}

#[tauri::command]
pub async fn ai_cli_install(engine: String) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || theolib_core::studycli::open_install(&engine).map_err(e))
        .await
        .map_err(e)?
}

#[tauri::command]
pub async fn ai_cli_refresh() -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        theolib_core::studycli::refresh();
        Ok(())
    })
    .await
    .map_err(e)?
}

/// 서재 자료 받기 주소. `url` 은 화면에 보이지 않게 다룬다.
#[tauri::command]
pub async fn web_app_source() -> R<web::AppSource> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || web::app_source(&h).map_err(e))
        .await
        .map_err(e)?
}

/// 앱 정보(설계서 2.4 절): 버전·포터블 여부·자료 폴더·운영체제.
#[tauri::command]
pub fn app_info(app: AppHandle) -> R<serde_json::Value> {
    let h = home()?;
    Ok(serde_json::json!({
        "version": app.package_info().version.to_string(),
        "portable": theolib_core::home::is_portable(),
        "data_dir": h.root.to_string_lossy(),
        "platform": std::env::consts::OS,
    }))
}

/// 자료 폴더를 탐색기로 연다(Windows explorer, 맥 open).
#[tauri::command]
pub fn open_data_dir() -> R<()> {
    let h = home()?;
    let dir = h.root;
    if cfg!(windows) {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(e)?;
    } else {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(e)?;
    }
    Ok(())
}

// ---- 연구 설정 ----

#[tauri::command]
pub async fn study_settings_get() -> R<serde_json::Value> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let st = study::settings::load(&h);
        let mut v = st.to_value();
        // fallback 은 study_settings_get 에서 최상위로 준다(설계서).
        v["fallback"] = serde_json::json!(st.fallback);
        Ok(v)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn study_settings_set(settings: serde_json::Value) -> R<serde_json::Value> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let st = study::settings::save(&h, &settings).map_err(e)?;
        Ok(st.to_value())
    })
    .await
    .map_err(e)?
}

// ---- 연구 실행 ----

#[derive(Serialize)]
pub struct StatusOut {
    status: u16,
    body: serde_json::Value,
}

fn to_status((status, body): (u16, serde_json::Value)) -> StatusOut {
    StatusOut { status, body }
}

#[tauri::command]
pub async fn study_start(d: serde_json::Value, app: AppHandle) -> R<StatusOut> {
    let h = home()?;
    let out = tauri::async_runtime::spawn_blocking(move || to_status(study::job::start(&h, &d)))
        .await
        .map_err(e)?;
    wake_runner(&app);
    Ok(out)
}

#[tauri::command]
pub async fn study_ask(d: serde_json::Value, app: AppHandle) -> R<StatusOut> {
    let h = home()?;
    let out = tauri::async_runtime::spawn_blocking(move || to_status(study::job::ask(&h, &d)))
        .await
        .map_err(e)?;
    wake_runner(&app);
    Ok(out)
}

#[tauri::command]
pub async fn study_stop(d: serde_json::Value) -> R<StatusOut> {
    let h = home()?;
    let out = tauri::async_runtime::spawn_blocking(move || to_status(study::job::stop(&h, &d)))
        .await
        .map_err(e)?;
    Ok(out)
}

#[tauri::command]
pub async fn study_delete(d: serde_json::Value) -> R<StatusOut> {
    let h = home()?;
    let out = tauri::async_runtime::spawn_blocking(move || to_status(study::job::delete(&h, &d)))
        .await
        .map_err(e)?;
    Ok(out)
}

#[tauri::command]
pub async fn study_list() -> R<serde_json::Value> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || Ok(study::job::list(&h)))
        .await
        .map_err(e)?
}

#[tauri::command]
pub async fn study_get(id: String) -> R<Option<serde_json::Value>> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || Ok(study::job::get(&h, &id)))
        .await
        .map_err(e)?
}

// ---- 실행기 ----

/// start·ask 뒤 실행기를 깨우는 신호.
struct RunnerWake {
    lock: Mutex<bool>,
    cv: Condvar,
}

fn runner_wake() -> &'static RunnerWake {
    static W: OnceLock<RunnerWake> = OnceLock::new();
    W.get_or_init(|| RunnerWake { lock: Mutex::new(false), cv: Condvar::new() })
}

fn wake_runner(_app: &AppHandle) {
    let w = runner_wake();
    let mut guard = w.lock.lock().unwrap();
    *guard = true;
    w.cv.notify_all();
}

/// 앱 시작 시 부르는 실행기 시작. `job::recover` 뒤 스레드 하나가 `run_next` 를 돈다.
pub fn start_runner(app: AppHandle) {
    let home = match Home::default_location() {
        Ok(h) => h,
        Err(_) => return,
    };
    study::job::recover(&home);
    std::thread::Builder::new()
        .name("study-runner".into())
        .spawn(move || {
            let cli = study::clirun::LocalCli;
            let w = runner_wake();
            loop {
                let mut on = |ev: &study::job::Event| {
                    match ev {
                        study::job::Event::Step { id, turn, step, index } => {
                            let _ = app.emit(
                                "study",
                                serde_json::json!({"type": "step", "id": id, "turn": turn, "index": index, "step": {"kind": step.kind, "text": step.text}}),
                            );
                        }
                        study::job::Event::Status { id, turn, status } => {
                            let _ = app.emit(
                                "study",
                                serde_json::json!({"type": "status", "id": id, "turn": turn, "status": status}),
                            );
                        }
                    }
                };
                let ran = study::job::run_next(&home, &cli, &mut on);
                if ran {
                    continue;
                }
                // 일감이 없으면 Condvar 로 대기(30초마다 깨어나 다시 확인).
                let mut guard = w.lock.lock().unwrap();
                if *guard {
                    *guard = false;
                    continue;
                }
                let (_guard, _) = w.cv.wait_timeout(guard, std::time::Duration::from_secs(30)).unwrap();
            }
        })
        .expect("study-runner 스레드를 만들지 못했습니다");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
