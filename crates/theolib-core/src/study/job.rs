//! 연구 기록(웹판 /api/study/get 응답과 같은 꼴)과 실행기.
use crate::Home;
use crate::study::{self, CliReq, CliRunner, RunOut, Step};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

/// 기록 파일의 turn. steps 의 칸 이름은 웹판처럼 t(시각), k(kind), x(글).
pub fn turn_json(t: &Value) -> Value {
    json!({
        "q": t.get("q").cloned().unwrap_or(Value::Null),
        "status": t.get("status").cloned().unwrap_or(json!("queued")),
        "created": t.get("created").cloned().unwrap_or(Value::Null),
        "started": t.get("started").cloned().unwrap_or(Value::Null),
        "finished": t.get("finished").cloned().unwrap_or(Value::Null),
        "seconds": t.get("seconds").and_then(|v| v.as_i64()).unwrap_or(0),
        "steps": t.get("steps").cloned().unwrap_or(json!([])),
        "md": t.get("md").cloned().unwrap_or(json!("")),
        "error": t.get("error").cloned().unwrap_or(Value::Null),
        "engine": t.get("engine").cloned().unwrap_or(Value::Null),
        "model": t.get("model").cloned().unwrap_or(Value::Null),
        "cost": t.get("cost").cloned().unwrap_or(Value::Null),
        "tokens": t.get("tokens").cloned().unwrap_or(json!({})),
        "turns_used": t.get("turns_used").cloned().unwrap_or(Value::Null),
        "stop": t.get("stop").cloned().unwrap_or(json!(false)),
    })
}

fn read_job(home: &Home, id: &str) -> Option<Value> {
    let b = std::fs::read(study::job_path(home, id)).ok()?;
    serde_json::from_slice(&b).ok()
}

fn write_job(home: &Home, id: &str, j: &Value) -> std::io::Result<()> {
    let d = study::jobs_dir(home);
    std::fs::create_dir_all(&d)?;
    let p = study::job_path(home, id);
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(j).unwrap_or_default())?;
    std::fs::rename(&tmp, &p)
}

/// 무작위 4자리 16진수(나노초 기반).
fn rand4() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:04x}", (n as u32) & 0xffff)
}

/// id: app-YYYYMMDD-HHMMSS-xxxx.
pub fn new_id() -> String {
    let t = study::time::now();
    let (d, tm) = t.split_once(' ').unwrap_or((&t, ""));
    let d = d.replace('-', "");
    let tm = tm.replace(':', "");
    format!("app-{d}-{tm}-{}", rand4())
}

/// cats 필수값 검사(참고 설교 골랐는데 설교자 0명).
pub fn sermon_options_empty(so: &Value) -> bool {
    so.get("preachers").and_then(|p| p.as_array()).map(|a| a.is_empty()).unwrap_or(true)
}

/// study.start 와 같은 입력 검증. 돌려주는 검증된 정리값.
fn normalize_input(d: &Value) -> Result<(String, String, String, String, Value, Value, String), (u16, Value)> {
    let err = |m: &str| (400, json!({"ok": false, "error": m}));
    let ref_ = d.get("ref").and_then(|v| v.as_str()).unwrap_or("").trim();
    if ref_.is_empty() {
        return Err(err("본문을 넣어 주세요"));
    }
    let ref_ = ref_.chars().take(200).collect::<String>();
    let purpose = d.get("purpose").and_then(|v| v.as_str()).unwrap_or("");
    let purpose = if study::PURPOSES.contains(&purpose) { purpose.to_string() } else { study::PURPOSES[0].to_string() };
    let depth = d.get("depth").and_then(|v| v.as_str()).unwrap_or("normal");
    let depth = if ["quick", "normal", "deep"].contains(&depth) { depth.to_string() } else { "normal".to_string() };
    let notes = d.get("notes").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(2000).collect::<String>();
    // cats 정리: 알려진 목록 유지까진 하지 않고, 원본 그대로 (서버가 정리) — 여기선 그대로 둔다.
    let cats = d.get("cats").cloned().unwrap_or(Value::Null);
    // sermon_options: 참고 설교를 골랐고 설교자 0명이면 400
    let sermon_options = clean_sermon_options(d.get("sermon_options"));
    let cats_list: Vec<String> = cats.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    if cats_list.iter().any(|c| c == "ref_sermons") && sermon_options_empty(&sermon_options) {
        return Err(err("참고할 설교자를 한 명 이상 선택하거나 전체 선택을 눌러 주세요"));
    }
    Ok((ref_, purpose, depth, notes, cats, sermon_options, String::new()))
}

fn clean_sermon_options(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Object(m)) => {
            let mut out = serde_json::Map::new();
            if let Some(p) = m.get("preachers") {
                out.insert("preachers".into(), p.clone());
            } else {
                out.insert("preachers".into(), json!([]));
            }
            for k in ["churches", "statuses", "source_types", "max_count", "use", "include_same"] {
                if let Some(x) = m.get(k) {
                    out.insert(k.into(), x.clone());
                }
            }
            Value::Object(out)
        }
        _ => json!({"preachers": []}),
    }
}

/// engine/model 결정. 없으면 settings 값. 알 수 없는 engine 은 400.
/// 로그인한 계정이 이 PC의 AI 를 못 쓰면 403 을 돌려준다(설계서 2.2 절).
/// 로그인하지 않은 상태(None)는 거절하지 않는다(명령줄·첫 실행·기존 동작 보존).
fn local_ai_denied(home: &Home) -> Result<(), (u16, Value)> {
    let s = study::access::scope(home);
    if study::access::rejects_local(&s) {
        return Err((
            403,
            json!({"ok": false, "error": "이 계정은 이 PC의 AI 를 쓸 수 없습니다. 설정의 AI 연결을 확인해 주세요."}),
        ));
    }
    Ok(())
}

fn resolve_engine(home: &Home, d: &Value) -> Result<(String, String), (u16, Value)> {
    let st = study::settings::load(home);
    let engine = d.get("engine").and_then(|v| v.as_str()).unwrap_or("");
    let engine = if engine.is_empty() { st.engine.clone() } else { engine.to_string() };
    let known = ["deepseek", "claude", "codex", "server", "gemini", "openai", "anthropic", "custom"];
    if !known.contains(&engine.as_str()) {
        return Err((400, json!({"ok": false, "error": "선택할 수 없는 AI입니다."})));
    }
    if engine == "server" {
        return Err((400, json!({"ok": false, "error": "서재 서버 연구는 앱 실행기가 아니라 웹 서재로 보냅니다"})));
    }
    let default_model = default_model_for(&engine);
    let model = d.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let model = if model.is_empty() { st.model_for(&engine, &default_model) } else { model.to_string() };
    Ok((engine, model))
}

fn default_model_for(engine: &str) -> String {
    match engine {
        "deepseek" => "deepseek-flash".into(),
        "claude" => "sonnet".into(),
        "codex" => "gpt-6-luna".into(),
        "gemini" => "gemini-3.8-flash".into(),
        "openai" => "gpt-6-luna".into(),
        "anthropic" => "claude-sonnet-5-5".into(),
        _ => String::new(),
    }
}

/// 시작. 웹판 start 와 같은 입력·응답. 추가 칸 engine, model.
pub fn start(home: &Home, d: &Value) -> (u16, Value) {
    if let Err(denied) = local_ai_denied(home) {
        return denied;
    }
    let (ref_, purpose, depth, notes, cats, sermon_options, _) = match normalize_input(d) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let (engine, model) = match resolve_engine(home, d) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let id = new_id();
    let created = study::time::now();
    let turn = json!({"q": null, "status": "queued", "created": created, "started": null, "finished": null, "seconds": 0, "steps": [], "md": "", "error": null, "engine": null, "model": null, "cost": null, "tokens": {}, "turns_used": null, "stop": false});
    let j = json!({
        "id": id, "created": created, "ref": ref_, "purpose": purpose, "depth": depth, "notes": notes,
        "cats": cats, "sermon_options": sermon_options, "engine": engine, "model": model,
        "session_id": null, "status": "queued", "turns": [turn],
    });
    let _ = write_job(home, &id, &j);
    (200, json!({"ok": true, "id": id}))
}

/// 이어 묻기. {id, q}.
pub fn ask(home: &Home, d: &Value) -> (u16, Value) {
    if let Err(denied) = local_ai_denied(home) {
        return denied;
    }
    let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let q = d.get("q").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(3000).collect::<String>();
    if q.is_empty() {
        return (400, json!({"ok": false, "error": "질문을 넣어 주세요"}));
    }
    let Some(mut j) = read_job(home, id) else {
        return (404, json!({"ok": false, "error": "없는 연구"}));
    };
    // 진행 중이면 새 turn 을 queued 로 덧붙인다.
    let turn = json!({"q": q, "status": "queued", "created": study::time::now(), "started": null, "finished": null, "seconds": 0, "steps": [], "md": "", "error": null, "engine": null, "model": null, "cost": null, "tokens": {}, "turns_used": null, "stop": false});
    if let Some(turns) = j.get_mut("turns").and_then(|t| t.as_array_mut()) {
        turns.push(turn);
    }
    let _ = write_job(home, id, &j);
    (200, json!({"ok": true}))
}

/// 실행 중인 turn 의 멈춤 신호를 id·turn 번호로 구분해 담는 레지스트리.
/// 전역 하나짜리 플래그로는 큐에 대기 중인 다른 연구까지 엉뚱하게 멈출 수 있으므로,
/// 현재 실행 중인 각 turn 이 자기 `Arc<AtomicBool>` 을 등록하고 `stop()` 이 그것만 세우게 한다.
fn cancel_registry() -> &'static Mutex<HashMap<(String, usize), Arc<AtomicBool>>> {
    static REG: OnceLock<Mutex<HashMap<(String, usize), Arc<AtomicBool>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 실행 중인 turn 의 멈춤 플래그를 등록하고 그 Arc 를 돌려준다. 같은 (id, turn) 은 덮어쓴다.
fn register_cancel(id: &str, ti: usize) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    cancel_registry().lock().unwrap().insert((id.to_string(), ti), flag.clone());
    flag
}

/// 실행이 끝난 turn 의 등록을 해제한다.
fn unregister_cancel(id: &str, ti: usize) {
    cancel_registry().lock().unwrap().remove(&(id.to_string(), ti));
}

/// 멈춤. queued 면 바로 stopped, running 이면 그 turn 의 플래그만 세운다.
pub fn stop(home: &Home, d: &Value) -> (u16, Value) {
    let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let Some(mut j) = read_job(home, id) else {
        return (404, json!({"ok": false}));
    };
    // 멈춰야 할 turn 번호를 먼저 모은다(등록된 플래그를 세우기 위해).
    let mut running_turns: Vec<usize> = Vec::new();
    if let Some(turns) = j.get_mut("turns").and_then(|t| t.as_array_mut()) {
        for (ti, t) in turns.iter_mut().enumerate() {
            let status = t.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if status == "queued" || status == "running" {
                t["stop"] = json!(true);
                if status == "queued" {
                    t["status"] = json!("stopped");
                } else {
                    running_turns.push(ti);
                }
            }
        }
    }
    // running turn 만 그 turn 의 플래그를 세운다(다른 연구에는 영향 없음).
    if !running_turns.is_empty() {
        let reg = cancel_registry().lock().unwrap();
        for ti in running_turns {
            if let Some(flag) = reg.get(&(id.to_string(), ti)) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
    let _ = write_job(home, id, &j);
    (200, json!({"ok": true}))
}

pub fn delete(home: &Home, d: &Value) -> (u16, Value) {
    let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let Some(j) = read_job(home, id) else {
        return (404, json!({"ok": false}));
    };
    if let Some(turns) = j.get("turns").and_then(|t| t.as_array()) {
        if turns.iter().any(|t| t.get("status").and_then(|v| v.as_str()) == Some("running")) {
            return (409, json!({"ok": false, "error": "진행 중인 연구는 먼저 멈춰 주세요"}));
        }
    }
    let _ = std::fs::remove_file(study::job_path(home, id));
    (200, json!({"ok": true}))
}

/// 최근 상태: running·queued 우선, 아니면 마지막 turn 상태.
fn job_status(j: &Value) -> String {
    let turns = j.get("turns").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let mut st = String::from("done");
    for s in ["running", "queued"] {
        if turns.iter().any(|t| t.get("status").and_then(|v| v.as_str()) == Some(s)) {
            st = s.to_string();
            break;
        }
    }
    if st == "done" {
        st = turns.last().and_then(|t| t.get("status").and_then(|v| v.as_str())).unwrap_or("done").to_string();
    }
    st
}

pub fn list(home: &Home) -> Value {
    let dir = study::jobs_dir(home);
    let mut items = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(b) = std::fs::read(&p) else { continue };
            let Ok(j) = serde_json::from_slice::<Value>(&b) else { continue };
            let id = j.get("id").and_then(|v| v.as_str()).unwrap_or("");
            items.push(json!({
                "id": id,
                "created": j.get("created").cloned().unwrap_or(Value::Null),
                "ref": j.get("ref").cloned().unwrap_or(Value::Null),
                "purpose": j.get("purpose").cloned().unwrap_or(Value::Null),
                "depth": j.get("depth").cloned().unwrap_or(Value::Null),
                "status": job_status(&j),
                "turns": j.get("turns").and_then(|t| t.as_array()).map(|t| t.len()).unwrap_or(0),
                "engine": j.get("engine").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    items.sort_by(|a, b| b.get("created").and_then(|v| v.as_str()).cmp(&a.get("created").and_then(|v| v.as_str())));
    let queue = items.iter().filter(|i| i.get("status").and_then(|v| v.as_str()) == Some("queued")).count();
    json!({"items": items, "queue": queue})
}

/// 기록 + 맨 위 status.
pub fn get(home: &Home, id: &str) -> Option<Value> {
    let mut j = read_job(home, id)?;
    j["status"] = json!(job_status(&j));
    Some(j)
}

/// running 으로 남은 turn → error.
pub fn recover(home: &Home) {
    let dir = study::jobs_dir(home);
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(b) = std::fs::read(&p) else { continue };
        let Ok(mut j) = serde_json::from_slice::<Value>(&b) else { continue };
        let mut changed = false;
        if let Some(turns) = j.get_mut("turns").and_then(|t| t.as_array_mut()) {
            for t in turns.iter_mut() {
                if t.get("status").and_then(|v| v.as_str()) == Some("running") {
                    t["status"] = json!("error");
                    t["error"] = json!("앱이 닫혀 중단되었습니다. 다시 시도해 주세요.");
                    t["finished"] = json!(study::time::now());
                    changed = true;
                }
            }
        }
        if changed {
            let id = j.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let _ = write_job(home, &id, &j);
        }
    }
}

// ---- 실행기 ----

#[derive(Clone, Debug)]
pub enum Event {
    Step { id: String, turn: usize, index: usize, step: Step },
    Status { id: String, turn: usize, status: String },
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 가장 오래된 queued turn 하나를 찾는다. (id, turn index)
fn next_queued(home: &Home) -> Option<(String, usize)> {
    let dir = study::jobs_dir(home);
    let Ok(rd) = std::fs::read_dir(&dir) else { return None };
    // (created, id, turn index) — 오래된 것이 먼저
    let mut best: Option<(String, String, usize)> = None;
    let mut best_id = String::new();
    let mut best_ti = 0usize;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(b) = std::fs::read(&p) else { continue };
        let Ok(j) = serde_json::from_slice::<Value>(&b) else { continue };
        let id = j.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let turns = j.get("turns").and_then(|t| t.as_array()).cloned().unwrap_or_default();
        for (i, t) in turns.iter().enumerate() {
            if t.get("status").and_then(|v| v.as_str()) == Some("queued") && !t.get("stop").and_then(|v| v.as_bool()).unwrap_or(false) {
                let created = t.get("created").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let key = (created.clone(), id.clone(), i);
                let replace = match &best {
                    Some(b) => key < *b,
                    None => true,
                };
                if replace {
                    best = Some(key);
                    best_id = id;
                    best_ti = i;
                }
                break;
            }
        }
    }
    if best.is_some() {
        Some((best_id, best_ti))
    } else {
        None
    }
}

/// 지정한 연구(id) 안에서 아직 끝나지 않은 queued turn(멈춤 제외) 가운데 가장 앞 것을 찾는다.
fn next_queued_of(home: &Home, id: &str) -> Option<usize> {
    let Some(j) = read_job(home, id) else { return None };
    let turns = j.get("turns").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    for (i, t) in turns.iter().enumerate() {
        if t.get("status").and_then(|v| v.as_str()) == Some("queued") && !t.get("stop").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Some(i);
        }
    }
    None
}

/// turn 을 집는다(웹판 study.py 의 _claim_turn 과 같은 뜻). 파일 잠금 없이,
/// 집는 순간 기록을 다시 읽어 여전히 queued 인지 확인하고 running + worker_pid 를 쓴 뒤
/// 한 번 더 읽어 내 pid 인지 확인한다. 집었으면 true.
fn claim_turn(home: &Home, id: &str, ti: usize) -> bool {
    let pid = std::process::id();
    // 1) 다시 읽어 여전히 queued 인지 확인
    let Some(j) = read_job(home, id) else { return false };
    let turns = j.get("turns").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let Some(turn) = turns.get(ti) else { return false };
    if turn.get("status").and_then(|v| v.as_str()) != Some("queued") {
        return false;
    }
    if turn.get("stop").and_then(|v| v.as_bool()).unwrap_or(false) {
        return false;
    }
    // 2) running + worker_pid 를 쓴다
    let mut jw = j;
    if let Some(turns) = jw.get_mut("turns").and_then(|t| t.as_array_mut()) {
        if let Some(t) = turns.get_mut(ti) {
            t["status"] = json!("running");
            t["started"] = json!(study::time::now());
            t["worker_pid"] = json!(pid);
        }
    }
    jw["status"] = json!("running");
    if write_job(home, id, &jw).is_err() {
        return false;
    }
    // 3) 한 번 더 읽어 내 pid 인지 확인
    let Some(j2) = read_job(home, id) else { return false };
    let turns2 = j2.get("turns").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let Some(t2) = turns2.get(ti) else { return false };
    t2.get("worker_pid").and_then(|v| v.as_u64()) == Some(pid as u64)
}

/// 실행 중 단계를 모으고, tool 단계를 call_id 로 기억해 제목을 배운 뒤 문구를 고쳐 쓴다.
/// 단계는 생기는 즉시(첫 단계, 그리고 0.5초 간격으로) 기록 파일에 반영해 화면이 이벤트를 받고
/// 읽었을 때 그 단계가 이미 기록에 있게 한다.
struct Recorder<'a> {
    home: Home,
    id: String,
    turn: usize,
    on: &'a mut dyn FnMut(&Event),
    steps: Vec<Value>,
    titles: HashMap<String, String>,
    tool_index: HashMap<String, usize>,
    tool_args: HashMap<String, (String, Value)>,
    last_save: Option<Instant>,
}

impl<'a> Recorder<'a> {
    fn new(home: &Home, id: String, turn: usize, on: &'a mut dyn FnMut(&Event)) -> Self {
        Recorder {
            home: home.clone(),
            id,
            turn,
            on,
            steps: Vec::new(),
            titles: HashMap::new(),
            tool_index: HashMap::new(),
            tool_args: HashMap::new(),
            last_save: None,
        }
    }

    fn status(&mut self, status: &str) {
        (self.on)(&Event::Status { id: self.id.clone(), turn: self.turn, status: status.to_string() });
    }

    /// 단계를 기록 파일에 반영한다(원자적). force 면 무조건, 아니면 0.5초 간격으로 묶는다.
    fn flush(&mut self, force: bool) {
        let now = Instant::now();
        if !force {
            if let Some(ls) = self.last_save {
                if now.duration_since(ls).as_millis() < 500 {
                    return;
                }
            }
        }
        self.last_save = Some(now);
        let Some(mut j) = read_job(&self.home, &self.id) else { return };
        if let Some(turns) = j.get_mut("turns").and_then(|t| t.as_array_mut()) {
            if let Some(t) = turns.get_mut(self.turn) {
                t["steps"] = json!(self.steps.iter().rev().take(300).rev().cloned().collect::<Vec<_>>());
            }
        }
        let _ = write_job(&self.home, &self.id, &j);
    }

    /// 단계를 하나 추가하고(선택적으로 call_id 포함), 이벤트를 낸 뒤 즉시 기록에 반영한다.
    fn add(&mut self, kind: &str, text: &str, call_id: Option<String>) -> usize {
        let index = self.steps.len();
        let mut s = json!({"t": study::time::now_time(), "k": kind, "x": text});
        if let Some(cid) = &call_id {
            s["c"] = json!(cid);
        }
        let step = Step { kind: kind.to_string(), text: text.to_string(), call_id: call_id.clone() };
        (self.on)(&Event::Step { id: self.id.clone(), turn: self.turn, index, step });
        self.steps.push(s);
        // 이벤트를 받고 화면이 기록을 읽었을 때 그 단계가 이미 있게끔, 내보내기 직전에 항상 저장한다.
        self.flush(true);
        index
    }

    /// info/think/write/error 등 일반 단계.
    fn info(&mut self, kind: &str, text: &str) {
        self.add(kind, text, None);
    }

    /// tool 단계를 추가하고 call_id 를 기억한다(나중에 제목을 배우면 다시 쓴다).
    fn tool(&mut self, name: &str, args: &Value, call_id: Option<String>) {
        let text = step_text(name, args, &self.titles);
        let index = self.add("tool", &text, call_id.clone());
        if let Some(cid) = call_id {
            self.tool_index.insert(cid.clone(), index);
            self.tool_args.insert(cid, (name.to_string(), args.clone()));
        }
    }

    /// tool_result: 제목을 배우고 맞는 tool 단계 문구를 같은 turn·같은 단계 번호로 고쳐 쓴다.
    /// tool_result 는 단계로 기록하지 않는다.
    fn tool_result(&mut self, call_id: Option<String>, text: &str) {
        learn_titles(text, &mut self.titles);
        if let Some(cid) = call_id {
            if let Some((name, args)) = self.tool_args.remove(&cid) {
                if name == "read_pages" {
                    let bid = args.get("book_id").and_then(|v| v.as_str()).unwrap_or("");
                    learn_read_pages_title(text, bid, &mut self.titles);
                }
                if let Some(index) = self.tool_index.remove(&cid) {
                    let new_text = step_text(&name, &args, &self.titles);
                    if let Some(s) = self.steps.get_mut(index) {
                        s["x"] = json!(new_text.clone());
                    }
                    let step = Step { kind: "tool".to_string(), text: new_text, call_id: Some(cid) };
                    (self.on)(&Event::Step { id: self.id.clone(), turn: self.turn, index, step });
                    self.flush(true);
                }
            }
        }
    }

    fn take_steps(&self) -> Vec<Value> {
        self.steps.iter().rev().take(300).rev().cloned().collect()
    }
}

/// 한 turn 실행. 실행기가 돌린다.
fn run_turn(home: &Home, cli: &dyn CliRunner, id: &str, ti: usize, on: &mut dyn FnMut(&Event)) -> RunOut {
    let Some(j) = read_job(home, id) else { return RunOut { status: "error".into(), error: "없는 연구".into(), ..Default::default() } };
    let turns = j.get("turns").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let Some(turn) = turns.get(ti).cloned() else { return RunOut { status: "error".into(), error: "없는 차례".into(), ..Default::default() } };
    if turn.get("status").and_then(|v| v.as_str()) != Some("queued") {
        return RunOut { status: "error".into(), error: "이미 실행된 차례".into(), ..Default::default() };
    }

    // 공통 정보
    let ref_ = j.get("ref").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let purpose = j.get("purpose").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let depth = j.get("depth").and_then(|v| v.as_str()).unwrap_or("normal").to_string();
    let notes = j.get("notes").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let engine = j.get("engine").and_then(|v| v.as_str()).unwrap_or("deepseek").to_string();
    let model = j.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let q = turn.get("q").and_then(|v| v.as_str()).map(|s| s.to_string());
    // 첫 turn 이 claude 였고 그 session_id 가 있으면 이어 묻기는 --resume 로 이어간다.
    let first_engine = turns.first().and_then(|t| t.get("engine").and_then(|v| v.as_str())).unwrap_or("").to_string();
    let prev_session_id = j.get("session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
    let resume = if q.is_some() && engine == "claude" && first_engine == "claude" {
        prev_session_id.clone()
    } else {
        None
    };
    // resume 로 이어 묻는 경우(서버 지시문을 새로 받지만 prev_md 는 보내지 않는다)는 prev_md 를 비운다.
    let prev_md_for_prompt = if resume.is_some() { None } else { turns.first().and_then(|t| t.get("md").and_then(|v| v.as_str())).map(|s| s.to_string()) };

    // turn 을 이 프로세스가 집었는지 확인한다(집지 못하면 다른 프로세스가 실행 중).
    if !claim_turn(home, id, ti) {
        return RunOut { status: "error".into(), error: "다른 프로세스가 이 연구를 실행 중입니다.".into(), engine: engine.clone(), model: model.clone(), ..Default::default() };
    }
    let started_at = Instant::now();

    // 단계를 모으고 기록에 반영하는 기록기.
    let mut rec = Recorder::new(home, id.to_string(), ti, on);
    rec.status("running");

    // 1. MCP 주소 확인
    let mcp_url = crate::mcp::url(home);
    if mcp_url.is_none() {
        rec.info("error", "서재 연결 주소가 없습니다. 서재에 로그인하거나 AI 설정에서 연결 주소를 넣어 주세요.");
        let out = RunOut { status: "error".into(), error: "서재 연결 주소가 없습니다. 서재에 로그인하거나 AI 설정에서 연결 주소를 넣어 주세요.".into(), engine: engine.clone(), model: model.clone(), ..Default::default() };
        return finish_turn(home, id, ti, &mut rec, out, started_at);
    }
    let mcp_url = mcp_url.unwrap();

    // 2. 지시문
    let images = engine == "claude";
    let prompts = match study::prompt::get(home, &ref_, &purpose, &depth, &notes, q.as_deref(), prev_md_for_prompt.as_deref(), images, &mut |s| rec.info("info", s)) {
        Ok(p) => p,
        Err(e) => {
            rec.info("error", &e);
            let out = RunOut { status: "error".into(), error: e, engine: engine.clone(), model: model.clone(), ..Default::default() };
            return finish_turn(home, id, ti, &mut rec, out, started_at);
        }
    };

    // 시작 info
    if matches!(engine.as_str(), "deepseek" | "gemini" | "openai" | "anthropic" | "custom") {
        rec.info("info", &format!("{} {}로 연구를 시작합니다", study::engine_name(&engine), model));
    } else if engine == "claude" {
        let label = if model == "opus" { "Opus" } else { "Sonnet" };
        rec.info("info", &format!("클로드 {label}로 연구를 시작합니다"));
    } else if engine == "codex" {
        rec.info("info", &format!("챗GPT {}로 연구를 시작합니다", model));
    }

    // 이 turn 의 멈춤 신호를 전역 레지스트리에 등록한다(id·turn 으로 구분).
    let cancel = register_cancel(id, ti);
    // 멈춤으로 끝났다면 finish_turn 후 등록을 해제한다.
    let result = run_engine(home, cli, &engine, &model, &prompts, &mcp_url, resume.as_deref(), &mut rec, &cancel);

    // 설정에 fallback 이 있고 결과가 한도(limit)면 그 엔진으로 이어서 한다.
    let fallback = study::settings::load(home).fallback;
    let result = if result.status == "limit" && !fallback.is_empty() && fallback != engine {
        let next_model = study::settings::load(home).model_for(&fallback, "");
        rec.info("info", &format!("{} 사용 한도에 걸려 {}(으)로 이어서 합니다", study::engine_name(&engine), study::engine_name(&fallback)));
        run_engine(home, cli, &fallback, &next_model, &prompts, &mcp_url, None, &mut rec, &cancel)
    } else {
        result
    };

    let result = if result.status == "stopped" {
        // 멈춤을 확인했으면 마지막 단계에 알리고 stopped 로 마무리한다.
        let mut r = result;
        r.status = "stopped".into();
        rec.info("info", "멈췄습니다");
        r
    } else {
        result
    };

    unregister_cancel(id, ti);
    finish_turn(home, id, ti, &mut rec, result, started_at)
}

/// turn 결과를 기록하고 마지막 상태 이벤트를 낸다.
fn finish_turn(home: &Home, id: &str, ti: usize, rec: &mut Recorder, result: RunOut, started_at: Instant) -> RunOut {
    let seconds = started_at.elapsed().as_secs() as i64;
    let mut j2 = read_job(home, id).unwrap_or_else(|| serde_json::json!({}));
    if let Some(turns) = j2.get_mut("turns").and_then(|t| t.as_array_mut()) {
        if let Some(t) = turns.get_mut(ti) {
            t["status"] = json!(result.status);
            t["finished"] = json!(study::time::now());
            t["seconds"] = json!(seconds);
            t["md"] = json!(result.md);
            t["error"] = json!(if result.error.is_empty() { Value::Null } else { Value::String(result.error.clone()) });
            t["engine"] = json!(result.engine);
            t["model"] = json!(result.model);
            t["cost"] = result.cost.map(|c| json!(c)).unwrap_or(Value::Null);
            t["tokens"] = result.tokens.clone();
            t["turns_used"] = result.turns_used.map(|x| json!(x)).unwrap_or(Value::Null);
            t["steps"] = json!(rec.take_steps());
            t["worker_pid"] = Value::Null;
        }
    }
    if let Some(sid) = result.session_id.clone() {
        j2["session_id"] = json!(sid);
    }
    let _ = write_job(home, id, &j2);

    rec.status(&result.status);
    result
}

/// 책 제목 캐시: 도구 결과 글에서 [book_id=…]《제목》 을 배워 step_text 가 쓴다.
fn learn_titles(text: &str, titles: &mut HashMap<String, String>) {
    find_book_ids(text, titles);
}

/// read_pages 결과 첫 줄 `《제목》 (폴더, 전체 N쪽)` 을 직전 book_id 와 짝지어 배운다.
pub(crate) fn learn_read_pages_title(text: &str, book_id: &str, titles: &mut HashMap<String, String>) {
    if book_id.is_empty() {
        return;
    }
    let first = text.lines().next().unwrap_or("").trim();
    if let Some(rest) = first.strip_prefix('《') {
        if let Some(end) = rest.find('》') {
            let title = &rest[..end];
            if !title.is_empty() && title.chars().count() <= 60 && !titles.contains_key(book_id) {
                titles.insert(book_id.to_string(), title.to_string());
            }
        }
    }
}

fn find_book_ids(text: &str, titles: &mut HashMap<String, String>) {
    // `book_id=<id>` 뒤에 《제목》 이 오는 꼴을 찾는다.
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        // "book_id=" 를 찾는다
        let mut matched = true;
        for (k, c) in "book_id=".chars().enumerate() {
            if chars.get(i + k) != Some(&c) {
                matched = false;
                break;
            }
        }
        if !matched {
            i += 1;
            continue;
        }
        let mut j = i + "book_id=".len();
        while j < chars.len() && chars[j].is_ascii_alphanumeric() {
            j += 1;
        }
        if j == i + "book_id=".len() {
            i += 1;
            continue;
        }
        let id: String = chars[i + "book_id=".len()..j].iter().collect();
        // 뒤에서 《제목》 찾기
        let mut title = String::new();
        let mut k = j;
        while k < chars.len() {
            if chars[k] == '《' {
                let mut t = k + 1;
                let mut buf = String::new();
                while t < chars.len() && chars[t] != '》' {
                    buf.push(chars[t]);
                    t += 1;
                }
                if t < chars.len() && !buf.trim().is_empty() && buf.chars().count() <= 60 {
                    title = buf;
                }
                break;
            }
            if k - j > 80 {
                break; // 너무 멀면 포기
            }
            k += 1;
        }
        if !title.is_empty() {
            titles.insert(id.clone(), title);
        }
        i = j;
    }
}

/// 인자를 문자열로 읽는 도우미. 값이 숫자든 문자열이든 안전하게 읽는다.
fn arg_str(args: &serde_json::Map<String, Value>, key: &str) -> String {
    match args.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(v) => v.as_str().map(|s| s.to_string()).unwrap_or_default(),
        None => String::new(),
    }
}

/// 인자를 정수로 읽는 도우미. 문자열 "23" 도 숫자로 읽는다.
fn arg_i64(args: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    match args.get(key) {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

/// step_text 이식(책 제목 캐시를 받아 쓴다).
fn step_text(name: &str, args: &Value, titles: &HashMap<String, String>) -> String {
    let name = name.split("__").last().unwrap_or(name);
    let a = args.as_object().cloned().unwrap_or_default();
    let g = |k: &str| arg_str(&a, k);
    let title_of = |bid: &str| -> String {
        titles.get(bid).cloned().unwrap_or_else(|| format!("책 {}", bid.chars().take(6).collect::<String>()))
    };
    match name {
        "find_by_passage" => format!("본문 자료 찾기: {}", g("passage")),
        "commentary_on_verse" => {
            let v = arg_i64(&a, "verse");
            let kw = g("keyword");
            let chapter = g("chapter");
            let mut s = format!("주석에서 절 찾기: {} {}", g("book"), chapter);
            match v {
                Some(0) | None => s.push_str("장"),
                Some(v) => s.push_str(&format!(":{v}")),
            }
            if !kw.is_empty() {
                s.push_str(&format!(" ({kw})"));
            }
            s
        }
        "read_pages" => {
            let n = arg_i64(&a, "count").unwrap_or(2);
            let p = arg_i64(&a, "page").unwrap_or(1);
            let bid = g("book_id");
            let s = format!("읽는 중: 《{}》 {p}쪽", title_of(&bid));
            if n > 1 {
                format!("{s}~{}쪽", p + n - 1)
            } else {
                s
            }
        }
        "view_original_page" => format!("원본 그림 보기: 《{}》 {}쪽", title_of(&g("book_id")), g("page")),
        "search_library" => format!("서재 검색: {}", {
            let x = g("query");
            if x.is_empty() { g("q") } else { x }
        }),
        "find_by_topic" => {
            let mut s = format!("주제 자료 찾기: {}", g("topic"));
            let bb = g("bible_book");
            if !bb.is_empty() {
                s.push_str(&format!(" ({bb})"));
            }
            s
        }
        "find_for_service" => {
            let mut parts = Vec::new();
            for k in ["service", "season", "topic"] {
                let v = g(k);
                if !v.is_empty() {
                    parts.push(v);
                }
            }
            format!("예배·절기 자료 찾기: {}", parts.join(" "))
        }
        "research_bundle" => format!("자료 꾸러미 만들기: {} {}", g("passage"), g("theme")),
        "find_books" => format!("책 찾기: {}", {
            let t = g("title");
            if t.is_empty() { g("folder") } else { t }
        }),
        "list_topics" => "주제 분류표 보기".to_string(),
        "search_in_book" => format!("책 안에서 찾기: 《{}》 \"{}\"", title_of(&g("book_id")), g("query")),
        "book_toc" => format!("목차 보기: 《{}》", title_of(&g("book_id"))),
        _ => name.to_string(),
    }
}

// ---- 엔진별 실행 ----

/// API 엔진의 로컬 단계 한도(설계서: quick 14 / normal 24 / deep 36).
/// prompts.max_steps 는 서버가 depth 에서 주므로 30/55/90 으로 역추적한다.
fn depth_limit(prompts: &study::prompt::Prompts) -> u32 {
    match prompts.max_steps {
        0..=30 => 14,
        31..=55 => 24,
        _ => 36,
    }
}

fn run_engine(
    home: &Home,
    cli: &dyn CliRunner,
    engine: &str,
    model: &str,
    prompts: &study::prompt::Prompts,
    mcp_url: &str,
    resume: Option<&str>,
    rec: &mut Recorder,
    cancel: &AtomicBool,
) -> RunOut {
    match engine {
        "claude" | "codex" => {
            let req = CliReq {
                system: prompts.system.clone(),
                user: prompts.user.clone(),
                model: model.to_string(),
                mcp_url: mcp_url.to_string(),
                max_turns: prompts.max_steps,
                work_dir: study::study_dir(home),
                resume: resume.map(|s| s.to_string()),
            };
            let mut on = |step: Step, tool: Option<(String, Value)>| {
                if let Some((name, args)) = tool {
                    rec.tool(&name, &args, step.call_id.clone());
                    return;
                }
                if step.kind == "tool_result" {
                    rec.tool_result(step.call_id.clone(), &step.text);
                    return;
                }
                rec.info(&step.kind, &step.text);
            };
            cli.run(engine, &req, &mut on, cancel)
        }
        _ => run_api(home, engine, model, prompts, mcp_url, rec, cancel),
    }
}

/// API(run_byok 이식): 도구 호출 루프.
fn run_api(
    home: &Home,
    engine_id: &str,
    model: &str,
    prompts: &study::prompt::Prompts,
    mcp_url: &str,
    rec: &mut Recorder,
    cancel: &AtomicBool,
) -> RunOut {
    let mut engine = study::llm::engine_by_id(engine_id).unwrap_or_else(|| {
        if engine_id == "custom" {
            let url = study::settings::load(home).custom_url.clone();
            study::llm::custom_engine(&url)
        } else {
            study::llm::custom_engine("")
        }
    });
    // custom 엔진은 주소를 settings 에서 읽어 채운다.
    if engine_id == "custom" && engine.url.is_empty() {
        engine.url = study::settings::load(home).custom_url.clone();
    }
    // env 주소 치환
    let url = study::llm::url_for(&engine);

    let key = match study::keys::load(home, engine_id) {
        Some(k) => k,
        None => {
            let name = crate::study::engine_name(engine_id);
            let err = format!("{name} API 키를 넣어 주세요");
            rec.info("error", &err);
            return RunOut { status: "error".into(), error: err, engine: engine_id.to_string(), model: model.to_string(), ..Default::default() };
        }
    };

    // 도구 목록(view_original_page 제외)
    let tools: Vec<Value> = match crate::mcp::tools_list(mcp_url) {
        Ok(list) => list
            .into_iter()
            .filter(|t| t.get("name").and_then(|n| n.as_str()) != Some("view_original_page"))
            .map(|t| json!({"type": "function", "function": {
                "name": t.get("name").cloned().unwrap_or(Value::Null),
                "description": t.get("description").and_then(|d| d.as_str()).unwrap_or("").chars().take(1000).collect::<String>(),
                "parameters": t.get("inputSchema").cloned().unwrap_or_else(|| json!({"type":"object","properties":{}})),
            }}))
            .collect(),
        Err(e) => {
            let msg = e.to_string();
            rec.info("error", &msg);
            return RunOut { status: "error".into(), error: msg, engine: engine_id.to_string(), model: model.to_string(), ..Default::default() };
        }
    };

    let mut msgs = vec![
        json!({"role": "system", "content": prompts.system}),
        json!({"role": "user", "content": prompts.user}),
    ];

    let step_limit: u32 = depth_limit(&prompts);

    let mut usage_in = 0i64;
    let mut usage_out = 0i64;
    let mut final_text = String::new();
    let mut last_err = String::new();

    for step in 0..=step_limit {
        if cancel.load(Ordering::SeqCst) {
            return RunOut { status: "stopped".into(), engine: engine_id.to_string(), model: model.to_string(), ..Default::default() };
        }
        let closing = step == step_limit;
        let tools_ref: Option<&[Value]> = if closing { None } else { Some(&tools) };
        if closing {
            msgs.push(json!({"role": "user", "content": "도구 사용은 여기까지. 지금까지 읽은 자료로 보고서를 완성해 줘(버튼 블록 포함)."}));
        }
        let out = match study::llm::chat_raw(&url, &key, model, &msgs, tools_ref, 300) {
            Ok(o) => o,
            Err(e) => {
                last_err = e;
                break;
            }
        };
        if let Some(u) = out.usage.get("prompt_tokens").and_then(|v| v.as_i64()) {
            usage_in += u;
        }
        if let Some(u) = out.usage.get("completion_tokens").and_then(|v| v.as_i64()) {
            usage_out += u;
        }
        let msg = out.message;
        let content = study::llm::message_text(&msg);
        let calls = msg.get("tool_calls").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        if calls.is_empty() {
            final_text = content;
            break;
        }
        // assistant 메시지를 그대로 되돌린다(role·content·tool_calls·reasoning_content).
        msgs.push(msg.clone());
        if !content.trim().is_empty() && content.len() < 400 {
            rec.info("think", content.trim());
        }
        for c in &calls {
            if cancel.load(Ordering::SeqCst) {
                return RunOut { status: "stopped".into(), engine: engine_id.to_string(), model: model.to_string(), ..Default::default() };
            }
            let fn_ = c.get("function").cloned().unwrap_or(Value::Null);
            let name = fn_.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args: Value = fn_.get("arguments").and_then(|a| a.as_str()).and_then(|s| serde_json::from_str(s).ok()).unwrap_or(json!({}));
            let call_id = c.get("id").and_then(|i| i.as_str()).map(|s| s.to_string());
            // 호출 순간 단계를 적고(제목은 아직 모르므로 아이디 조각), 결과가 오면 고쳐 쓴다.
            rec.tool(name, &args, call_id.clone());
            let text = match crate::mcp::tools_call(mcp_url, name, &args) {
                Ok(r) => r.text,
                Err(e) => format!("도구 오류: {e}"),
            };
            rec.tool_result(call_id, &text);
            let tid = c.get("id").and_then(|i| i.as_str()).unwrap_or(name).to_string();
            let text = text.chars().take(15000).collect::<String>();
            msgs.push(json!({"role": "tool", "tool_call_id": tid, "content": text}));
        }
    }

    if !last_err.is_empty() {
        rec.info("error", &last_err);
        return RunOut { status: "error".into(), error: last_err, engine: engine_id.to_string(), model: model.to_string(), ..Default::default() };
    }
    if final_text.trim().is_empty() {
        let err = "AI가 보고서를 끝내지 못했습니다. 다른 모델로 다시 해 보세요.".to_string();
        rec.info("error", &err);
        return RunOut { status: "error".into(), error: err, engine: engine_id.to_string(), model: model.to_string(), ..Default::default() };
    }
    rec.info("write", "보고서 쓰는 중…");
    // 보고서 링크가 서재 주소로 시작하면 앱 안 링크(#/…)로 바꾼다. 주소가 없으면 그대로 둔다.
    let wb = crate::web::base(home);
    let md = if wb.is_empty() { final_text.trim().to_string() } else { final_text.trim().replace(&format!("{wb}/#/"), "#/") };
    RunOut {
        status: "done".into(),
        md,
        engine: engine_id.to_string(),
        model: model.to_string(),
        tokens: json!({"input_tokens": usage_in, "output_tokens": usage_out}),
        ..Default::default()
    }
}

/// 실행기 진입점(가장 오래된 queued 하나 실행). 실행했으면 true.
pub fn run_next(home: &Home, cli: &dyn CliRunner, on: &mut dyn FnMut(&Event)) -> bool {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return false;
    }
    let picked = next_queued(home);
    let ran = match picked {
        Some((id, ti)) => {
            run_turn(home, cli, &id, ti, on);
            true
        }
        None => false,
    };
    RUNNING.store(false, Ordering::SeqCst);
    ran
}

/// 지정한 연구(id)의 다음 queued turn 만 실행한다(명령줄용). 실행했으면 true.
pub fn run_job(home: &Home, cli: &dyn CliRunner, id: &str, on: &mut dyn FnMut(&Event)) -> bool {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return false;
    }
    let picked = next_queued_of(home, id);
    let ran = match picked {
        Some(ti) => {
            run_turn(home, cli, id, ti, on);
            true
        }
        None => false,
    };
    RUNNING.store(false, Ordering::SeqCst);
    ran
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_shape() {
        let id = new_id();
        assert!(id.starts_with("app-"));
        assert_eq!(id.len(), "app-YYYYMMDD-HHMMSS-xxxx".len());
        // 날짜(YYYYMMDD)와 시각(HHMMSS) 숫자, 사이 하이픈
        assert!(id[4..12].chars().all(|c| c.is_ascii_digit()));
        assert_eq!(&id[12..13], "-");
        assert!(id[13..19].chars().all(|c| c.is_ascii_digit()));
        assert_eq!(&id[19..20], "-");
        let tail = &id[id.len() - 4..];
        assert!(tail.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn step_text_refs() {
        let mut titles = HashMap::new();
        titles.insert("abc123456789".to_string(), "매튜헨리 주석".to_string());
        assert_eq!(step_text("read_pages", &json!({"book_id": "abc123456789", "page": 23, "count": 2}), &titles), "읽는 중: 《매튜헨리 주석》 23쪽~24쪽");
        assert_eq!(step_text("find_by_passage", &json!({"passage": "막 2:18"}), &titles), "본문 자료 찾기: 막 2:18");
        // 미지 book_id 는 앞 6자리
        let empty = HashMap::new();
        assert_eq!(step_text("read_pages", &json!({"book_id": "xyzabcdef", "page": 1, "count": 1}), &empty), "읽는 중: 《책 xyzabc》 1쪽");
    }

    #[test]
    fn book_scan() {
        let mut titles = HashMap::new();
        find_book_ids("결과 [book_id=abc123 p.5] 《매튜헨리》 보다", &mut titles);
        assert_eq!(titles.get("abc123").map(|s| s.as_str()), Some("매튜헨리"));
    }
}
