//! AI 본문연구(앱판) 공개 API.
//! 경로: `study_dir(home)` = `<root>/study`, 기록 `<root>/study/jobs/<id>.json`,
//! 설정 `<root>/study/settings.json`. (home.rs 는 고치지 않는다.)
use crate::Home;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

pub mod access;
pub mod clirun;
pub mod job;
pub mod keys;
pub mod llm;
pub mod prompt;
pub mod settings;
pub mod time;

/// 웹판 실행기의 PURPOSES·DEPTH 를 그대로 옮긴 표.
pub const PURPOSES: [&str; 7] = [
    "금요기도회 설교",
    "주일 설교",
    "새벽기도 설교",
    "수요예배 설교",
    "성경공부(소그룹)",
    "강해 연구",
    "개인 묵상",
];

pub const DEPTH: [(&str, &str, u32, u32); 3] = [
    // (id, 표시 이름, 읽을 분량에서 max_steps = DEPTH[depth][2]는 서버에서, 단계 한도는 아래 값)
    ("quick", "빠르게", 30, 14),
    ("normal", "보통", 55, 24),
    ("deep", "깊게", 90, 36),
];

/// 깊이 id → (표시 이름, 분량 설명, 서버 max_steps, 로컬 단계 한도).
pub fn depth_info(id: &str) -> (&'static str, &'static str, u32, u32) {
    for (i, n, ms, lim) in DEPTH {
        if i == id {
            return (i, n, ms, lim);
        }
    }
    DEPTH[1]
}

pub fn depth_labels() -> [(&'static str, &'static str); 3] {
    [("quick", "빠르게"), ("normal", "보통"), ("deep", "깊게")]
}

/// 연구 데이터 폴더.
pub fn study_dir(home: &Home) -> PathBuf {
    home.root.join("study")
}

pub fn jobs_dir(home: &Home) -> PathBuf {
    study_dir(home).join("jobs")
}

/// 연구 기록 파일 경로(id 는 안전한 글자만).
pub fn job_path(home: &Home, id: &str) -> PathBuf {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    jobs_dir(home).join(format!("{}.json", safe))
}

/// 엔진 이름표. 설계서 3절의 이름과 같게 한 곳에서 관리한다.
pub fn engine_name(id: &str) -> &'static str {
    match id {
        "deepseek" => "딥시크",
        "claude" => "클로드 구독",
        "codex" => "챗GPT 구독",
        "server" => "서재 서버의 구독 AI (집 PC)",
        "gemini" => "제미나이",
        "openai" => "챗GPT API",
        "anthropic" => "클로드 API",
        "custom" => "직접 넣기",
        _ => "",
    }
}

/// 진행 단계(웹판 Step 칸: kind, text).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Step {
    pub kind: String,
    pub text: String,
    /// 도구 호출 식별자(API `tool_calls[].id`, claude `tool_use.id` ↔ `tool_result.tool_use_id`, codex `item.id`).
    /// tool 과 tool_result 단계에서 채운다(결과가 왔을 때 제목을 고쳐 쓰기 위해).
    #[serde(default)]
    pub call_id: Option<String>,
}

/// CLI 실행기에게 넘길 요청(설계서 2.3 과 같은 칸).
#[derive(Clone, Debug)]
pub struct CliReq {
    pub system: String,
    pub user: String,
    pub model: String,
    pub mcp_url: String,
    pub max_turns: u32,
    pub work_dir: PathBuf,
    pub resume: Option<String>,
}

/// CLI 실행 결과(설계서 2.3 과 같은 칸).
#[derive(Clone, Debug, Default)]
pub struct RunOut {
    pub status: String,
    pub md: String,
    pub error: String,
    pub engine: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cost: Option<f64>,
    pub tokens: serde_json::Value,
    pub turns_used: Option<i64>,
}

/// 구독 CLI(claude, codex) 실행기. studycli.rs 가 다른 작업자에 의해 구현된다.
/// 여기서는 트레이트로 받아 실행기와 맞물리게 한다.
pub trait CliRunner: Send + Sync {
    /// engine: "claude" | "codex". 못 찾으면 status=error 로
    /// "이 PC에 … 가 설치되어 있지 않습니다" 를 돌려준다.
    fn run(
        &self,
        engine: &str,
        req: &CliReq,
        on: &mut dyn FnMut(Step, Option<(String, serde_json::Value)>),
        cancel: &AtomicBool,
    ) -> RunOut;
}

/// 오류·기록·이벤트에 비밀값이 섞이면 `…` 로 가리는 공용 함수.
/// secrets 에는 키·쿠키·MCP 주소(토큰 포함)를 넣는다.
pub fn redact(msg: &str, secrets: &[String]) -> String {
    let mut m = msg.to_string();
    for s in secrets {
        if s.is_empty() {
            continue;
        }
        m = m.replace(s.as_str(), "…");
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_names() {
        assert_eq!(engine_name("deepseek"), "딥시크");
        assert_eq!(engine_name("claude"), "클로드 구독");
        assert_eq!(engine_name("codex"), "챗GPT 구독");
        assert_eq!(engine_name("server"), "서재 서버의 구독 AI (집 PC)");
        // API 엔진은 '구독'과 헷갈리지 않게 API 를 붙인다.
        assert_eq!(engine_name("openai"), "챗GPT API");
        assert_eq!(engine_name("anthropic"), "클로드 API");
    }

    #[test]
    fn depth_table() {
        assert_eq!(depth_info("quick").0, "quick");
        assert_eq!(depth_info("normal").1, "보통");
        assert_eq!(depth_info("deep").3, 36);
        assert_eq!(depth_info("bogus").1, "보통");
    }

    #[test]
    fn redact_hides() {
        let secret = "https://x/mcp/tok123456789".to_string();
        let out = redact("주소 https://x/mcp/tok123456789 오류", &[secret]);
        assert!(!out.contains("tok123"));
        assert!(out.contains("…"));
    }
}
