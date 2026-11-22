//! API 회사(OpenAI 호환 chat/completions). 표와 오류 문구는 aikeys.PROVIDERS·chat 를 따른다.
//! 딥시크 생각 모드 도구 호출 규칙(공식 문서 확인, 2026-11-22):
//!  - 요청에 `tools` 가 있으면 이전 모든 turn 의 `reasoning_content` 를 반드시 되돌려 보내야 한다
//!    (안 하면 API 가 400 을 돌려줌). 도구 호출이 없던 turn 도 포함.
//!  - `tools` 가 없는 요청에서는 `reasoning_content` 를 되돌려 보낼 필요 없고, 보내도 무시된다.
//!  - 따라서 응답 assistant 메시지는 `role`·`content`·`tool_calls`·`reasoning_content` 를
//!    받은 그대로 다음 요청 messages 에 넣는다.
//!  - 딥시크는 `max_tokens: 32000` 을 함께 보낸다(긴 보고서·도구 호출 대비).
use serde_json::{Value, json};
use std::io::Read;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Engine {
    pub id: String,
    pub name: &'static str,
    pub url: String,
    pub default_model: &'static str,
    pub models: &'static [&'static str],
    pub keyurl: &'static str,
    pub note: &'static str,
}

/// API 회사 표(설계서 2.4 + aikeys.PROVIDERS 그대로).
pub fn engines() -> Vec<Engine> {
    vec![
        Engine {
            id: "deepseek".into(),
            name: "딥시크",
            url: "https://api.deepseek.com/chat/completions".into(),
            default_model: "deepseek-flash",
            models: &["deepseek-flash", "deepseek-v4-pro"],
            keyurl: "https://platform.deepseek.com/api_keys",
            note: "쓴 만큼 결제. 가장 저렴",
        },
        Engine {
            id: "gemini".into(),
            name: "제미나이",
            url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".into(),
            default_model: "gemini-3.8-flash",
            models: &["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-4"],
            keyurl: "https://aistudio.google.com/apikey",
            note: "구글 AI 스튜디오에서 무료로 발급, 무료 사용량 있음",
        },
        Engine {
            id: "openai".into(),
            name: "챗GPT API",
            url: "https://api.openai.com/v1/chat/completions".into(),
            default_model: "gpt-6-luna",
            models: &["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"],
            keyurl: "https://platform.openai.com/api-keys",
            note: "OpenAI API (쓴 만큼 결제, 챗GPT 구독과 별도)",
        },
        Engine {
            id: "anthropic".into(),
            name: "클로드 API",
            url: "https://api.anthropic.com/v1/chat/completions".into(),
            default_model: "claude-sonnet-5-5",
            models: &["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
            keyurl: "https://console.anthropic.com/settings/keys",
            note: "Anthropic API (쓴 만큼 결제, 클로드 구독과 별도)",
        },
    ]
}

/// custom 엔진(주소·모델 직접, 키 없어도 됨).
pub fn custom_engine(url: &str) -> Engine {
    Engine {
        id: "custom".into(),
        name: "직접 넣기",
        url: url.to_string(),
        default_model: "",
        models: &[],
        keyurl: "",
        note: "OpenAI 호환 chat/completions 주소 직접 지정",
    }
}

pub fn engine_by_id(id: &str) -> Option<Engine> {
    engines().into_iter().find(|e| e.id == id)
}

/// 환경변수 THEOLIB_AI_URL_<회사 대문자> 로 주소를 바꿀 수 있다(시험용).
pub fn url_for(e: &Engine) -> String {
    std::env::var(format!("THEOLIB_AI_URL_{}", e.id.to_uppercase())).unwrap_or_else(|_| e.url.clone())
}

/// 모델 이름 검사. 형식이 틀리면 기본 모델.
pub fn model_ok(e: &Engine, model: &str) -> String {
    let m = model.trim();
    if !m.is_empty() && m.len() <= 80 && m.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == '/' || c == ':') {
        m.to_string()
    } else if !e.default_model.is_empty() {
        e.default_model.to_string()
    } else {
        m.to_string()
    }
}

#[derive(Clone, Debug, Default)]
pub struct ChatOut {
    /// assistant 메시지(role, content, tool_calls, reasoning_content 그대로).
    pub message: Value,
    pub usage: Value,
}

fn agent(timeout_s: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_body(Some(Duration::from_secs(timeout_s)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// 재시도 대기(시험에서 주입 가능). 기본 3초/8초.
fn retry_waits() -> Vec<u64> {
    std::env::var("THEOLIB_AI_RETRY_MS")
        .ok()
        .and_then(|v| {
            let v: Vec<u64> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            if v.is_empty() { None } else { Some(v) }
        })
        .unwrap_or_else(|| vec![3000, 8000])
}

fn kind_of(e: &ureq::Error) -> String {
    match e {
        ureq::Error::HostNotFound => "HostNotFound".into(),
        ureq::Error::ConnectionFailed => "ConnectionFailed".into(),
        ureq::Error::Timeout(_) => "Timeout".into(),
        ureq::Error::Io(io) => io.kind().to_string(),
        other => format!("{:?}", other).chars().take(40).collect(),
    }
}

fn read_body(r: &mut ureq::http::Response<ureq::Body>) -> String {
    let mut s = String::new();
    let _ = r.body_mut().as_reader().take(1 << 20).read_to_string(&mut s);
    s
}

/// aikeys.chat 과 같은 오류 문구(본문의 error.message 를 읽고 240자로 자른다).
fn error_message(status: u16, body: &str) -> String {
    let mut msg = String::new();
    if let Ok(j) = serde_json::from_str::<Value>(body) {
        let j = if let Some(a) = j.as_array() { a.first().cloned().unwrap_or(j) } else { j };
        msg = j
            .get("error")
            .map(|e| {
                if let Some(m) = e.get("message").and_then(|x| x.as_str()) {
                    m.to_string()
                } else {
                    e.to_string()
                }
            })
            .unwrap_or_default();
        if msg.is_empty() {
            msg = j.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string();
        }
    }
    if msg.is_empty() {
        msg = body.chars().take(240).collect();
    } else {
        msg.truncate(240);
    }
    match status {
        401 | 403 => format!("API 키가 맞지 않거나 이 모델을 쓸 권한이 없습니다. {msg}"),
        429 => format!("AI 사용 한도(또는 무료 사용량)에 걸렸습니다. 잠시 뒤 다시 하거나 결제 설정을 확인해 주세요. {msg}"),
        404 => format!("모델 이름을 찾지 못했습니다. 다른 모델을 골라 주세요. {msg}"),
        _ => format!("AI 서버 오류 {status}: {msg}"),
    }
}

fn is_deepseek(url: &str) -> bool {
    url.contains("deepseek.com")
}

pub fn do_post(url: &str, key: &str, body: &Value, timeout_s: u64) -> Result<ureq::http::Response<ureq::Body>, String> {
    let payload = serde_json::to_vec(body).unwrap_or_default();
    agent(timeout_s)
        .post(url)
        .header("Authorization", &format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send(payload.as_slice())
        .map_err(|e| format!("AI 서버에 연결하지 못했습니다 ({})", kind_of(&e)))
}

/// OpenAI 호환 chat/completions 한 번(주소 직접). 5xx·연결 실패는 3초·8초 재시도.
pub fn chat_raw(
    url: &str,
    key: &str,
    model: &str,
    messages: &[Value],
    tools: Option<&[Value]>,
    timeout_s: u64,
) -> Result<ChatOut, String> {
    let mut body = json!({"model": model, "messages": messages});
    if let Some(t) = tools {
        body["tools"] = json!(t);
    }
    if is_deepseek(url) {
        body["max_tokens"] = json!(32000);
    }
    let waits = retry_waits();
    let mut last_err = String::new();
    for attempt in 0..=waits.len() {
        match do_post(url, key, &body, timeout_s) {
            Ok(mut r) => {
                let status = r.status().as_u16();
                let text = read_body(&mut r);
                if status == 200 {
                    let j: Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => return Err("AI 응답을 해석하지 못했습니다".into()),
                    };
                    let msg = j["choices"][0]["message"].clone();
                    let usage = j.get("usage").cloned().unwrap_or(json!({}));
                    if msg.is_null() {
                        return Err("AI 응답을 해석하지 못했습니다".into());
                    }
                    return Ok(ChatOut { message: msg, usage });
                }
                let err = error_message(status, &text);
                if (500..=599).contains(&status) && attempt < waits.len() {
                    last_err = err;
                    std::thread::sleep(Duration::from_millis(waits[attempt]));
                    continue;
                }
                return Err(err);
            }
            Err(errmsg) => {
                if attempt < waits.len() {
                    last_err = errmsg;
                    std::thread::sleep(Duration::from_millis(waits[attempt]));
                    continue;
                }
                return Err(errmsg);
            }
        }
    }
    Err(last_err)
}

/// chat() — engine + key + model 형태.
pub fn chat(
    e: &Engine,
    key: &str,
    model: &str,
    messages: &[Value],
    tools: Option<&[Value]>,
    timeout_s: u64,
) -> Result<ChatOut, String> {
    chat_raw(&url_for(e), key, model, messages, tools, timeout_s)
}

/// 연결 시험: 짧은 대화 한 번.
pub fn test(e: &Engine, key: &str, model: &str) -> Result<(), String> {
    chat(
        e,
        key,
        model,
        &[json!({"role": "user", "content": "Reply with the single word OK."})],
        None,
        60,
    )?;
    Ok(())
}

/// 응답 assistant 메시지에서 content 문자열을 뽑는다(문자열 또는 부분 목록).
pub fn message_text(msg: &Value) -> String {
    match msg.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.get("text").and_then(|t| t.as_str())).collect::<String>(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// 회사 이름(키 오류 문장용).
pub fn company_name(id: &str) -> String {
    engine_by_id(id).map(|e| e.name.to_string()).unwrap_or_else(|| id.to_string())
}
