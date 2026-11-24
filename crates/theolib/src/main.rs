use anyhow::Result;
use clap::{Parser, Subcommand};
use theolib_core::reader::{Reader, code_tokens, strip_tags};
use theolib_core::{Home, search, source};

#[derive(Parser)]
#[command(name = "theolib", about = "신학 서재 명령줄 도구")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 출처 관리: add <주소> [--files bible-ko,orig,comm] | list | remove
    Source {
        #[command(subcommand)]
        c: Src,
    },
    /// 바뀐 파일만 다시 받는다
    Sync,
    /// 검색 색인을 (다시) 만든다
    Index,
    Chapter { bk: String, ch: i64, #[arg(long, default_value = "개역개정")] ver: String },
    Comm { bk: String, at: String },
    Parse { bk: String, at: String },
    Lex { code: String },
    Search { q: String, #[arg(long = "in", default_value = "bible")] area: String, #[arg(long, default_value = "개역개정")] ver: String, #[arg(long, default_value_t = 20)] limit: usize },
    Stats,
    /// 항목별 선언에서 고른 항목만 받는다: items <주소> <항목id>...
    Items { url: String, ids: Vec<String> },
    /// 숨김 목록 바꾸기(v:개역개정 s:카리스종합주석 ...). 키 없이 부르면 해제
    Hide { keys: Vec<String> },
    /// 파일/폴더로 자료 추가
    Local { paths: Vec<String> },
    /// 웹 서재 상태·로그인
    Web {
        #[command(subcommand)]
        c: WebCmd,
    },
    /// MCP 연결 시험·주소 설정
    Mcp {
        #[command(subcommand)]
        c: McpCmd,
    },
    /// AI 본문연구(엔진·키·실행)
    Study {
        #[command(subcommand)]
        c: StudyCmd,
    },
    /// 주석 글 AI 보정(목록·실행·견본 시험·되돌리기)
    Fix {
        #[command(subcommand)]
        c: FixCmd,
    },
}

#[derive(Subcommand)]
enum FixCmd {
    /// 범위의 풀이 목록: list <시리즈 id> <책> <장> [--to 끝 장]
    List { series: String, bk: String, ch: i64, #[arg(long)] to: Option<i64> },
    /// 범위를 보정해 notefix.db 에 적는다(받은 자료는 고치지 않는다)
    Run {
        series: String,
        bk: String,
        ch: i64,
        #[arg(long)]
        to: Option<i64>,
        #[arg(long)]
        engine: String,
        #[arg(long, default_value = "")]
        model: String,
        #[arg(long, default_value_t = 3)]
        workers: usize,
    },
    /// 견본 파일(JSON 배열 [{id, text}])을 보정해 결과 파일을 쓴다(아무것도 저장하지 않는다)
    Bench {
        file: String,
        #[arg(long)]
        engine: String,
        #[arg(long, default_value = "")]
        model: String,
        #[arg(long)]
        out: String,
        #[arg(long, default_value_t = 3)]
        workers: usize,
    },
    /// 범위의 보정본을 지워 원문으로 되돌린다
    Discard { series: String, bk: String, ch: i64, #[arg(long)] to: Option<i64> },
    /// 서재와 맞춘다: 켜져 있는 내 보정본을 올리고, 그 책에서 다른 사용자가 올린 것을 받는다
    Sync { bk: String },
}

#[derive(Subcommand)]
enum Src {
    Add { url: String, #[arg(long, value_delimiter = ',')] files: Option<Vec<String>> },
    List,
    Remove,
}

#[derive(Subcommand)]
enum WebCmd {
    /// 로그인 상태(아이디·역할·pc_off·MCP 있음 여부만)
    Status,
    /// 로그인 (비밀번호는 환경변수 THEOLIB_PW 에서 읽는다)
    Login { id: String },
    /// 서재 자료 받기 주소: can·kind·파일 id 만 출력(주소는 출력하지 않음)
    AppSource,
    /// 서재 주소: 인자 없으면 지금 값, 있으면 바꾼다(빈 문자열이면 기본값으로)
    Base { url: Option<String> },
}

#[derive(Subcommand)]
enum McpCmd {
    /// 저장된 주소로 tools/list, 도구 이름만 출력
    Test,
    /// 주소를 환경변수 THEOLIB_IMPORT_MCP 에서 읽어 저장
    Set,
}

#[derive(Subcommand)]
enum StudyCmd {
    /// ai_engines 와 같은 목록(키는 끝 4자리 힌트만)
    Engines,
    /// 계정 권한 요약(scope·label·local_allowed·note)
    Scope,
    /// 구독 CLI 안내(설치·로그인·문서·요금제)
    Guide { engine: String },
    /// 키를 환경변수 THEOLIB_IMPORT_KEY 에서 읽어 저장
    KeyImport {
        #[arg(long)]
        provider: String,
        #[arg(long)]
        model: Option<String>,
    },
    /// ai_test 와 같음
    Test { #[arg(long)] engine: String },
    /// 연구 하나를 만들고 그 자리에서 실행
    Run {
        #[arg(long)]
        r#ref: String,
        #[arg(long)]
        purpose: Option<String>,
        #[arg(long)]
        depth: Option<String>,
        #[arg(long)]
        engine: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        notes: Option<String>,
        #[arg(long, value_delimiter = ',')]
        cats: Option<Vec<String>>,
    },
    /// 이어 묻기(id, 질문) + 실행
    Ask { id: String, q: String },
    /// 지난 연구 목록
    List,
}

fn split_at(s: &str) -> Result<(i64, Option<i64>)> {
    match s.split_once(':') {
        Some((a, b)) => Ok((a.parse()?, Some(b.parse()?))),
        None => Ok((s.parse()?, None)),
    }
}

fn progress() -> impl FnMut(&str, u64, u64) {
    let mut last = (String::new(), 101u64);
    move |label, done, total| {
        let pct = if total > 0 { done * 100 / total } else { 0 };
        if last.0 != label || pct / 10 != last.1 / 10 {
            eprintln!("  {label}: {pct}% ({done}/{total})");
            last = (label.to_string(), pct);
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let home = Home::default_location()?;
    match cli.cmd {
        Cmd::Source { c: Src::Add { url, files } } => {
            let mut p = progress();
            let st = source::add(&home, &url, files.as_deref(), &[], &mut p)?;
            println!("출처 추가: 받은 파일: {}", st.installed.join(", "));
            search::build_index(&home, &mut p)?;
            println!("검색 색인 완료");
        }
        Cmd::Source { c: Src::List } => {
            for s in source::list_sources(&home) {
                println!("설치: {}\n전체: {}", s.installed.join(","), s.decl.files.iter().map(|f| format!("{}({}B)", f.id, f.bytes)).collect::<Vec<_>>().join(","));
            }
        }
        Cmd::Source { c: Src::Remove } => {
            source::remove(&home)?;
            println!("지웠습니다");
        }
        Cmd::Sync => {
            let mut p = progress();
            let u = source::sync(&home, &mut p)?;
            println!("갱신한 파일: {}", if u.is_empty() { "없음".into() } else { u.join(", ") });
            search::build_index(&home, &mut p)?;
        }
        Cmd::Items { url, ids } => {
            let mut p = progress();
            let t = std::time::Instant::now();
            source::add_items(&home, &url, &ids, &mut p)?;
            println!("받기 {:.2}초", t.elapsed().as_secs_f64());
            let t = std::time::Instant::now();
            let st = search::status(&home);
            println!("색인 대기 단위: {:?}", st.pending);
            search::build_index(&home, &mut p)?;
            println!("기기 색인 {:.2}초", t.elapsed().as_secs_f64());
        }
        Cmd::Hide { keys } => {
            source::set_hidden(&home, keys)?;
            println!("숨김 설정");
        }
        Cmd::Local { paths } => {
            let mut p = progress();
            let ps: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
            let items = theolib_core::localfiles::scan(&ps);
            let (ok, bad) = theolib_core::localfiles::import(&home, &items, true, &mut p)?;
            println!("추가 {:?} 실패 {:?}", ok, bad);
            search::build_index(&home, &mut p)?;
        }
        Cmd::Web { c } => cmd_web(&home, c)?,
        Cmd::Mcp { c } => cmd_mcp(&home, c)?,
        Cmd::Study { c } => cmd_study(&home, c)?,
        Cmd::Fix { c } => cmd_fix(&home, c)?,
        Cmd::Index => {
            let mut p = progress();
            search::build_index(&home, &mut p)?;
            println!("검색 색인 완료");
        }
        cmd => {
            let r = Reader::open(&home)?;
            match cmd {
                Cmd::Chapter { bk, ch, ver } => {
                    let b = r.resolve_book(&bk)?;
                    let vers: Vec<String> = ver.split(',').map(|s| s.to_string()).collect();
                    let kinds: std::collections::HashMap<_, _> = r.versions()?.into_iter().map(|v| (v.id, v.kind)).collect();
                    for row in r.chapter(b, ch, &vers)? {
                        for (id, t) in row.texts {
                            let t = if kinds.get(&id).map(|k| k == "code").unwrap_or(false) {
                                code_tokens(&t).into_iter().map(|(w, c)| match c { Some(c) => format!("{w}<{c}>"), None => w }).collect::<String>()
                            } else {
                                strip_tags(&t)
                            };
                            println!("{}\t{}\t{}", row.v, id, t.replace('\n', " "));
                        }
                    }
                }
                Cmd::Comm { bk, at } => {
                    let b = r.resolve_book(&bk)?;
                    let (ch, v) = split_at(&at)?;
                    for n in r.comm_for(b, ch, v)? {
                        let body = if n.fmt == "html" { strip_tags(&n.body) } else { n.body.clone() };
                        let head: String = body.chars().take(120).collect();
                        println!("[{}][{}] {} ({}) {}", n.comm_name, n.kind, n.title, n.r#ref, head.replace('\n', " "));
                    }
                }
                Cmd::Parse { bk, at } => {
                    let b = r.resolve_book(&bk)?;
                    let (ch, v) = split_at(&at)?;
                    for w in r.parse(b, ch, v.unwrap_or(1))? {
                        println!("{}\t{}\t{}\t{}\t{}\t{}\t{}", w.i, w.w, w.code, w.lemma, w.tr, w.parse, w.gloss);
                    }
                }
                Cmd::Lex { code } => {
                    for e in r.lex(&code)? {
                        let t: String = strip_tags(&e.html).chars().take(150).collect();
                        println!("[{}] {} {}: {}", e.dict, e.code, e.head, t.replace('\n', " "));
                    }
                }
                Cmd::Search { q, area, ver, limit } => {
                    let vers: Vec<String> = ver.split(',').map(|s| s.to_string()).collect();
                    for h in search::search(&home, &q, &area, &vers, limit)? {
                        println!("{}\t{} {}:{}\t{}\t{}", h.src, h.bk, h.ch, h.v, h.ref_, h.snippet.replace('\n', " "));
                    }
                }
                Cmd::Stats => {
                    for (k, v) in r.stats()? {
                        println!("{k}\t{v}");
                    }
                }
                _ => unreachable!(),
            }
        }
    }
    Ok(())
}

// ---- 웹 서재 ----

fn cmd_web(home: &Home, c: WebCmd) -> Result<()> {
    match c {
        WebCmd::Status => {
            let st = theolib_core::web::status(home);
            println!("base: {}", st.base);
            println!("logged_in: {}", st.logged_in);
            if st.logged_in {
                println!("user: {}", st.user);
                println!("role: {}", st.role);
                println!("owner: {}", st.owner);
            }
            println!("pc_off: {}", st.pc_off);
            println!("has_mcp: {}", st.has_mcp);
        }
        WebCmd::Login { id } => {
            let pw = std::env::var("THEOLIB_PW").map_err(|_| anyhow::anyhow!("THEOLIB_PW 환경변수를 설정해 주세요."))?;
            let st = theolib_core::web::login(home, &id, &pw)?;
            if st.logged_in {
                println!("로그인했습니다 ({} · {}).", st.user, st.role);
            } else {
                println!("로그인 실패.");
            }
        }
        WebCmd::Base { url } => match url {
            None => {
                let i = theolib_core::web::base_info(home);
                println!("base: {}", i.base);
                println!("default: {}", i.is_default);
                println!("has_default: {}", i.has_default);
            }
            Some(u) => {
                theolib_core::web::set_base(home, &u)?;
                let st = theolib_core::web::status(home);
                println!("base: {}", st.base);
                println!("logged_in: {}", st.logged_in);
            }
        },
        WebCmd::AppSource => {
            let s = theolib_core::web::app_source(home)?;
            println!("can: {}", s.can);
            println!("kind: {}", s.kind);
            // 주소는 출력하지 않는다. 파일 id 만 나열한다.
            if let Some(files) = s.files.as_array() {
                for f in files {
                    if let Some(id) = f.get("id").and_then(|v| v.as_str()) {
                        println!("file: {id}");
                    }
                }
            }
        }
    }
    Ok(())
}

fn cmd_mcp(home: &Home, c: McpCmd) -> Result<()> {
    match c {
        McpCmd::Set => {
            let url = std::env::var("THEOLIB_IMPORT_MCP").map_err(|_| anyhow::anyhow!("THEOLIB_IMPORT_MCP 환경변수를 설정해 주세요."))?;
            theolib_core::mcp::set_url(home, &url)?;
            println!("저장했습니다");
        }
        McpCmd::Test => {
            let Some(url) = theolib_core::mcp::url(home) else {
                anyhow::bail!("서재 연결 주소가 없습니다. 먼저 저장하세요.");
            };
            let tools = theolib_core::mcp::tools_list(&url)?;
            for t in tools {
                if let Some(n) = t.get("name").and_then(|n| n.as_str()) {
                    println!("{n}");
                }
            }
        }
    }
    Ok(())
}

fn cmd_fix(home: &Home, c: FixCmd) -> Result<()> {
    use std::sync::atomic::AtomicBool;
    use theolib_core::fix;
    let range = |ch: i64, to: Option<i64>| (ch * 1000, to.unwrap_or(ch) * 1000 + 999);
    let book = |bk: &str| Reader::open(home)?.resolve_book(bk);
    let print = |s: &fix::Summary| {
        println!(
            "풀이 {}개: 적용 {} · 확인 필요 {} · 고칠 곳 없음 {} · 실패 {}{} | 요청 {}번, {:.0}초, 글자 {}, 토큰 입력 {} 출력 {}{}",
            s.total,
            s.ok,
            s.review,
            s.same,
            s.fail,
            if s.stopped { " (멈춤)" } else { "" },
            s.requests,
            s.secs,
            s.chars,
            s.tok_in,
            s.tok_out,
            if s.error.is_empty() { String::new() } else { format!(" | 오류: {}", s.error) }
        );
    };
    match c {
        FixCmd::List { series, bk, ch, to } => {
            let (lo, hi) = range(ch, to);
            for t in fix::targets(home, &series, book(&bk)?, lo, hi)? {
                println!("{:>5} {:>7}자 {:8} {} | {}", t.seq, t.chars, if t.fix.is_empty() { "-" } else { &t.fix }, t.r#ref, t.title.chars().take(40).collect::<String>());
            }
        }
        FixCmd::Run { series, bk, ch, to, engine, model, workers } => {
            let (lo, hi) = range(ch, to);
            let b = book(&bk)?;
            let seqs: Vec<i64> = fix::targets(home, &series, b, lo, hi)?.into_iter().filter(|t| t.start_key >= lo && t.start_key <= hi).map(|t| t.seq).collect();
            let jobs = fix::jobs_for(home, &series, b, &seqs)?;
            let ai = fix::make_ai(home, &engine, &model).map_err(anyhow::Error::msg)?;
            let on = |o: &fix::NoteOut, done: usize, total: usize| println!("[{done}/{total}] {} {} {:.1}% {} {}", o.seq, o.state, o.change * 100.0, o.flags, o.error);
            print(&fix::run(home, &jobs, ai.as_ref(), &engine, &model, workers, &on, &AtomicBool::new(false))?);
        }
        FixCmd::Bench { file, engine, model, out, workers } => {
            let src: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(&file)?)?;
            let jobs: Vec<fix::Job> = src.iter().enumerate().map(|(i, v)| fix::Job { id: i as i64, series: "bench".into(), bk: 0, seq: i as i64, text: v["text"].as_str().unwrap_or("").to_string() }).collect();
            let ai = fix::make_ai(home, &engine, &model).map_err(anyhow::Error::msg)?;
            let rows = std::sync::Mutex::new(Vec::new());
            let sink = |j: &fix::Job, o: &fix::NoteOut, text: Option<&str>, done: usize, total: usize| {
                println!("[{done}/{total}] {} {} {:.1}% {} {}", src[j.seq as usize]["id"], o.state, o.change * 100.0, o.flags, o.error);
                rows.lock().unwrap().push(serde_json::json!({"id": src[j.seq as usize]["id"], "n": j.seq, "state": o.state, "change": o.change, "flags": o.flags, "error": o.error, "text": text}));
            };
            let s = fix::process(&jobs, ai.as_ref(), workers, &sink, &AtomicBool::new(false));
            print(&s);
            let mut rows = rows.into_inner().unwrap();
            rows.sort_by_key(|r| r["n"].as_i64().unwrap_or(0));
            std::fs::write(&out, serde_json::to_vec_pretty(&serde_json::json!({"engine": engine, "model": model, "summary": s, "notes": rows}))?)?;
        }
        FixCmd::Sync { bk } => {
            let b = book(&bk)?;
            let net = fix::WebNet(home);
            let p = fix::push(home, &net);
            println!("올림 {} · 서재가 받지 않음 {} · 내림 {}{}", p.sent, p.rejected, p.removed, if p.error.is_empty() { String::new() } else { format!(" | 오류: {}", p.error) });
            println!("받아서 바뀐 것 {}개", fix::pull(home, &net, b)?);
        }
        FixCmd::Discard { series, bk, ch, to } => {
            let (lo, hi) = range(ch, to);
            let b = book(&bk)?;
            let seqs: Vec<i64> = fix::targets(home, &series, b, lo, hi)?.into_iter().filter(|t| !t.fix.is_empty()).map(|t| t.seq).collect();
            println!("보정본 {}개를 지웠습니다", fix::discard(home, &series, b, &seqs)?);
        }
    }
    Ok(())
}

fn cmd_study(home: &Home, c: StudyCmd) -> Result<()> {
    match c {
        StudyCmd::Engines => {
            let st = theolib_core::study::settings::load(home);
            let saved = theolib_core::study::keys::saved(home);
            for eng in theolib_core::study::llm::engines() {
                let key_hint = saved.get(&eng.id).cloned().unwrap_or_default();
                println!("{} ({}) key={}", eng.name, eng.id, key_hint);
            }
            // CLI 엔진
            for id in ["claude", "codex"] {
                let info = theolib_core::studycli::detect(id);
                let name = if id == "claude" { "클로드 구독" } else { "챗GPT 구독" };
                let ver = if info.version.is_empty() { String::new() } else { format!(" v{}", info.version) };
                println!("{name} ({id}) found={}{}", info.found, ver);
            }
            let _ = st;
        }
        StudyCmd::Scope => {
            let s = theolib_core::study::access::scope(home);
            println!("scope: {}", theolib_core::study::access::scope_id(&s));
            println!("label: {}", theolib_core::study::access::label(&s));
            println!("local_allowed: {}", theolib_core::study::access::local_allowed(&s));
            println!("note: {}", theolib_core::study::access::note(&s));
        }
        StudyCmd::Guide { engine } => {
            let g = theolib_core::studycli::guide(engine.trim());
            println!("id: {}", g.id);
            println!("name: {}", g.name);
            println!("found: {}", g.found);
            if g.found {
                println!("path: {}", g.path);
                if !g.version.is_empty() {
                    println!("version: {}", g.version);
                }
            }
            match g.logged_in {
                Some(true) => println!("logged_in: true"),
                Some(false) => println!("logged_in: false"),
                None => println!("logged_in: (알 수 없음)"),
            }
            println!("install_cmd: {}", g.install_cmd);
            println!("login_cmd: {}", g.login_cmd);
            println!("docs: {}", g.docs);
            println!("plan: {}", g.plan);
        }
        StudyCmd::KeyImport { provider, model } => {
            let key = std::env::var("THEOLIB_IMPORT_KEY").map_err(|_| anyhow::anyhow!("THEOLIB_IMPORT_KEY 환경변수를 설정해 주세요."))?;
            let clean = theolib_core::study::keys::clean_key(&key).ok_or_else(|| anyhow::anyhow!("API 키 형식이 올바르지 않습니다."))?;
            let m = model.unwrap_or_default();
            theolib_core::study::keys::save(home, &provider, &clean, &m, None)?;
            println!("저장했습니다 ({})", theolib_core::study::keys::hint(&clean));
        }
        StudyCmd::Test { engine } => {
            let out = test_engine(home, &engine, None, None);
            match out {
                Ok(()) => println!("ok"),
                Err(err) => {
                    eprintln!("오류: {err}");
                    std::process::exit(1);
                }
            }
        }
        StudyCmd::Run { r#ref, purpose, depth, engine, model, notes, cats } => {
            run_study_cli(home, &r#ref, purpose, depth, engine, model, notes, cats)?;
        }
        StudyCmd::Ask { id, q } => {
            let (code, body) = theolib_core::study::job::ask(home, &serde_json::json!({ "id": id, "q": q }));
            if code != 200 {
                anyhow::bail!("{}", body.get("error").and_then(|e| e.as_str()).unwrap_or("이어 묻기 실패"));
            }
            run_job_here(home, &id)?;
        }
        StudyCmd::List => {
            let list = theolib_core::study::job::list(home);
            let items = list.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
            for it in items {
                let id = it.get("id").and_then(|i| i.as_str()).unwrap_or("");
                let rref = it.get("ref").and_then(|i| i.as_str()).unwrap_or("");
                let status = it.get("status").and_then(|i| i.as_str()).unwrap_or("");
                let turns = it.get("turns").and_then(|i| i.as_i64()).unwrap_or(0);
                let engine = it.get("engine").and_then(|i| i.as_str()).unwrap_or("");
                println!("{id}\t{status}\t{turns}\t{engine}\t{rref}");
            }
        }
    }
    Ok(())
}

/// ai_test 와 같은 한 번 실행(엔진 id 로). model/key 는 None 이면 저장값.
fn test_engine(home: &Home, engine: &str, model: Option<&str>, key: Option<&str>) -> Result<()> {
    if engine == "claude" || engine == "codex" {
        let info = theolib_core::studycli::detect(engine);
        if !info.found {
            anyhow::bail!("이 PC에 {} 명령줄 도구가 설치되어 있지 않습니다.", if engine == "claude" { "클로드 Code" } else { "Codex" });
        }
        let _ = theolib_core::studycli::quick_test(&info).map_err(|e| anyhow::anyhow!("{e}"))?;
        return Ok(());
    }
    let eng = if engine == "custom" {
        let url = theolib_core::study::settings::load(home).custom_url;
        theolib_core::study::llm::custom_engine(&url)
    } else {
        theolib_core::study::llm::engine_by_id(engine).ok_or_else(|| anyhow::anyhow!("선택할 수 없는 AI입니다."))?
    };
    let key = key.map(|k| k.to_string()).filter(|k| !k.is_empty()).or_else(|| theolib_core::study::keys::load(home, engine)).unwrap_or_default();
    let model = model.map(|m| m.to_string()).filter(|m| !m.is_empty()).unwrap_or_else(|| {
        let st = theolib_core::study::settings::load(home);
        model_or_default(engine, &st)
    });
    theolib_core::study::llm::test(&eng, &key, &model).map_err(|e| anyhow::anyhow!("{e}"))
}

fn model_or_default(engine: &str, st: &theolib_core::study::settings::Settings) -> String {
    match engine {
        "deepseek" => st.model_for("deepseek", "deepseek-flash"),
        "claude" => st.model_for("claude", "sonnet"),
        "codex" => st.model_for("codex", "gpt-6-luna"),
        "gemini" => st.model_for("gemini", "gemini-3.8-flash"),
        "openai" => st.model_for("openai", "gpt-6-luna"),
        "anthropic" => st.model_for("anthropic", "claude-sonnet-5-5"),
        _ => String::new(),
    }
}

/// 연구 하나를 만들고 그 연구의 다음 turn 을 그 자리에서 돌린다(다른 프로세스의 연구를 건드리지 않는다).
fn run_study_cli(home: &Home, r#ref: &str, purpose: Option<String>, depth: Option<String>, engine: Option<String>, model: Option<String>, notes: Option<String>, cats: Option<Vec<String>>) -> Result<()> {
    let mut d = serde_json::json!({"ref": r#ref});
    if let Some(p) = purpose { d["purpose"] = serde_json::json!(p); }
    if let Some(dp) = depth { d["depth"] = serde_json::json!(dp); }
    if let Some(e) = engine { d["engine"] = serde_json::json!(e); }
    if let Some(m) = model { d["model"] = serde_json::json!(m); }
    if let Some(n) = notes { d["notes"] = serde_json::json!(n); }
    if let Some(c) = cats { d["cats"] = serde_json::json!(c); }

    let (code, body) = theolib_core::study::job::start(home, &d);
    if code != 200 {
        anyhow::bail!("{}", body.get("error").and_then(|e| e.as_str()).unwrap_or("시작 실패"));
    }
    let id = body["id"].as_str().unwrap_or("").to_string();
    run_job_here(home, &id)
}

/// 지정한 연구 id 의 다음 turn 을 돌려서 단계는 stderr, 보고서는 stdout 에 낸다.
fn run_job_here(home: &Home, id: &str) -> Result<()> {
    let cli = theolib_core::study::clirun::LocalCli;
    let mut on = |ev: &theolib_core::study::job::Event| match ev {
        theolib_core::study::job::Event::Step { step, .. } => {
            eprintln!("[{}] {}", theolib_core::study::time::now_time(), step.text);
        }
        theolib_core::study::job::Event::Status { status, .. } => {
            if status != "running" && status != "queued" {
                eprintln!("상태: {status}");
            }
        }
    };
    let ran = theolib_core::study::job::run_job(home, &cli, id, &mut on);
    if !ran {
        anyhow::bail!("실행할 연구가 없습니다.");
    }

    // 자기 연구 id 의 결과만 요약한다.
    let Some(rec) = theolib_core::study::job::get(home, id) else {
        anyhow::bail!("연구 기록을 찾지 못했습니다.");
    };
    let turns = rec.get("turns").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let last = turns.last().cloned().unwrap_or(serde_json::Value::Null);
    let status = last.get("status").and_then(|s| s.as_str()).unwrap_or("error").to_string();
    let engine = last.get("engine").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let model = last.get("model").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let tokens = last.get("tokens").cloned().unwrap_or(serde_json::json!({}));
    let seconds = last.get("seconds").and_then(|s| s.as_i64()).unwrap_or(0);

    if status == "error" {
        let err = last.get("error").and_then(|s| s.as_str()).unwrap_or("오류").to_string();
        eprintln!("오류: {err}");
        std::process::exit(1);
    }

    let md = last.get("md").and_then(|s| s.as_str()).unwrap_or("");
    println!("{md}");
    eprintln!("{}", summary_line(&status, &engine, &model, &tokens, seconds));
    Ok(())
}

/// 요약 줄: `상태: done / 엔진: deepseek / 모델: deepseek-flash / 토큰: 입력 448,652 · 출력 16,508 / 121초`
fn summary_line(status: &str, engine: &str, model: &str, tokens: &serde_json::Value, seconds: i64) -> String {
    let get = |k: &str| tokens.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let input = get("input_tokens");
    let output = get("output_tokens");
    if !model.is_empty() {
        format!("상태: {status} / 엔진: {engine} / 모델: {model} / 토큰: 입력 {input} · 출력 {output} / {seconds}초")
    } else {
        format!("상태: {status} / 엔진: {engine} / 토큰: 입력 {input} · 출력 {output} / {seconds}초")
    }
}
