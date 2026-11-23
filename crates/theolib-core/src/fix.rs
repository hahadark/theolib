//! 주석 글 AI 보정.
//!
//! 스캔한 책을 글자 인식한 주석에는 문장 중간의 줄바꿈, 문단 없이 이어진 긴 글, 잘못 읽힌 글자가 남아 있다.
//! 이 모듈은 고른 풀이를 조각내어 AI 에게 보내고, 돌아온 글이 원문에서 벗어나지 않았는지 기계로 다시 따진 뒤
//! `<root>/notefix.db` 에 따로 적어 둔다. 받은 자료(comm-*.db)는 고치지 않는다. 그래서 자료를 다시 받아도
//! 보정본이 남고, 원문이 바뀌면(해시가 달라지면) 보정본은 쓰이지 않는다.
use crate::Home;
use crate::reader::Reader;
use crate::study::{keys, llm};
use crate::studycli;
use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// 한 조각 글자 수 한도. 이보다 긴 풀이는 문단·문장 끝에서 나눈다.
pub const SEG_MAX: usize = 2400;
/// 한 번 요청에 담는 글자 수와 조각 수.
pub const BATCH_MAX: usize = 6000;
pub const BATCH_PIECES: usize = 12;
/// 바뀐 글자 비율이 이보다 크면 사람이 보고 적용한다.
pub const REVIEW_AT: f64 = 0.06;
/// 이보다 크면 받아들이지 않는다(원문 유지).
pub const REJECT_AT: f64 = 0.25;
/// 요청 하나의 시간 제한(초).
const ASK_TIMEOUT_S: u64 = 600;

pub const SYSTEM: &str = r#"당신은 한국어 신학 서적(성경 주석)을 스캔해서 글자 인식(OCR)한 글을 바로잡는 교정자입니다. 내용은 그대로 두고 아래 일만 합니다.

고치는 것
1. 줄바꿈: 문장 중간에서 끊긴 줄은 이어 붙입니다. 낱말이 줄 끝에서 잘렸으면 붙여 씁니다(예: "위해\n서일 수도" → "위해서일 수도"). 문단은 줄바꿈 한 번으로 나누고 빈 줄은 넣지 않습니다. 문단 없이 길게 이어진 글은 화제가 바뀌는 자리에서 문단을 나눕니다(한 문단은 대략 3~6문장).
2. 표제어: 성경 본문의 낱말이나 구절을 표제어로 삼아 "표제어. 풀이" 꼴로 여러 개를 이어 쓴 글은 표제어마다 새 줄에서 시작합니다.
3. 띄어쓰기와 문장부호: 잘못 붙거나 떨어진 띄어쓰기, 짝이 맞지 않는 따옴표와 괄호, 글자 인식 때문에 뒤바뀐 쉼표와 마침표.
4. 글자 인식 오류: 앞뒤 문맥으로 원래 글자가 분명한 것만 고칩니다(예: "세계 요한" → "세례 요한").

고치지 않는 것
- 낱말, 표현, 문체, 어순을 다듬거나 바꾸지 않습니다. 옛 맞춤법과 성경 인용문은 원문 그대로 둡니다.
- 문장을 더하거나 빼거나 줄이지 않습니다. 설명, 머리말, 맺음말을 붙이지 않습니다.
- 숫자와 장절 표기(3:16, 16-17절)는 바꾸지 않습니다. 틀린 것 같아도 그대로 둡니다.
- 사람 이름, 책 이름, 원어 음역(엘로힘, 베레쉬트), 로마자·헬라어·히브리어 글자는 확실하지 않으면 그대로 둡니다. 깨진 원어를 추측해서 새로 써 넣지 않습니다.
- 알아볼 수 없이 깨진 부분은 채우지 말고 그대로 둡니다.
- 표나 목록처럼 줄마다 따로 적힌 것은 줄을 합치지 않습니다.
- 마크다운 기호(#, *, -)나 번호를 새로 넣지 않습니다.

형식
입력은 `<<<번호>>>` 줄로 시작하는 조각들입니다. 답에도 같은 번호 줄을 그대로 쓰고 그 아래에 고친 글을 씁니다. 조각의 수와 번호는 그대로 둡니다(조각끼리 합치거나 빼지 않습니다). 조각 안에서는 위 1번과 2번대로 끊긴 줄을 붙이고, 문단과 표제어마다 줄을 바꿉니다. 조각이 문장 중간에서 시작하거나 끝나도 그대로 둡니다(앞뒤 조각과 이어지는 글입니다). 고칠 곳이 없는 조각은 원문 그대로 씁니다. 그 밖의 말은 쓰지 않습니다."#;

// ---------------------------------------------------------------------------
// 보정본 보관
// ---------------------------------------------------------------------------

pub fn db_path(home: &Home) -> PathBuf {
    home.root.join("notefix.db")
}

pub fn open(home: &Home) -> Result<Connection> {
    std::fs::create_dir_all(&home.root)?;
    let c = Connection::open(db_path(home))?;
    c.busy_timeout(Duration::from_secs(5))?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS fix(
           series TEXT NOT NULL, bk INTEGER NOT NULL, seq INTEGER NOT NULL,
           orig_hash TEXT NOT NULL, text TEXT NOT NULL,
           state TEXT NOT NULL DEFAULT 'pending',
           flags TEXT NOT NULL DEFAULT '', change REAL NOT NULL DEFAULT 0,
           engine TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
           created TEXT NOT NULL DEFAULT '',
           PRIMARY KEY(series,bk,seq));",
    )?;
    Ok(c)
}

/// 원문 지문(바뀌었는지 알아보는 데만 쓴다).
pub fn hash(t: &str) -> String {
    crate::source::hex(&Sha256::digest(t.as_bytes())[..8])
}

/// 그 책에서 켜져 있는 보정본: (시리즈, 차례) → (원문 지문, 고친 글).
pub fn applied(home: &Home, bk: i64) -> HashMap<(String, i64), (String, String)> {
    let mut m = HashMap::new();
    if !db_path(home).exists() {
        return m;
    }
    let Ok(c) = open(home) else { return m };
    let Ok(mut s) = c.prepare("SELECT series,seq,orig_hash,text FROM fix WHERE bk=? AND state='on'") else { return m };
    if let Ok(rows) = s.query_map([bk], |r| Ok(((r.get::<_, String>(0)?, r.get::<_, i64>(1)?), (r.get::<_, String>(2)?, r.get::<_, String>(3)?)))) {
        for x in rows.flatten() {
            m.insert(x.0, x.1);
        }
    }
    m
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct FixRow {
    pub orig_hash: String,
    pub text: String,
    /// on(보여 주는 중) | pending(확인 기다림)
    pub state: String,
    pub flags: String,
    pub change: f64,
    pub engine: String,
    pub model: String,
    pub created: String,
}

fn rows(home: &Home, series: &str, bk: i64) -> HashMap<i64, FixRow> {
    let mut m = HashMap::new();
    if !db_path(home).exists() {
        return m;
    }
    let Ok(c) = open(home) else { return m };
    let Ok(mut s) = c.prepare("SELECT seq,orig_hash,text,state,flags,change,engine,model,created FROM fix WHERE series=? AND bk=?") else { return m };
    if let Ok(r) = s.query_map((series, bk), |r| {
        Ok((r.get::<_, i64>(0)?, FixRow { orig_hash: r.get(1)?, text: r.get(2)?, state: r.get(3)?, flags: r.get(4)?, change: r.get(5)?, engine: r.get(6)?, model: r.get(7)?, created: r.get(8)? }))
    }) {
        for x in r.flatten() {
            m.insert(x.0, x.1);
        }
    }
    m
}

/// 보정할 수 있는 풀이 한 개(목록용, 글은 싣지 않는다).
#[derive(Serialize, Clone, Debug)]
pub struct Target {
    pub id: i64,
    pub series: String,
    pub series_name: String,
    pub bk: i64,
    pub seq: i64,
    pub r#ref: String,
    pub title: String,
    pub start_key: i64,
    pub end_key: i64,
    pub chars: usize,
    /// "" | on | pending | stale(원문이 바뀌어 쓰이지 않는 보정본)
    pub fix: String,
    pub flags: String,
    pub change: f64,
    pub model: String,
}

/// 범위(lo..hi, 장*1000+절)에 걸린 한 시리즈의 풀이 목록. 1장을 포함하면 서론도 함께 나온다.
pub fn targets(home: &Home, series: &str, bk: i64, lo: i64, hi: i64) -> Result<Vec<Target>> {
    let r = Reader::open(home)?;
    let fx = rows(home, series, bk);
    Ok(r.comm_raw(series, bk, lo, hi, lo < 2000)?
        .into_iter()
        .map(|n| {
            let f = fx.get(&n.seq);
            let fix = match f {
                Some(f) if f.orig_hash != hash(&n.text) => "stale".to_string(),
                Some(f) => f.state.clone(),
                None => String::new(),
            };
            Target {
                id: n.id,
                series: n.series,
                series_name: n.series_name,
                bk,
                seq: n.seq,
                r#ref: n.r#ref,
                title: n.title,
                start_key: n.start_key,
                end_key: n.end_key,
                chars: n.text.chars().count(),
                fix,
                flags: f.map(|f| f.flags.clone()).unwrap_or_default(),
                change: f.map(|f| f.change).unwrap_or(0.0),
                model: f.map(|f| f.model.clone()).unwrap_or_default(),
            }
        })
        .collect())
}

/// 원문과 보정본 한 쌍(견주어 보기용).
#[derive(Serialize, Clone, Debug)]
pub struct Pair {
    pub r#ref: String,
    pub title: String,
    pub orig: String,
    pub fix: Option<FixRow>,
    pub stale: bool,
}

pub fn pair(home: &Home, series: &str, bk: i64, seq: i64) -> Result<Option<Pair>> {
    let r = Reader::open(home)?;
    let Some(n) = r.comm_raw(series, bk, 0, i64::MAX, true)?.into_iter().find(|n| n.seq == seq) else { return Ok(None) };
    let f = rows(home, series, bk).remove(&seq);
    let stale = f.as_ref().is_some_and(|f| f.orig_hash != hash(&n.text));
    Ok(Some(Pair { r#ref: n.r#ref, title: n.title, orig: n.text, fix: f, stale }))
}

/// 확인을 기다리는 보정본을 켠다. 켠 개수를 돌려준다.
pub fn approve(home: &Home, series: &str, bk: i64, seqs: &[i64]) -> Result<usize> {
    let c = open(home)?;
    let mut n = 0;
    for s in seqs {
        n += c.execute("UPDATE fix SET state='on' WHERE series=? AND bk=? AND seq=?", (series, bk, s))?;
    }
    Ok(n)
}

/// 보정본을 지워 원문으로 되돌린다. 지운 개수를 돌려준다.
pub fn discard(home: &Home, series: &str, bk: i64, seqs: &[i64]) -> Result<usize> {
    let c = open(home)?;
    let mut n = 0;
    for s in seqs {
        n += c.execute("DELETE FROM fix WHERE series=? AND bk=? AND seq=?", (series, bk, s))?;
    }
    Ok(n)
}

// ---------------------------------------------------------------------------
// 조각 나누기
// ---------------------------------------------------------------------------

/// 풀이를 나눈 조각. `glue` 는 다음 조각과 다시 이을 때 사이에 넣는 글자.
#[derive(Clone, Debug, PartialEq)]
pub struct Seg {
    pub text: String,
    pub glue: &'static str,
}

/// 한 줄이 한도보다 길 때 문장 끝(없으면 띄어쓰기, 그것도 없으면 글자 수)에서 나눈다.
fn split_long(line: &str, max: usize) -> Vec<(String, &'static str)> {
    let ch: Vec<char> = line.chars().collect();
    let mut out = vec![];
    let mut pos = 0;
    while ch.len() - pos > max {
        let end = pos + max;
        let floor = pos + max / 2;
        // 문장 끝: 마침표류(뒤에 닫는 따옴표·괄호가 붙을 수 있다) 다음이 빈칸인 자리
        let mut cut: Option<usize> = None;
        let mut i = end;
        while i > floor {
            if ch[i] == ' ' {
                let mut j = i - 1;
                while j > floor && matches!(ch[j], '"' | '\'' | '”' | '’' | ')' | '」' | '』') {
                    j -= 1;
                }
                if matches!(ch[j], '.' | '!' | '?' | '。') {
                    cut = Some(i);
                    break;
                }
            }
            i -= 1;
        }
        if cut.is_none() {
            cut = (floor + 1..=end).rev().find(|&i| ch[i] == ' ');
        }
        match cut {
            Some(i) => {
                out.push((ch[pos..i].iter().collect(), " "));
                pos = i + 1;
            }
            None => {
                out.push((ch[pos..end].iter().collect(), ""));
                pos = end;
            }
        }
    }
    out.push((ch[pos..].iter().collect(), ""));
    out
}

/// 풀이를 한도 안쪽의 조각들로 나눈다. 줄 사이에서 먼저 나누고, 한 줄이 너무 길면 문장 끝에서 나눈다.
/// `조각 글 + glue` 를 차례로 이으면 원문(줄바꿈을 \n 으로 맞춘 것)과 같다.
pub fn segments(text: &str, max: usize) -> Vec<Seg> {
    let t = text.replace("\r\n", "\n");
    let mut out: Vec<Seg> = vec![];
    let (mut cur, mut cur_n, mut lines) = (String::new(), 0usize, 0usize);
    for line in t.split('\n') {
        let n = line.chars().count();
        if n > max {
            if lines > 0 {
                out.push(Seg { text: std::mem::take(&mut cur), glue: "\n" });
                (cur_n, lines) = (0, 0);
            }
            let parts = split_long(line, max);
            let last = parts.len() - 1;
            for (i, (p, g)) in parts.into_iter().enumerate() {
                out.push(Seg { text: p, glue: if i == last { "\n" } else { g } });
            }
            continue;
        }
        if lines > 0 && cur_n + 1 + n > max {
            out.push(Seg { text: std::mem::take(&mut cur), glue: "\n" });
            (cur_n, lines) = (0, 0);
        }
        if lines > 0 {
            cur.push('\n');
            cur_n += 1;
        }
        cur.push_str(line);
        cur_n += n;
        lines += 1;
    }
    if lines > 0 {
        out.push(Seg { text: cur, glue: "" });
    }
    if let Some(l) = out.last_mut() {
        l.glue = "";
    }
    out
}

// ---------------------------------------------------------------------------
// 요청 글과 답 읽기
// ---------------------------------------------------------------------------

/// 조각들을 번호 줄과 함께 한 요청 글로 묶는다.
pub fn build_user(pieces: &[&str]) -> String {
    let mut s = format!("아래 조각 {}개를 바로잡아 주세요.\n", pieces.len());
    for (i, p) in pieces.iter().enumerate() {
        s.push_str(&format!("\n<<<{}>>>\n{}\n", i + 1, p.trim_matches('\n')));
    }
    s
}

fn marker(line: &str) -> Option<usize> {
    let t = line.trim();
    let inner = t.strip_prefix("<<<")?.strip_suffix(">>>")?.trim();
    if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    inner.parse().ok()
}

fn tidy(lines: &[&str]) -> String {
    let mut v: Vec<&str> = lines.iter().map(|l| l.trim_end()).collect();
    while v.first().is_some_and(|l| l.trim().is_empty() || l.trim().starts_with("```")) {
        v.remove(0);
    }
    while v.last().is_some_and(|l| l.trim().is_empty() || l.trim().starts_with("```")) {
        v.pop();
    }
    v.join("\n")
}

/// 답에서 번호별 조각을 꺼낸다. 번호 줄이 없고 조각이 하나뿐이면 답 전체를 그 조각으로 본다.
pub fn parse_reply(reply: &str, n: usize) -> Vec<Option<String>> {
    let reply = reply.replace("\r\n", "\n");
    let mut out: Vec<Option<String>> = vec![None; n];
    let mut cur: Option<usize> = None;
    let mut buf: Vec<&str> = vec![];
    let mut seen = false;
    for line in reply.split('\n') {
        if let Some(k) = marker(line) {
            if let Some(c) = cur {
                if c >= 1 && c <= n && out[c - 1].is_none() {
                    out[c - 1] = Some(tidy(&buf));
                }
            }
            cur = Some(k);
            seen = true;
            buf.clear();
        } else if cur.is_some() {
            buf.push(line);
        }
    }
    if let Some(c) = cur {
        if c >= 1 && c <= n && out[c - 1].is_none() {
            out[c - 1] = Some(tidy(&buf));
        }
    }
    if !seen && n == 1 {
        let all: Vec<&str> = reply.split('\n').collect();
        out[0] = Some(tidy(&all));
    }
    for o in out.iter_mut() {
        if o.as_ref().is_some_and(|s| s.trim().is_empty()) {
            *o = None;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 돌아온 글 따져 보기
// ---------------------------------------------------------------------------

/// 가장 긴 공통 부분열 길이(앞뒤 같은 부분은 먼저 떼어 낸다).
fn lcs(a: &[char], b: &[char]) -> usize {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let (a, b) = (&a[pre..], &b[pre..]);
    let mut suf = 0;
    while suf < a.len() && suf < b.len() && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let (a, b) = (&a[..a.len() - suf], &b[..b.len() - suf]);
    if a.is_empty() || b.is_empty() {
        return pre + suf;
    }
    let mut prev = vec![0u32; b.len() + 1];
    let mut cur = vec![0u32; b.len() + 1];
    for x in a {
        for (j, y) in b.iter().enumerate() {
            cur[j + 1] = if x == y { prev[j] + 1 } else { prev[j + 1].max(cur[j]) };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    pre + suf + prev[b.len()] as usize
}

fn digits(t: &str) -> String {
    t.chars().filter(|c| c.is_ascii_digit() || ('①'..='⑳').contains(c)).collect()
}

/// 헬라어·히브리어 글자 수(새로 써 넣은 원어를 알아보는 데 쓴다).
fn foreign(t: &str) -> usize {
    t.chars().filter(|c| matches!(*c as u32, 0x0370..=0x03FF | 0x1F00..=0x1FFF | 0x0590..=0x05FF)).count()
}

fn markdown(t: &str) -> usize {
    t.matches("**").count() + t.lines().filter(|l| l.trim_start().starts_with("# ") || l.trim_start().starts_with("## ")).count()
}

/// 고친 글 한 조각의 판정.
#[derive(Clone, Debug, Default)]
pub struct Check {
    /// 빈칸을 뺀 글자 가운데 바뀐 비율(0~1)
    pub change: f64,
    /// num(숫자 달라짐) big(많이 바뀜) script(원어 글자 늘어남) md(마크다운 기호)
    pub flags: Vec<&'static str>,
    /// 받아들이지 않는 까닭
    pub reject: Option<&'static str>,
}

pub fn check(orig: &str, fixed: &str) -> Check {
    let a: Vec<char> = orig.chars().filter(|c| !c.is_whitespace()).collect();
    let b: Vec<char> = fixed.chars().filter(|c| !c.is_whitespace()).collect();
    let mut k = Check::default();
    if b.is_empty() {
        k.reject = Some("빈 답");
        return k;
    }
    let (la, lb) = (a.len() as f64, b.len() as f64);
    if lb < la * 0.9 - 8.0 || lb > la * 1.1 + 8.0 {
        k.change = (la - lb).abs() / la.max(lb);
        k.reject = Some(if lb < la { "글이 줄었음" } else { "글이 늘었음" });
        return k;
    }
    k.change = 1.0 - lcs(&a, &b) as f64 / la.max(lb).max(1.0);
    if k.change > REJECT_AT {
        k.reject = Some("원문과 많이 달라짐");
        return k;
    }
    if digits(orig) != digits(fixed) {
        k.flags.push("num");
    }
    if k.change > REVIEW_AT {
        k.flags.push("big");
    }
    if foreign(fixed) > foreign(orig) {
        k.flags.push("script");
    }
    if markdown(fixed) > markdown(orig) {
        k.flags.push("md");
    }
    k
}

// ---------------------------------------------------------------------------
// AI 부르기
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct Reply {
    pub text: String,
    pub tok_in: u64,
    pub tok_out: u64,
    pub cost: Option<f64>,
}

/// 글을 주고 답을 받는 AI. 시험에서는 가짜를 끼운다.
pub trait Ai: Send + Sync {
    fn ask(&self, system: &str, user: &str, cancel: &AtomicBool) -> std::result::Result<Reply, String>;
}

struct ApiAi {
    url: String,
    key: String,
    model: String,
    /// 딥시크 생각 모드를 켤지(`모델@think`). 기본은 끈다.
    think: bool,
}

impl Ai for ApiAi {
    fn ask(&self, system: &str, user: &str, _cancel: &AtomicBool) -> std::result::Result<Reply, String> {
        let mut body = json!({"model": self.model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]});
        if self.url.contains("deepseek.com") {
            body["max_tokens"] = json!(if self.think { 32000 } else { 16000 });
            if !self.think {
                // 교정은 그대로 옮겨 쓰는 일이라 기본은 생각 모드를 끄고 온도를 낮춘다.
                body["temperature"] = json!(0);
                body["thinking"] = json!({"type": "disabled"});
            }
        }
        let out = llm::chat_body(&self.url, &self.key, &body, ASK_TIMEOUT_S)?;
        let u = &out.usage;
        Ok(Reply {
            text: llm::message_text(&out.message),
            tok_in: u.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
            tok_out: u.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
            cost: None,
        })
    }
}

struct CliAi {
    info: studycli::CliInfo,
    model: String,
    effort: String,
}

impl Ai for CliAi {
    fn ask(&self, system: &str, user: &str, cancel: &AtomicBool) -> std::result::Result<Reply, String> {
        let prompt = format!("{system}\n\n{user}");
        let o = studycli::one_shot(&self.info, &self.model, &self.effort, &prompt, ASK_TIMEOUT_S, cancel)?;
        Ok(Reply { text: o.text, tok_in: o.tok_in, tok_out: o.tok_out, cost: o.cost })
    }
}

/// 엔진 id 와 모델로 AI 를 만든다. 구독 CLI 는 `모델@강도` 로 추론 강도를 붙일 수 있다(예: gpt-6-luna@low).
pub fn make_ai(home: &Home, engine: &str, model: &str) -> std::result::Result<Box<dyn Ai>, String> {
    match engine {
        "claude" | "codex" => {
            let info = studycli::detect(engine);
            if !info.found {
                return Err(format!("이 PC에 {} 명령줄 도구가 설치되어 있지 않습니다. AI 설정에서 확인해 주세요.", if engine == "claude" { "클로드 Code" } else { "Codex" }));
            }
            let (m, effort) = model.split_once('@').unwrap_or((model, "low"));
            let m = if m.trim().is_empty() { if engine == "claude" { "sonnet" } else { "gpt-6-sol" } } else { m.trim() };
            // 교정은 깊이 생각할 일이 아니라서 추론 강도는 낮게 둔다(생각이 길면 몇 배로 느려진다).
            Ok(Box::new(CliAi { info, model: m.to_string(), effort: effort.trim().to_string() }))
        }
        _ => {
            let e = llm::engine_by_id(engine).ok_or_else(|| "이 AI 로는 주석 글을 보정할 수 없습니다.".to_string())?;
            let key = keys::require_key(e.name, keys::load(home, engine).as_deref()).map_err(|x| x.to_string())?;
            let (m, opt) = model.split_once('@').unwrap_or((model, ""));
            Ok(Box::new(ApiAi { url: llm::url_for(&e), key, model: llm::model_ok(&e, m), think: opt.trim() == "think" }))
        }
    }
}

// ---------------------------------------------------------------------------
// 보정 실행
// ---------------------------------------------------------------------------

/// 보정할 풀이 한 개(원문).
#[derive(Clone, Debug)]
pub struct Job {
    pub id: i64,
    pub series: String,
    pub bk: i64,
    pub seq: i64,
    pub text: String,
}

/// 풀이 한 개의 결과.
#[derive(Serialize, Clone, Debug, Default)]
pub struct NoteOut {
    pub id: i64,
    pub series: String,
    pub bk: i64,
    pub seq: i64,
    /// ok(바로 적용) | review(확인 필요) | same(고칠 곳 없음) | fail(원문 유지)
    pub state: String,
    pub change: f64,
    pub flags: String,
    pub error: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Summary {
    pub total: usize,
    pub ok: usize,
    pub review: usize,
    pub same: usize,
    pub fail: usize,
    pub stopped: bool,
    pub error: String,
    pub requests: usize,
    pub tok_in: u64,
    pub tok_out: u64,
    pub cost: f64,
    pub secs: f64,
    pub chars: usize,
}

struct Piece {
    job: usize,
    seg: usize,
    tries: u8,
}

struct SegRes {
    text: String,
    change: f64,
    flags: Vec<&'static str>,
    /// 원문을 그대로 둔 까닭
    kept: Option<String>,
}

struct Shared {
    queue: VecDeque<Vec<Piece>>,
    res: Vec<Vec<Option<SegRes>>>,
    left: Vec<usize>,
    busy: usize,
    done: usize,
    fatal: Option<String>,
    sum: Summary,
}

/// 다시 해도 소용없는 오류(한도·키·로그인·설치)인지.
fn fatal_error(e: &str) -> bool {
    ["한도", "API 키", "로그인", "설치되어", "모델 이름", "멈췄습니다"].iter().any(|k| e.contains(k))
}

fn finish(job: &Job, segs: &[Seg], res: &[Option<SegRes>]) -> (NoteOut, Option<String>) {
    let mut o = NoteOut { id: job.id, series: job.series.clone(), bk: job.bk, seq: job.seq, ..Default::default() };
    let res: Vec<&SegRes> = res.iter().flatten().collect();
    if res.len() != segs.len() || res.iter().all(|r| r.kept.is_some()) {
        o.state = "fail".into();
        o.error = res.iter().find_map(|r| r.kept.clone()).unwrap_or_else(|| "결과가 없습니다".into());
        return (o, None);
    }
    let (mut text, mut w, mut sum) = (String::new(), 0.0, 0.0);
    let mut flags: Vec<&'static str> = vec![];
    for (s, r) in segs.iter().zip(&res) {
        text.push_str(r.text.trim_matches('\n'));
        text.push_str(s.glue);
        let n = s.text.chars().count() as f64;
        w += n;
        sum += r.change * n;
        for f in &r.flags {
            if !flags.contains(f) {
                flags.push(*f);
            }
        }
        if r.kept.is_some() && !flags.contains(&"part") {
            flags.push("part");
        }
    }
    o.change = if w > 0.0 { sum / w } else { 0.0 };
    o.flags = flags.join(",");
    if text.trim() == job.text.replace("\r\n", "\n").trim() {
        o.state = "same".into();
        return (o, None);
    }
    o.state = if flags.is_empty() { "ok" } else { "review" }.into();
    (o, Some(text.trim().to_string()))
}

/// 풀이들을 조각내어 AI 에게 보내고, 풀이 하나가 끝날 때마다 `sink(풀이, 결과, 고친 글)` 을 부른다.
/// 받아들이지 못한 조각은 한 번 더 따로 보내고, 그래도 안 되면 그 조각은 원문을 둔다.
pub fn process(jobs: &[Job], ai: &dyn Ai, workers: usize, sink: &(dyn Fn(&Job, &NoteOut, Option<&str>, usize, usize) + Sync), cancel: &AtomicBool) -> Summary {
    let started = Instant::now();
    let segs: Vec<Vec<Seg>> = jobs.iter().map(|j| segments(&j.text, SEG_MAX)).collect();
    let mut sh = Shared { queue: VecDeque::new(), res: vec![], left: vec![], busy: 0, done: 0, fatal: None, sum: Summary { total: jobs.len(), ..Default::default() } };
    let (mut batch, mut size): (Vec<Piece>, usize) = (vec![], 0);
    for (ji, ss) in segs.iter().enumerate() {
        let mut row: Vec<Option<SegRes>> = vec![];
        let mut left = 0;
        for (si, s) in ss.iter().enumerate() {
            if s.text.trim().is_empty() {
                row.push(Some(SegRes { text: s.text.clone(), change: 0.0, flags: vec![], kept: None }));
                continue;
            }
            row.push(None);
            left += 1;
            let n = s.text.chars().count();
            sh.sum.chars += n;
            if !batch.is_empty() && (size + n > BATCH_MAX || batch.len() >= BATCH_PIECES) {
                sh.queue.push_back(std::mem::take(&mut batch));
                size = 0;
            }
            batch.push(Piece { job: ji, seg: si, tries: 0 });
            size += n;
        }
        sh.res.push(row);
        sh.left.push(left);
    }
    if !batch.is_empty() {
        sh.queue.push_back(batch);
    }
    let sh = Mutex::new(sh);
    // 조각 하나를 채우고, 그 풀이의 조각이 다 찼으면 마무리해서 sink 로 넘긴다.
    let settle = |p: &Piece, r: SegRes| {
        let fin = {
            let mut g = sh.lock().unwrap();
            if g.res[p.job][p.seg].is_some() {
                return;
            }
            g.res[p.job][p.seg] = Some(r);
            g.left[p.job] -= 1;
            if g.left[p.job] > 0 {
                None
            } else {
                let (o, text) = finish(&jobs[p.job], &segs[p.job], &g.res[p.job]);
                match o.state.as_str() {
                    "ok" => g.sum.ok += 1,
                    "review" => g.sum.review += 1,
                    "same" => g.sum.same += 1,
                    _ => g.sum.fail += 1,
                }
                g.done += 1;
                Some((o, text, g.done))
            }
        };
        if let Some((o, text, done)) = fin {
            sink(&jobs[p.job], &o, text.as_deref(), done, jobs.len());
        }
    };
    // 글이 없는 풀이는 바로 끝낸다.
    for (ji, j) in jobs.iter().enumerate() {
        let empty = sh.lock().unwrap().left[ji] == 0;
        if empty {
            let o = NoteOut { id: j.id, series: j.series.clone(), bk: j.bk, seq: j.seq, state: "same".into(), ..Default::default() };
            let done = {
                let mut g = sh.lock().unwrap();
                g.sum.same += 1;
                g.done += 1;
                g.done
            };
            sink(j, &o, None, done, jobs.len());
        }
    }
    let work = || loop {
        let batch = {
            let mut g = sh.lock().unwrap();
            if g.fatal.is_some() || cancel.load(Ordering::Relaxed) {
                break;
            }
            match g.queue.pop_front() {
                Some(b) => {
                    g.busy += 1;
                    Some(b)
                }
                None if g.busy == 0 => break,
                None => None,
            }
        };
        let Some(batch) = batch else {
            std::thread::sleep(Duration::from_millis(120));
            continue;
        };
        let texts: Vec<&str> = batch.iter().map(|p| segs[p.job][p.seg].text.as_str()).collect();
        let got = ai.ask(SYSTEM, &build_user(&texts), cancel);
        let mut again: Vec<Piece> = vec![];
        match got {
            Err(e) => {
                let mut g = sh.lock().unwrap();
                g.sum.requests += 1;
                if fatal_error(&e) {
                    if !e.contains("멈췄습니다") {
                        g.fatal.get_or_insert(e);
                    }
                } else {
                    drop(g);
                    for p in batch {
                        if p.tries == 0 {
                            again.push(Piece { tries: 1, ..p });
                        } else {
                            let orig = segs[p.job][p.seg].text.clone();
                            settle(&p, SegRes { text: orig, change: 0.0, flags: vec![], kept: Some(e.clone()) });
                        }
                    }
                }
            }
            Ok(rep) => {
                {
                    let mut g = sh.lock().unwrap();
                    g.sum.requests += 1;
                    g.sum.tok_in += rep.tok_in;
                    g.sum.tok_out += rep.tok_out;
                    g.sum.cost += rep.cost.unwrap_or(0.0);
                }
                let parts = parse_reply(&rep.text, batch.len());
                for (p, part) in batch.into_iter().zip(parts) {
                    let orig = &segs[p.job][p.seg].text;
                    let (fixed, why) = match part {
                        Some(t) => {
                            let k = check(orig, &t);
                            match k.reject {
                                None => (Some((t, k)), ""),
                                Some(w) => (None, w),
                            }
                        }
                        None => (None, "답에서 조각을 찾지 못함"),
                    };
                    match fixed {
                        Some((t, k)) => settle(&p, SegRes { text: t, change: k.change, flags: k.flags, kept: None }),
                        None if p.tries == 0 => again.push(Piece { tries: 1, ..p }),
                        None => settle(&p, SegRes { text: orig.clone(), change: 0.0, flags: vec![], kept: Some(why.to_string()) }),
                    }
                }
            }
        }
        let mut g = sh.lock().unwrap();
        // 다시 보낼 조각은 하나씩 따로 보낸다(다른 조각에 끌려 틀어지지 않게).
        for p in again {
            g.queue.push_back(vec![p]);
        }
        g.busy -= 1;
    };
    std::thread::scope(|s| {
        for _ in 0..workers.clamp(1, 8) {
            s.spawn(|| work());
        }
    });
    let mut g = sh.into_inner().unwrap();
    g.sum.stopped = cancel.load(Ordering::Relaxed);
    g.sum.error = g.fatal.take().unwrap_or_default();
    g.sum.secs = started.elapsed().as_secs_f64();
    g.sum
}

/// 보정을 실행해 결과를 notefix.db 에 적는다. 바로 받아들일 수 있는 것은 켜고(on), 확인이 필요한 것은 기다리게(pending) 둔다.
pub fn run(home: &Home, jobs: &[Job], ai: &dyn Ai, engine: &str, model: &str, workers: usize, on: &(dyn Fn(&NoteOut, usize, usize) + Sync), cancel: &AtomicBool) -> Result<Summary> {
    let db = Mutex::new(open(home)?);
    let sink = |j: &Job, o: &NoteOut, text: Option<&str>, done: usize, total: usize| {
        let mut o = o.clone();
        if let Some(t) = text {
            let c = db.lock().unwrap();
            let r = c.execute(
                "INSERT OR REPLACE INTO fix(series,bk,seq,orig_hash,text,state,flags,change,engine,model,created) VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))",
                (&j.series, j.bk, j.seq, hash(&j.text), t, if o.state == "ok" { "on" } else { "pending" }, &o.flags, o.change, engine, model),
            );
            if let Err(e) = r {
                o.state = "fail".into();
                o.error = format!("저장하지 못했습니다: {e}");
            }
        }
        on(&o, done, total);
    };
    Ok(process(jobs, ai, workers, &sink, cancel))
}

/// 목록에서 고른 차례(seq)의 풀이 원문을 읽어 일감으로 만든다.
pub fn jobs_for(home: &Home, series: &str, bk: i64, seqs: &[i64]) -> Result<Vec<Job>> {
    let r = Reader::open(home)?;
    Ok(r.comm_raw(series, bk, 0, i64::MAX, true)?
        .into_iter()
        .filter(|n| seqs.contains(&n.seq) && !n.text.trim().is_empty())
        .map(|n| Job { id: n.id, series: n.series, bk, seq: n.seq, text: n.text })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejoin(v: &[Seg]) -> String {
        v.iter().map(|s| format!("{}{}", s.text, s.glue)).collect()
    }

    #[test]
    fn segments_rejoin_to_original() {
        let long = "가나다라 마바사. ".repeat(60);
        let t = format!("첫 줄입니다.\n{}\n\n끝 줄.", long.trim_end());
        for max in [40, 120, 400, 5000] {
            let v = segments(&t, max);
            assert_eq!(rejoin(&v), t, "max={max}");
            assert!(v.iter().all(|s| s.text.chars().count() <= max), "max={max}");
        }
        assert!(segments("", 100).iter().all(|s| s.text.is_empty()));
        // 띄어쓰기가 없는 긴 줄도 한도 안에서 잘린다.
        let solid = "가".repeat(250);
        let v = segments(&solid, 100);
        assert_eq!(rejoin(&v), solid);
        assert_eq!(v.len(), 3);
    }

    #[test]
    fn long_line_splits_at_sentence_end() {
        let t = format!("{} 끝났다. {}", "가".repeat(70), "나".repeat(70));
        let v = segments(&t, 100);
        assert_eq!(v.len(), 2);
        assert!(v[0].text.ends_with("끝났다."));
        assert_eq!(v[0].glue, " ");
    }

    #[test]
    fn reply_parsing() {
        let r = "<<<1>>>\n첫째 글\n둘째 줄\n\n<<< 2 >>>\n```\n둘째 글\n```\n";
        assert_eq!(parse_reply(r, 2), vec![Some("첫째 글\n둘째 줄".to_string()), Some("둘째 글".to_string())]);
        assert_eq!(parse_reply("<<<2>>>\n글", 2), vec![None, Some("글".to_string())]);
        assert_eq!(parse_reply("번호 없이 온 글", 1), vec![Some("번호 없이 온 글".to_string())]);
        assert_eq!(parse_reply("번호 없이 온 글", 2), vec![None, None]);
        assert_eq!(parse_reply("<<<1>>>\n\n<<<2>>>\n글", 2), vec![None, Some("글".to_string())]);
    }

    #[test]
    fn check_rules() {
        let o = "밤에 온 것은 사람들의 눈을 피하기 위해\n서일 수도 있다(시 119:148). 세계 요한이 말했다.";
        let ok = check(o, "밤에 온 것은 사람들의 눈을 피하기 위해서일 수도 있다(시 119:148).\n세례 요한이 말했다.");
        assert!(ok.reject.is_none() && ok.flags.is_empty() && ok.change > 0.0 && ok.change < 0.06, "{ok:?}");
        // 줄바꿈과 띄어쓰기만 바뀌면 바뀐 비율은 0
        assert_eq!(check("가 나\n다", "가나 다").change, 0.0);
        assert!(check(o, &o.replace("119:148", "119:147")).flags.contains(&"num"));
        assert_eq!(check(o, "요약하면 밤에 왔다.").reject, Some("글이 줄었음"));
        assert_eq!(check(o, &format!("{o} {o}")).reject, Some("글이 늘었음"));
        assert_eq!(check(o, "").reject, Some("빈 답"));
        let other: String = o.chars().map(|c| if c == ' ' || c == '\n' { c } else { '가' }).collect();
        assert_eq!(check(o, &other).reject, Some("원문과 많이 달라짐"));
        assert!(check("70인 역은 이 말을 요 1:1과 같이 영원부터란 뜻을 지닌 엔 아르케 (ev dipxi)로 번역했다", "70인 역은 이 말을 요 1:1과 같이 영원부터란 뜻을 지닌 엔 아르케 (ἐν ἀρχῇ)로 번역했다").flags.contains(&"script"));
        assert!(check(o, &format!("**{}**", o)).flags.contains(&"md"));
    }

    /// 가짜 AI: 조각마다 정한 규칙대로 답한다.
    struct Fake(Mutex<Vec<String>>);
    impl Ai for Fake {
        fn ask(&self, _s: &str, user: &str, _c: &AtomicBool) -> std::result::Result<Reply, String> {
            self.0.lock().unwrap().push(user.to_string());
            let mut out = String::new();
            let mut n = 0;
            for line in user.lines().skip(1) {
                if let Some(k) = marker(line) {
                    n = k;
                    out.push_str(&format!("<<<{k}>>>\n"));
                } else if n > 0 {
                    if line.contains("버림") {
                        out.push_str("요약\n");
                    } else if line.contains("오류") {
                        return Err("AI 서버 오류 500: x".into());
                    } else {
                        out.push_str(&line.replace("위해 서일", "위해서일").replace("3:16", if line.contains("숫자") { "3:17" } else { "3:16" }));
                        out.push('\n');
                    }
                }
            }
            Ok(Reply { text: out, tok_in: 10, tok_out: 5, cost: None })
        }
    }

    #[test]
    fn process_states() {
        let job = |seq: i64, t: &str| Job { id: seq, series: "s".into(), bk: 1, seq, text: t.to_string() };
        let jobs = vec![
            job(1, "밤에 온 것은 눈을 피하기 위해 서일 수도 있다. 요 3:16 을 보라."),
            job(2, "고칠 곳이 없는 글입니다."),
            job(3, "숫자 를 바꾸는 글 위해 서일 수도 있다 요 3:16 을 보라."),
            job(4, "버림 받을 글은 원문을 둔다. 길이가 넉넉히 길어야 줄었다고 판정한다. 그래서 문장을 더 붙인다."),
            job(5, ""),
        ];
        let ai = Fake(Mutex::new(vec![]));
        let got: Mutex<Vec<(i64, String, Option<String>)>> = Mutex::new(vec![]);
        let sink = |j: &Job, o: &NoteOut, t: Option<&str>, _d: usize, _n: usize| got.lock().unwrap().push((j.seq, o.state.clone(), t.map(str::to_string)));
        let sum = process(&jobs, &ai, 2, &sink, &AtomicBool::new(false));
        let mut got = got.into_inner().unwrap();
        got.sort();
        let states: Vec<(i64, &str)> = got.iter().map(|g| (g.0, g.1.as_str())).collect();
        assert_eq!(states, vec![(1, "ok"), (2, "same"), (3, "review"), (4, "fail"), (5, "same")]);
        assert!(got[0].2.as_ref().unwrap().contains("위해서일"));
        assert!(got[3].2.is_none());
        assert_eq!((sum.ok, sum.review, sum.same, sum.fail, sum.total), (1, 1, 2, 1, 5));
        // 버려진 조각은 한 번 더 따로 보냈다(첫 요청 1 + 다시 1).
        assert_eq!(sum.requests, 2);
        assert!(sum.error.is_empty() && !sum.stopped);
    }

    #[test]
    fn run_saves_and_overlays() {
        let dir = tempfile::tempdir().unwrap();
        let home = Home::at(dir.path().to_path_buf());
        let jobs = vec![Job { id: 7, series: "s".into(), bk: 43, seq: 3, text: "눈을 피하기 위해 서일 수도 있다.".into() }, Job { id: 8, series: "s".into(), bk: 43, seq: 4, text: "숫자 위해 서일 3:16 이다.".into() }];
        let ai = Fake(Mutex::new(vec![]));
        let sum = run(&home, &jobs, &ai, "fake", "m", 1, &|_, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!((sum.ok, sum.review), (1, 1));
        // 바로 적용된 것만 켜져 있다.
        let on = applied(&home, 43);
        assert_eq!(on.len(), 1);
        let (h, t) = &on[&("s".to_string(), 3)];
        assert_eq!((h.as_str(), t.as_str()), (hash(&jobs[0].text).as_str(), "눈을 피하기 위해서일 수도 있다."));
        // 확인한 뒤 켜고, 되돌리면 지워진다.
        assert_eq!(approve(&home, "s", 43, &[4]).unwrap(), 1);
        assert_eq!(applied(&home, 43).len(), 2);
        assert_eq!(discard(&home, "s", 43, &[3, 4]).unwrap(), 2);
        assert!(applied(&home, 43).is_empty());
    }

    /// 작은 주석 자료를 직접 만들어, 목록→보정→주석 창에 보이는 글→되돌리기까지 한 바퀴 돈다.
    #[test]
    fn reader_shows_fix_and_reverts() {
        let dir = tempfile::tempdir().unwrap();
        let home = Home::at(dir.path().to_path_buf());
        std::fs::create_dir_all(home.source_dir(crate::source::SID)).unwrap();
        std::fs::write(home.state_path(crate::source::SID), r#"{"decl":{"format":"theolib/1","files":[]},"installed":["comm-t"]}"#).unwrap();
        let c = Connection::open(home.db_path(crate::source::SID, "comm-t")).unwrap();
        c.execute_batch(
            "CREATE TABLE series(id TEXT PRIMARY KEY, name TEXT, kind TEXT, unit TEXT, types TEXT, ord INTEGER, coverage TEXT, note TEXT);
             CREATE TABLE note(id INTEGER PRIMARY KEY, series TEXT, bk INTEGER, seq INTEGER, ch1 INTEGER, v1 INTEGER, ch2 INTEGER, v2 INTEGER, start_key INTEGER, end_key INTEGER, ref TEXT, title TEXT, text TEXT, book_id TEXT, p INTEGER);
             CREATE TABLE comm_verse(comm TEXT, book INTEGER, chapter INTEGER, verse INTEGER, html TEXT);
             INSERT INTO series(id,name,ord) VALUES('s','시험 주석',0);
             INSERT INTO note VALUES(1,'s',43,1,0,0,0,0,0,0,'서론','서론','서론 글은 눈을 피하기 위해 서일 수도 있다.','b',1);
             INSERT INTO note VALUES(2,'s',43,2,3,2,3,2,3002,3002,'3:2','','밤에 온 것은 눈을 피하기 위해 서일 수도 있다.','b',2);
             INSERT INTO note VALUES(3,'s',43,3,3,16,3,18,3016,3018,'3:16-18','','숫자 위해 서일 3:16 이다.','b',3);
             INSERT INTO note VALUES(4,'s',43,4,4,1,4,1,4001,4001,'4:1','','다른 장의 글.','b',4);",
        )
        .unwrap();
        drop(c);
        // 3장 범위: 3장에 걸린 풀이만(서론은 1장을 포함할 때만 나온다).
        let t = targets(&home, "s", 43, 3000, 3999).unwrap();
        assert_eq!(t.iter().map(|x| x.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert!(t.iter().all(|x| x.fix.is_empty()));
        assert_eq!(targets(&home, "s", 43, 1000, 3999).unwrap().len(), 3);
        // 절 범위를 좁히면 그 절에 걸린 풀이만 남는다.
        assert_eq!(targets(&home, "s", 43, 3010, 3020).unwrap().iter().map(|x| x.seq).collect::<Vec<_>>(), vec![3]);
        let jobs = jobs_for(&home, "s", 43, &[2, 3]).unwrap();
        let sum = run(&home, &jobs, &Fake(Mutex::new(vec![])), "fake", "m", 1, &|_, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!((sum.ok, sum.review), (1, 1));
        let r = Reader::open(&home).unwrap();
        let notes = r.comm_for(43, 3, None).unwrap();
        let n2 = notes.iter().find(|n| n.seq == 2).unwrap();
        assert!(n2.fixed && n2.body.contains("위해서일"));
        // 확인이 필요한 것은 켜기 전까지 원문 그대로 보인다.
        let n3 = notes.iter().find(|n| n.seq == 3).unwrap();
        assert!(!n3.fixed && n3.body.contains("3:16"));
        let t = targets(&home, "s", 43, 3000, 3999).unwrap();
        assert_eq!(t.iter().map(|x| x.fix.as_str()).collect::<Vec<_>>(), vec!["on", "pending"]);
        assert!(t[1].flags.contains("num"));
        let p = pair(&home, "s", 43, 3).unwrap().unwrap();
        assert!(p.orig.contains("3:16") && p.fix.unwrap().text.contains("3:17") && !p.stale);
        // 받은 자료의 원문이 바뀌면 보정본은 쓰이지 않는다.
        let c = Connection::open(home.db_path(crate::source::SID, "comm-t")).unwrap();
        c.execute("UPDATE note SET text=text||' 덧붙임.' WHERE seq=2", []).unwrap();
        drop(c);
        let n2 = Reader::open(&home).unwrap().comm_for(43, 3, None).unwrap().into_iter().find(|n| n.seq == 2).unwrap();
        assert!(!n2.fixed && n2.body.contains("덧붙임"));
        assert_eq!(targets(&home, "s", 43, 3000, 3999).unwrap()[0].fix, "stale");
        assert_eq!(discard(&home, "s", 43, &[2, 3]).unwrap(), 2);
        assert!(targets(&home, "s", 43, 3000, 3999).unwrap().iter().all(|x| x.fix.is_empty()));
    }

    #[test]
    fn fatal_error_stops() {
        struct Limit;
        impl Ai for Limit {
            fn ask(&self, _s: &str, _u: &str, _c: &AtomicBool) -> std::result::Result<Reply, String> {
                Err("사용 한도에 걸렸습니다.".into())
            }
        }
        let jobs: Vec<Job> = (0..30).map(|i| Job { id: i, series: "s".into(), bk: 1, seq: i, text: "가".repeat(3000) }).collect();
        let sum = process(&jobs, &Limit, 2, &|_, _, _, _, _| {}, &AtomicBool::new(false));
        assert!(sum.error.contains("한도"));
        assert!(sum.requests <= 2 && sum.ok + sum.review + sum.fail == 0);
    }
}
