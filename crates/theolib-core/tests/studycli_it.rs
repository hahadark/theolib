//! studycli.rs 해석 시험(가짜 CLI 사용) + 실제 CLI 확인(#[ignore]).
//!
//! 가짜 CLI 시험은 Windows 전용이다(`cmd /c` 로 `.cmd` 를 감싸 실행하므로).
//! 유닉스에서는 컴파일만 되고 빈 시험으로 남는다.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use theolib_core::studycli::{CliInfo, CliReq, detect, quick_test, run_claude, run_codex};

/// fixtures 폴더 안 가짜 CLI 경로.
fn fake_cli_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-cli.cmd")
}

fn temp_work_dir() -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("studycli-test-{:?}-{}", std::process::id(), n))
}

fn cli_info(id: &str) -> CliInfo {
    CliInfo {
        id: id.to_string(),
        found: true,
        path: fake_cli_path().to_string_lossy().into_owned(),
        version: "fake".into(),
    }
}

fn req(work_dir: &PathBuf) -> CliReq {
    CliReq {
        system: "SYSTEM".into(),
        user: "요청문 입니다".into(),
        model: "sonnet".into(),
        mcp_url: "https://example.test/mcp/secret-token".into(),
        max_turns: 3,
        work_dir: work_dir.clone(),
        resume: None,
    }
}

fn write_jsonl(work_dir: &PathBuf, name: &str, content: &str) -> PathBuf {
    fs::create_dir_all(work_dir).unwrap();
    let p = work_dir.join(name);
    fs::write(&p, content).unwrap();
    p
}

fn clear_fake_env() {
    for k in ["FAKE_OUT", "FAKE_SLEEP", "FAKE_STDIN_OUT", "FAKE_RESULT"] {
        // edition 2024 에서는 환경변수 조작이 unsafe 이다. 시험 한정 안전(직렬 실행).
        unsafe { std::env::remove_var(k) };
    }
}

fn set_fake_env(k: &str, v: impl AsRef<std::ffi::OsStr>) {
    unsafe { std::env::set_var(k, v) };
}

/// 환경변수를 쓰는 가짜 CLI 시험은 프로세스 전역 env 를 공유하므로 직력로 돈다.
static FAKE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(windows)]
mod fake {
    use super::*;

    #[test]
    fn run_claude_parses_stream_and_emits_steps() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        let jsonl = write_jsonl(
            &work,
            "claude.jsonl",
            concat!(
                r#"{"type":"system","session_id":"abc-123"}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__theology__find_by_passage","input":{"ref":"요 3:16"}}]}}"#, "\n",
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"본문을 찾았습니다."}]}]}}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"짧은 생각"}]}}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용매우긴보고서내용"}]}}"#, "\n",
                r#"{"type":"result","subtype":"success","result":"보고서\n\n내용입니다","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":7},"total_cost_usd":0.123,"num_turns":3,"session_id":"abc-123"}"#,
            ),
        );
        set_fake_env("FAKE_OUT", &jsonl);

        let info = cli_info("claude");
        let r = req(&work);
        let cancel = AtomicBool::new(false);

        let mut kinds = Vec::new();
        let mut tools = Vec::new();
        let out = run_claude(
            &info,
            &r,
            &mut |s, tool| {
                kinds.push(s.kind.clone());
                if let Some((name, args)) = tool {
                    tools.push((name, args));
                }
            },
            &cancel,
        );

        assert_eq!(out.status, "done");
        assert_eq!(out.md.trim(), "보고서\n\n내용입니다");
        assert_eq!(out.session_id.as_deref(), Some("abc-123"));
        assert_eq!(out.engine, "claude");
        assert_eq!(out.model, "sonnet");
        assert!((out.cost.unwrap() - 0.123).abs() < 1e-9);
        assert_eq!(out.turns_used, Some(3));
        assert_eq!(out.tokens["input_tokens"], 10);
        assert_eq!(out.tokens["output_tokens"], 20);
        assert_eq!(out.tokens["cache_read_input_tokens"], 5);
        assert_eq!(out.tokens["cache_creation_input_tokens"], 7);

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0, "find_by_passage");
        assert_eq!(tools[0].1["ref"], "요 3:16");

        assert!(kinds.contains(&"tool".to_string()));
        assert!(kinds.contains(&"tool_result".to_string()));
        assert!(kinds.contains(&"think".to_string()));
        assert!(kinds.contains(&"write".to_string()));

        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_claude_two_tool_steps() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        let jsonl = write_jsonl(
            &work,
            "claude.jsonl",
            concat!(
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__theology__find_by_passage","input":{"ref":"요 3:16"}}]}}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__theology__read_pages","input":{"book":"x","page":1}}]}}"#, "\n",
                r#"{"type":"result","subtype":"success","result":"완료","usage":{},"total_cost_usd":0.0,"num_turns":2,"session_id":"s"}"#,
            ),
        );
        set_fake_env("FAKE_OUT", &jsonl);

        let info = cli_info("claude");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        let mut tools = Vec::new();
        run_claude(
            &info,
            &r,
            &mut |_, tool| {
                if let Some(t) = tool {
                    tools.push(t.0);
                }
            },
            &cancel,
        );
        assert_eq!(
            tools,
            vec!["find_by_passage".to_string(), "read_pages".to_string()]
        );
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_claude_limit_when_usage_limit() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        let jsonl = write_jsonl(
            &work,
            "claude.jsonl",
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"usage limit reached"}"#,
        );
        set_fake_env("FAKE_OUT", &jsonl);
        let info = cli_info("claude");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        let out = run_claude(&info, &r, &mut |_, _| {}, &cancel);
        assert_eq!(out.status, "limit");
        assert!(out.error.to_lowercase().contains("usage limit"));
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_claude_error_when_no_result() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        let jsonl = write_jsonl(&work, "claude.jsonl", "not-json\n");
        set_fake_env("FAKE_OUT", &jsonl);
        let info = cli_info("claude");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        let out = run_claude(&info, &r, &mut |_, _| {}, &cancel);
        assert_eq!(out.status, "error");
        assert!(!out.error.is_empty());
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_claude_error_max_turns_appends_note() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        let jsonl = write_jsonl(
            &work,
            "claude.jsonl",
            concat!(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"마지막 생각"}]}}"#, "\n",
                r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#,
            ),
        );
        set_fake_env("FAKE_OUT", &jsonl);
        let info = cli_info("claude");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        let out = run_claude(&info, &r, &mut |_, _| {}, &cancel);
        assert_eq!(out.status, "done");
        assert!(out.md.contains("마지막 생각"));
        assert!(out.md.contains("도구 사용 횟수 한도"));
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_claude_mcp_file_removed_after_run() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        let jsonl = write_jsonl(
            &work,
            "claude.jsonl",
            r#"{"type":"result","subtype":"success","result":"완료","usage":{},"total_cost_usd":0.0,"num_turns":1,"session_id":"s"}"#,
        );
        set_fake_env("FAKE_OUT", &jsonl);
        let info = cli_info("claude");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        run_claude(&info, &r, &mut |_, _| {}, &cancel);
        let leftovers = fs::read_dir(&work)
            .map(|d| {
                d.filter_map(|e| e.ok())
                    .filter(|e| e.file_name().to_string_lossy().starts_with("mcp-"))
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "MCP 파일이 남음");
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_claude_stdin_matches_prompt() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        fs::create_dir_all(&work).unwrap();
        let jsonl = write_jsonl(
            &work,
            "claude.jsonl",
            r#"{"type":"result","subtype":"success","result":"완료","usage":{},"total_cost_usd":0.0,"num_turns":1,"session_id":"s"}"#,
        );
        let stdin_out = work.join("stdin.txt");
        set_fake_env("FAKE_OUT", &jsonl);
        set_fake_env("FAKE_STDIN_OUT", &stdin_out);

        let info = cli_info("claude");
        let mut r = req(&work);
        r.user = "HELLO PROMPT".to_string();
        let cancel = AtomicBool::new(false);
        run_claude(&info, &r, &mut |_, _| {}, &cancel);

        let got = fs::read_to_string(&stdin_out).unwrap();
        assert_eq!(got, "HELLO PROMPT");
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_claude_cancel_stops_quickly() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        fs::create_dir_all(&work).unwrap();
        set_fake_env("FAKE_SLEEP", "60");
        let info = cli_info("claude");
        let r = req(&work);
        let cancel = AtomicBool::new(false);

        let t0 = Instant::now();
        let out = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(500));
                cancel.store(true, Ordering::SeqCst);
            });
            run_claude(&info, &r, &mut |_, _| {}, &cancel)
        });
        let elapsed = t0.elapsed();

        assert_eq!(out.status, "stopped");
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "너무 오래 걸림: {:?}",
            elapsed
        );
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_codex_parses_and_emits_steps() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        fs::create_dir_all(&work).unwrap();
        let jsonl = write_jsonl(
            &work,
            "codex.jsonl",
            concat!(
                r#"{"type":"item.started","item":{"type":"mcp_tool_call","tool":"read_pages","arguments":{"book":"x","page":1}}}"#, "\n",
                r#"{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"read_pages","arguments":{},"output":{"text":"3쪽 내용"}}}"#, "\n",
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"짧은 생각"}}"#, "\n",
                r#"{"type":"turn.completed","usage":{"input_tokens":30,"output_tokens":40}}"#,
            ),
        );
        set_fake_env("FAKE_OUT", &jsonl);
        set_fake_env("FAKE_RESULT", "코덱스 보고서 본문");

        let info = cli_info("codex");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        let mut kinds = Vec::new();
        let mut tools = Vec::new();
        let out = run_codex(
            &info,
            &r,
            &mut |s, tool| {
                kinds.push(s.kind.clone());
                if let Some((name, args)) = tool {
                    tools.push((name, args));
                }
            },
            &cancel,
        );

        assert_eq!(out.status, "done");
        assert_eq!(out.md, "코덱스 보고서 본문");
        assert_eq!(out.engine, "codex");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0, "read_pages");
        assert_eq!(tools[0].1["book"], "x");
        assert_eq!(out.tokens["input_tokens"], 30);
        assert!(kinds.contains(&"tool".to_string()));
        assert!(kinds.contains(&"tool_result".to_string()));
        assert!(kinds.contains(&"think".to_string()));

        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_codex_no_result_is_error() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        fs::create_dir_all(&work).unwrap();
        let info = cli_info("codex");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        let out = run_codex(&info, &r, &mut |_, _| {}, &cancel);
        assert_eq!(out.status, "error");
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_claude_carries_call_id() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        let jsonl = write_jsonl(
            &work,
            "claude.jsonl",
            concat!(
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu-1","name":"mcp__theology__find_by_passage","input":{"ref":"요 3:16"}}]}}"#, "\n",
                r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":[{"type":"text","text":"본문"}]}]}}"#, "\n",
                r#"{"type":"result","subtype":"success","result":"완료","usage":{},"total_cost_usd":0.0,"num_turns":1,"session_id":"s"}"#,
            ),
        );
        set_fake_env("FAKE_OUT", &jsonl);
        let info = cli_info("claude");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        let mut tool_ids = Vec::new();
        let mut result_ids = Vec::new();
        run_claude(
            &info,
            &r,
            &mut |s, tool| {
                if tool.is_some() {
                    tool_ids.push(s.call_id.clone());
                }
                if s.kind == "tool_result" {
                    result_ids.push(s.call_id.clone());
                }
            },
            &cancel,
        );
        assert_eq!(tool_ids, vec![Some("tu-1".to_string())]);
        assert_eq!(result_ids, vec![Some("tu-1".to_string())]);
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }

    #[test]
    fn run_codex_carries_call_id() {
        let _g = FAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fake_env();
        let work = temp_work_dir();
        fs::create_dir_all(&work).unwrap();
        let jsonl = write_jsonl(
            &work,
            "codex.jsonl",
            concat!(
                r#"{"type":"item.started","item":{"id":"mcp-1","type":"mcp_tool_call","tool":"read_pages","arguments":{"book":"x","page":1}}}"#, "\n",
                r#"{"type":"item.completed","item":{"id":"mcp-1","type":"mcp_tool_call","tool":"read_pages","arguments":{},"output":{"text":"3쪽 내용"}}}"#, "\n",
                r#"{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"완료"}}"#, "\n",
                r#"{"type":"turn.completed","usage":{"input_tokens":30,"output_tokens":40}}"#,
            ),
        );
        set_fake_env("FAKE_OUT", &jsonl);
        set_fake_env("FAKE_RESULT", "코덱스 보고서 본문");
        let info = cli_info("codex");
        let r = req(&work);
        let cancel = AtomicBool::new(false);
        let mut tool_ids = Vec::new();
        let mut result_ids = Vec::new();
        run_codex(
            &info,
            &r,
            &mut |s, tool| {
                if tool.is_some() {
                    tool_ids.push(s.call_id.clone());
                }
                if s.kind == "tool_result" {
                    result_ids.push(s.call_id.clone());
                }
            },
            &cancel,
        );
        assert_eq!(tool_ids, vec![Some("mcp-1".to_string())]);
        assert_eq!(result_ids, vec![Some("mcp-1".to_string())]);
        let _ = fs::remove_dir_all(&work);
        clear_fake_env();
    }
}

#[cfg(not(windows))]
mod fake {
    #[test]
    fn noop() {}
}

// ---------------------------------------------------------------------------
// 실제 CLI 확인(#[ignore]) — 구독 사용량을 아끼려고 한 번만 실행.
// ---------------------------------------------------------------------------

#[test]
#[ignore]
fn real_detect_and_quick_test_claude() {
    let info = detect("claude");
    assert!(info.found, "claude 미설치? path={}", info.path);
    eprintln!("claude path={} version={}", info.path, info.version);
    match quick_test(&info) {
        Ok(ans) => eprintln!("claude quick_test OK: {}", ans),
        Err(e) => eprintln!("claude quick_test ERR: {}", e),
    }
}

#[test]
#[ignore]
fn real_detect_and_quick_test_codex() {
    let info = detect("codex");
    assert!(info.found, "codex 미설치? path={}", info.path);
    eprintln!("codex path={} version={}", info.path, info.version);
    match quick_test(&info) {
        Ok(ans) => eprintln!("codex quick_test OK: {}", ans),
        Err(e) => eprintln!("codex quick_test ERR: {}", e),
    }
}
