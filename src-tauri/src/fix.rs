//! 주석 글 AI 보정 명령(화면 ↔ theolib_core::fix).
//! 한 번에 한 작업만 돌린다. 진행은 `fix-progress`, 끝은 `fix-done` 이벤트로 알린다.
use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use std::collections::HashSet;
use theolib_core::{Home, fix, study, studycli, web};

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

#[derive(Serialize, Clone)]
struct DoneEv {
    #[serde(flatten)]
    sum: fix::Summary,
    /// 서재에 올린 결과
    share: fix::SyncOut,
}

#[derive(Serialize, Clone)]
struct SyncedEv {
    bk: i64,
    changed: usize,
}

static PULLING: Mutex<Option<HashSet<i64>>> = Mutex::new(None);

/// 주석을 열 때 뒤에서 조용히 부른다: 남은 올릴 것을 올리고, 그 책의 서재 보정본이 바뀌었으면 받아 온다.
/// 받아서 바뀐 것이 있으면 `fix-synced` 로 알려 주석 창을 다시 그리게 한다. 책마다 5분에 한 번만 묻는다.
pub fn kick_pull(app: &AppHandle, bk: i64) {
    {
        let mut g = PULLING.lock().unwrap();
        if !g.get_or_insert_with(HashSet::new).insert(bk) {
            return;
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let done = || {
            if let Some(s) = PULLING.lock().unwrap().as_mut() {
                s.remove(&bk);
            }
        };
        let Ok(h) = Home::default_location() else { return done() };
        if !web::status(&h).logged_in {
            return done();
        }
        let net = fix::WebNet(&h);
        if fix::has_pending_push(&h) {
            let _ = fix::push(&h, &net);
        }
        if let Ok(n) = fix::pull_if_stale(&h, &net, bk, 300) {
            if n > 0 {
                let _ = app.emit("fix-synced", SyncedEv { bk, changed: n });
            }
        }
        done();
    });
}

/// 보정에 쓸 수 있는 이 PC의 AI(구독 CLI 가 깔려 있거나 API 키가 저장된 것). 계정 등급과 상관없이 보여 준다.
#[derive(Serialize, Clone)]
pub struct FixEngine {
    id: String,
    name: String,
    kind: String,
    models: Vec<String>,
}

#[tauri::command]
pub async fn fix_engines() -> R<Vec<FixEngine>> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = vec![];
        for (id, name) in [("codex", "챗GPT 구독"), ("claude", "클로드 구독")] {
            if studycli::detect(id).found {
                out.push(FixEngine { id: id.into(), name: name.into(), kind: "cli".into(), models: vec![] });
            }
        }
        let keys = study::keys::saved(&h);
        for e in study::llm::engines() {
            if keys.contains_key(&e.id) {
                out.push(FixEngine { id: e.id.clone(), name: e.name.to_string(), kind: "api".into(), models: e.models.iter().map(|m| m.to_string()).collect() });
            }
        }
        Ok(out)
    })
    .await
    .map_err(e)?
}

/// 지금 바로 서재와 맞춘다(남은 것 올리기 + 그 책 받기). 보정 창을 열 때 부른다.
#[tauri::command]
pub async fn fix_sync(bk: i64) -> R<fix::SyncOut> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        if !web::status(&h).logged_in {
            return Ok(fix::SyncOut { error: "로그인하면 보정본을 서재와 나눕니다.".into(), ..Default::default() });
        }
        let net = fix::WebNet(&h);
        let mut out = fix::push(&h, &net);
        match fix::pull(&h, &net, bk) {
            Ok(n) => out.pulled = n,
            Err(x) if out.error.is_empty() => out.error = x.to_string(),
            Err(_) => {}
        }
        Ok(out)
    })
    .await
    .map_err(e)?
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

/// 한 주석에서 고른 풀이들(차례 번호).
#[derive(serde::Deserialize)]
pub struct Pick {
    series: String,
    seqs: Vec<i64>,
}

/// 고른 풀이들을 보정한다. 주석을 여러 개 골랐으면 한 작업으로 함께 돌린다.
#[tauri::command]
pub async fn fix_start(app: AppHandle, bk: i64, picks: Vec<Pick>, engine: String, model: String) -> R<usize> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        if RUN.lock().unwrap().as_ref().is_some_and(|r| r.running) {
            return Err("이미 보정하고 있습니다. 끝난 뒤에 다시 해 주세요.".to_string());
        }
        // 받은 주석 글을 이 PC의 AI로 고치는 일이라 회원도 쓸 수 있다(AI 본문연구와 달리 서재 전문을 읽지 않는다). 게스트만 막는다.
        if matches!(study::access::scope(&h), study::access::Scope::Guest) {
            return Err("게스트 계정으로는 주석 글을 보정할 수 없습니다. 회원으로 로그인해 주세요.".to_string());
        }
        let mut jobs = vec![];
        for p in &picks {
            jobs.extend(fix::jobs_for(&h, &p.series, bk, &p.seqs).map_err(e)?);
        }
        let series = picks.iter().map(|p| p.series.as_str()).collect::<Vec<_>>().join(", ");
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
            // 함께 보내는 요청 수: 구독 CLI 는 6개, API 는 8개(견본 시험에서 3개일 때보다 큰 장이 절반 가까이 빨라졌다).
            let workers = if engine == "claude" || engine == "codex" { 6 } else { 8 };
            let sum = match fix::run(&h, &jobs, ai.as_ref(), &engine, &model, workers, &on, &CANCEL) {
                Ok(s) => s,
                Err(x) => fix::Summary { total, error: x.to_string(), ..Default::default() },
            };
            // 바로 적용된 보정본은 서재에 올려 다른 사용자와 나눈다(로그인했을 때만. 실패하면 다음에 다시 올린다).
            let share = if web::status(&h).logged_in { fix::push(&h, &fix::WebNet(&h)) } else { fix::SyncOut::default() };
            if let Some(r) = RUN.lock().unwrap().as_mut() {
                r.running = false;
                r.summary = Some(sum.clone());
            }
            let _ = app.emit("fix-done", DoneEv { sum, share });
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
    tauri::async_runtime::spawn_blocking(move || {
        let n = fix::approve(&h, &series, bk, &seqs).map_err(e)?;
        push_later(h);
        Ok(n)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
pub async fn fix_discard(series: String, bk: i64, seqs: Vec<i64>) -> R<usize> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let n = fix::discard(&h, &series, bk, &seqs).map_err(e)?;
        push_later(h);
        Ok(n)
    })
    .await
    .map_err(e)?
}

/// 적용하거나 되돌린 것을 뒤에서 서재에 알린다(실패하면 다음에 주석을 열 때 다시 한다).
fn push_later(h: Home) {
    std::thread::spawn(move || {
        if fix::has_pending_push(&h) && web::status(&h).logged_in {
            let _ = fix::push(&h, &fix::WebNet(&h));
        }
    });
}
