//! 계정 권한 판정(설계서 SETTINGS_DESIGN.md 2.2 절).
//! 온라인 서재 계정(web::status)과 서재 연결 주소(MCP)로 이 PC의 AI 를 쓸 수 있는지를 정한다.

use crate::Home;

/// 계정 권한. LocalMcp 는 로그인하지 않았지만 서재 연결 주소(MCP)가 저장된 상태.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Owner,
    Special,
    Member,
    Guest,
    LocalMcp,
    None,
}

/// 계정 권한을 판정한다(web::status 60초 캐시 + mcp::url).
pub fn scope(home: &Home) -> Scope {
    let st = crate::web::status(home);
    // 다른 home 의 60초 캐시를 물려받지 않게, 이 home 에 실제 쿠키가 있는지 재확인한다.
    let has_cookie = crate::web::load_secret(home, crate::web::COOKIE_ACCOUNT).is_some();
    let logged_in = st.logged_in && has_cookie;
    if logged_in {
        if st.owner {
            Scope::Owner
        } else if st.role == "special" {
            Scope::Special
        } else if st.role == "member" {
            Scope::Member
        } else if st.role == "guest" {
            Scope::Guest
        } else {
            Scope::None
        }
    } else if crate::mcp::url(home).is_some() {
        Scope::LocalMcp
    } else {
        Scope::None
    }
}

/// 이 PC의 AI(API 키·CLI)를 쓸 수 있는 권한인지(Owner | LocalMcp).
pub fn local_allowed(s: &Scope) -> bool {
    matches!(s, Scope::Owner | Scope::LocalMcp)
}

/// 서재 서버의 구독 AI 를 쓸 수 있는 권한인지(Owner | Special).
pub fn server_allowed(s: &Scope) -> bool {
    matches!(s, Scope::Owner | Scope::Special)
}

/// 로그인한 계정으로 이 PC의 AI 를 못 쓰게 해야 하는지(특별·회원·게스트).
/// 로그인하지 않은 상태(None)는 거절하지 않는다(명령줄·첫 실행·기존 동작 보존).
pub fn rejects_local(s: &Scope) -> bool {
    matches!(s, Scope::Special | Scope::Member | Scope::Guest)
}

/// 화면에 띄울 배지 이름.
pub fn label(s: &Scope) -> &'static str {
    match s {
        Scope::Owner => "관리자",
        Scope::Special => "특별 계정",
        Scope::Member => "회원",
        Scope::Guest => "게스트",
        Scope::LocalMcp => "이 PC 연결",
        Scope::None => "로그인 안 함",
    }
}

/// ai_scope 의 scope 문자열(화면 계약).
pub fn scope_id(s: &Scope) -> &'static str {
    match s {
        Scope::Owner => "owner",
        Scope::Special => "special",
        Scope::Member => "member",
        Scope::Guest => "guest",
        Scope::LocalMcp => "localmcp",
        Scope::None => "none",
    }
}

/// 그 권한에서 무엇을 쓸 수 있는지 한 문장(1절 표의 말).
pub fn note(s: &Scope) -> &'static str {
    match s {
        Scope::Owner => "이 PC의 AI와 서재 서버의 구독 AI를 모두 쓸 수 있습니다.",
        Scope::Special => "서재 서버의 구독 AI를 씁니다(따로 비용이 없습니다).",
        Scope::Member => "본인 API 키로 서재 서버에서 연구합니다.",
        Scope::Guest => "연구할 때마다 넣는 API 키로 서재 서버에서 연구합니다(12시간 뒤 지워짐).",
        Scope::LocalMcp => "이 PC의 AI를 쓸 수 있습니다(서재 연결 주소가 저장됨).",
        Scope::None => "먼저 계정 갈래에서 로그인해 주세요.",
    }
}

/// ai_engines 엔진별 allowed 여부 계산에 쓰는 판정.
pub fn engine_allowed(s: &Scope, kind: &str) -> bool {
    match kind {
        "api" | "cli" => local_allowed(s),
        "server" => server_allowed(s),
        "webkey" => matches!(s, Scope::Member | Scope::Guest),
        _ => false,
    }
}

/// 회원·게스트용 서버 BYOK 엔진(webkey) 목록을 /api/me/aikeys 응답에서 만든다.
/// 설계서 1절 표의 id·kind·name 규칙과 2.2 절의 모델·키 정보를 그대로 따른다.
pub fn webkey_engines(s: &Scope, aikeys: &serde_json::Value) -> Vec<serde_json::Value> {
    let providers = aikeys.get("providers").cloned().unwrap_or(serde_json::Value::Null);
    let saved = aikeys.get("saved").cloned().unwrap_or(serde_json::Value::Null);
    let mut out = Vec::new();
    for (web_id, api_id) in [
        ("web-gemini", "gemini"),
        ("web-openai", "openai"),
        ("web-anthropic", "anthropic"),
    ] {
        let p = providers.get(api_id).cloned().unwrap_or(serde_json::Value::Null);
        let sv = saved.get(api_id).cloned().unwrap_or(serde_json::Value::Null);
        let name = p
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| crate::study::engine_name(api_id).to_string());
        let models: Vec<String> = p
            .get("models")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let default_model = p.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let saved_model = sv.get("model").and_then(|v| v.as_str()).map(str::to_string);
        let saved_bool = sv.get("saved").and_then(|v| v.as_bool()).unwrap_or(false);
        let hint = sv.get("hint").and_then(|v| v.as_str()).map(str::to_string);
        let model = saved_model.unwrap_or(default_model);
        let allowed = engine_allowed(s, "webkey");
        out.push(serde_json::json!({
            "id": web_id,
            "kind": "webkey",
            "name": name,
            "ready": saved_bool || matches!(s, Scope::Guest),
            "model": model,
            "models": models,
            "note": p.get("note").and_then(|v| v.as_str()).unwrap_or(""),
            "hint": hint,
            "keyurl": p.get("keyurl").and_then(|v| v.as_str()).map(str::to_string),
            "allowed": allowed,
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_allowed() {
        assert_eq!(label(&Scope::Owner), "관리자");
        assert_eq!(scope_id(&Scope::LocalMcp), "localmcp");
        assert!(local_allowed(&Scope::Owner));
        assert!(local_allowed(&Scope::LocalMcp));
        assert!(!local_allowed(&Scope::Member));
        assert!(!local_allowed(&Scope::None));
        assert!(server_allowed(&Scope::Special));
        assert!(!server_allowed(&Scope::Member));
        assert!(rejects_local(&Scope::Member));
        assert!(rejects_local(&Scope::Guest));
        assert!(rejects_local(&Scope::Special));
        assert!(!rejects_local(&Scope::Owner));
        assert!(!rejects_local(&Scope::LocalMcp));
        assert!(!rejects_local(&Scope::None));
        assert!(engine_allowed(&Scope::Member, "webkey"));
        assert!(!engine_allowed(&Scope::Owner, "webkey"));
        assert!(engine_allowed(&Scope::Owner, "api"));
        assert!(!engine_allowed(&Scope::Guest, "api"));
    }
}
