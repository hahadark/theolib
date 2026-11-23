//! 주석 글 AI 보정 명령(화면 ↔ theolib_core::fix).
//! 한 번에 한 작업만 돌린다. 진행은 `fix-progress`, 끝은 `fix-done` 이벤트로 알린다.
use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use theolib_core::{Home, fix, study};

type R<T> = Result<T, String>;
fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}
fn home() -> R<Home> {
    Home::default_location().map_err(e)
}

/// 지금(또는 마지막으로) 돌린 보정 작업. 창을 닫았다 열어도 이어서 볼 수 있게 들고 있는다.
#[derive(Serialize, Clone, Default)]
pub struct RunState {
    running: bool,
    series: String,
    bk: i64,
    engine: String,
    model: String,
    done: usize,
    total: usize,
    notes: Vec<fix::NoteOut>,
    summary: Option<fix::Summary>,
}

static CANCEL: AtomicBool = AtomicBool::new(false);
static RUN: Mutex<Option<RunState>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct ProgressEv {
    note: fix::NoteOut,
    done: usize,
    total: usize,
}

#[tauri::command]
pub async fn fix_targets(series: String, bk: i64, lo: i64, hi: i64) -> R<Vec<fix::Target>> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || fix::targets(&h, &series, bk, lo, hi).map_err(e)).await.map_err(e)?
}

#[tauri::command]
pub fn fix_state() -> RunState {
    RUN.lock().unwrap().clone().unwrap_or_default()
}

#[tauri::command]
pub fn fix_stop() {
    CANCEL.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn fix_start(app: AppHandle, series: String, bk: i64, seqs: Vec<i64>, engine: String, model: String) -> R<usize> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        if RUN.lock().unwrap().as_ref().is_some_and(|r| r.running) {
            return Err("이미 보정하고 있습니다. 끝난 뒤에 다시 해 주세요.".to_string());
        }
        // 이 PC의 AI(API 키·구독 CLI)를 쓰는 일이라 AI 본문연구와 같은 권한 규칙을 따른다.
        if study::access::rejects_local(&study::access::scope(&h)) {
            return Err("이 계정으로는 이 PC의 AI를 쓸 수 없습니다. 관리자 계정으로 로그인해 주세요.".to_string());
        }
        let jobs = fix::jobs_for(&h, &series, bk, &seqs).map_err(e)?;
        if jobs.is_empty() {
            return Err("보정할 풀이를 고르지 않았습니다.".to_string());
        }
        let ai = fix::make_ai(&h, &engine, &model)?;
        let total = jobs.len();
        CANCEL.store(false, Ordering::Relaxed);
        *RUN.lock().unwrap() = Some(RunState { running: true, series: series.clone(), bk, engine: engine.clone(), model: model.clone(), total, ..Default::default() });
        std::thread::spawn(move || {
            let on = |o: &fix::NoteOut, done: usize, total: usize| {
                if let Some(r) = RUN.lock().unwrap().as_mut() {
                    r.done = done;
                    r.notes.push(o.clone());
                }
                let _ = app.emit("fix-progress", ProgressEv { note: o.clone(), done, total });
            };
            // 구독 CLI 는 프로세스를 띄우므로 3개, API 는 4개를 함께 보낸다.
            let workers = if engine == "claude" || engine == "codex" { 3 } else { 4 };
            let sum = match fix::run(&h, &jobs, ai.as_ref(), &engine, &model, workers, &on, &CANCEL) {
                Ok(s) => s,
                Err(x) => fix::Summary { total, error: x.to_string(), ..Default::default() },
            };
            if let Some(r) = RUN.lock().unwrap().as_mut() {
                r.running = false;
                r.summary = Some(sum.clone());
            }
            let _ = app.emit("fix-done", sum);
        });
        Ok(total)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn fix_pair(series: String, bk: i64, seq: i64) -> R<Option<fix::Pair>> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || fix::pair(&h, &series, bk, seq).map_err(e)).await.map_err(e)?
}

#[tauri::command]
pub async fn fix_approve(series: String, bk: i64, seqs: Vec<i64>) -> R<usize> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || fix::approve(&h, &series, bk, &seqs).map_err(e)).await.map_err(e)?
}

#[tauri::command]
pub async fn fix_discard(series: String, bk: i64, seqs: Vec<i64>) -> R<usize> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || fix::discard(&h, &series, bk, &seqs).map_err(e)).await.map_err(e)?
}
