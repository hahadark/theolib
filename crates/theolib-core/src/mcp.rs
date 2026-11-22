//! MCP(JSON-RPC over HTTPS) 클라이언트. 세션·initialize 없이 tools/list, tools/call 을 바로 받는다.
use crate::Home;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::time::Duration;

/// 저장된 MCP 주소(보안 저장소 서비스 theolib-web, 계정 mcp).
pub fn url(home: &Home) -> Option<String> {
    crate::web::load_secret(home, crate::web::MCP_ACCOUNT)
}

/// 직접 붙여 넣기. https://…/mcp/<토큰> 꼴(로컬 시험용 http://127.0.0.1·localhost 허용).
pub fn set_url(home: &Home, u: &str) -> Result<()> {
    let u = u.trim();
    if u.is_empty() {
        return clear(home);
    }
    let ok = (u.starts_with("https://") || u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost")) && u.contains("/mcp/");
    if !ok {
        bail!("연결 주소는 https://…/mcp/… 꼴이어야 합니다.");
    }
    crate::web::store_secret(home, crate::web::MCP_ACCOUNT, u)
}

pub fn clear(home: &Home) -> Result<()> {
    crate::web::clear_secret(home, crate::web::MCP_ACCOUNT)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_body(Some(Duration::from_secs(90)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn post(url: &str, method: &str, params: &Value) -> Result<Value> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    let payload = serde_json::to_vec(&body).unwrap_or_default();
    let mut r = agent()
        .post(url)
        .header("Content-Type", "application/json")
        .send(payload.as_slice())
        .map_err(|e| mcp_err(e))?;
    let code = r.status().as_u16();
    let mut s = String::new();
    let _ = r.body_mut().as_reader().take(16 << 20).read_to_string(&mut s);
    if code != 200 {
        bail!("서재 도구 서버 오류 {code}");
    }
    let j: Value = serde_json::from_str(&s).context("서재 도구 응답 형식이 다릅니다")?;
    if let Some(err) = j.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("도구 오류");
        bail!("{}", redact_mcp(msg));
    }
    Ok(j.get("result").cloned().unwrap_or(Value::Null))
}

fn mcp_err(e: ureq::Error) -> anyhow::Error {
    // 주소(토큰)는 넣지 않는다.
    match e {
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Timeout(_) | ureq::Error::Io(_) => anyhow::anyhow!("서재 연결 주소로 도구를 불러오지 못했습니다."),
        other => anyhow::anyhow!("서재 연결 주소 오류 ({}).", other.to_string().chars().take(40).collect::<String>()),
    }
}

/// 오류 문장에 토큰이 섞이면 … 로 바꾼다.
fn redact_mcp(msg: &str) -> String {
    // 오류 본문은 서버가 낸 것이므로 주소가 어디 있는지 모르지만, 긴 토큰처럼 보이는 부분은 안전하게 자른다.
    msg.chars().take(200).collect()
}

use std::io::Read as _;

#[derive(Clone, Debug)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
    pub images: usize,
}

/// tools/list → {name, description, inputSchema} 목록.
pub fn tools_list(url: &str) -> Result<Vec<Value>> {
    let r = post(url, "tools/list", &json!({}))?;
    let arr = r.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    Ok(arr.into_iter().map(|t| json!({
        "name": t.get("name").cloned().unwrap_or(Value::Null),
        "description": t.get("description").cloned().unwrap_or(Value::Null),
        "inputSchema": t.get("inputSchema").cloned().unwrap_or_else(|| json!({"type":"object","properties":{}})),
    })).collect())
}

/// tools/call 하나. content 의 text 를 줄바꿈으로 잇고 그림은 개수만 센다.
pub fn tools_call(url: &str, name: &str, args: &Value) -> Result<ToolResult> {
    let r = post(url, "tools/call", &json!({"name": name, "arguments": args}))?;
    let content = r.get("content").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    let mut texts = Vec::new();
    let mut images = 0usize;
    let mut is_error = false;
    for c in &content {
        let ty = c.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "text" => {
                if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
                    texts.push(t.to_string());
                }
                if c.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false) {
                    is_error = true;
                }
            }
            "image" => images += 1,
            _ => {}
        }
    }
    let text = if texts.is_empty() { "(결과 없음)".to_string() } else { texts.join("\n") };
    Ok(ToolResult { text, is_error, images })
}
