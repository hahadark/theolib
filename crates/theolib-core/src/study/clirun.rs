//! `study::CliRunner` 의 실제 구현. 구독 CLI(claude, codex)를 찾아 실행한다.
//!
//! `study::` 와 `studycli::` 는 같은 칸의 중복 구조체(`Step`·`RunOut`·`CliReq`)를
//! 따로 두고 있는데, 여기서는 변환 함수로 이어 준다. 공개 이름은 그대로 유지한다.

use std::sync::atomic::AtomicBool;

use crate::study::{CliReq, CliRunner, RunOut, Step};
use crate::studycli;

/// CLI 엔진 이름(설계서의 "클로드 Code"·"코덱스" 표기를 따름).
fn cli_display_name<'a>(engine: &'a str) -> &'a str {
    match engine {
        "claude" => "클로드 Code",
        "codex" => "Codex",
        _ => engine,
    }
}

// ---- 변환 함수(study ↔ studycli, 같은 칸) ----

fn to_cli_req(req: &CliReq) -> studycli::CliReq {
    studycli::CliReq {
        system: req.system.clone(),
        user: req.user.clone(),
        model: req.model.clone(),
        mcp_url: req.mcp_url.clone(),
        max_turns: req.max_turns,
        work_dir: req.work_dir.clone(),
        resume: req.resume.clone(),
    }
}

fn to_cli_step(s: &studycli::Step) -> Step {
    Step { kind: s.kind.clone(), text: s.text.clone(), call_id: s.call_id.clone() }
}

fn from_cli_out(out: studycli::RunOut) -> RunOut {
    RunOut {
        status: out.status,
        md: out.md,
        error: out.error,
        engine: out.engine,
        model: out.model,
        session_id: out.session_id,
        cost: out.cost,
        tokens: out.tokens,
        turns_used: out.turns_used,
    }
}

/// 이 PC에 설치된 구독 CLI(claude, codex)를 그대로 실행하는 `CliRunner`.
pub struct LocalCli;

impl CliRunner for LocalCli {
    fn run(
        &self,
        engine: &str,
        req: &CliReq,
        on: &mut dyn FnMut(Step, Option<(String, serde_json::Value)>),
        cancel: &AtomicBool,
    ) -> RunOut {
        let info = studycli::detect(engine);
        if !info.found {
            return RunOut {
                status: "error".into(),
                error: format!(
                    "이 PC에 {} 명령줄 도구가 설치되어 있지 않습니다. AI 설정에서 확인해 주세요.",
                    cli_display_name(engine)
                ),
                engine: engine.to_string(),
                model: req.model.clone(),
                ..Default::default()
            };
        }
        let crev = to_cli_req(req);
        let mut on2 = |step: studycli::Step, tool: Option<(String, serde_json::Value)>| {
            on(to_cli_step(&step), tool);
        };
        let out = match engine {
            "claude" => studycli::run_claude(&info, &crev, &mut on2, cancel),
            _ => studycli::run_codex(&info, &crev, &mut on2, cancel),
        };
        // 오류 문장에 MCP 주소(토큰)가 섞이면 가린다.
        let mut out = from_cli_out(out);
        out.error = crate::study::redact(&out.error, &[req.mcp_url.clone()]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names() {
        assert_eq!(cli_display_name("claude"), "클로드 Code");
        assert_eq!(cli_display_name("codex"), "Codex");
    }
}
