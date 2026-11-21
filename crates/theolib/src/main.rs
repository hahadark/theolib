use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use theolib_core::reader::{Reader, code_tokens, strip_tags};
use theolib_core::{Home, search, source};

#[derive(Parser)]
#[command(name = "theolib", about = "신학 서재 명령줄 도구")]
struct Cli {
    /// 출처 id (하나뿐이면 생략)
    #[arg(long, global = true)]
    source: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 출처 관리: add <주소> [--files bible,orig] | list | remove <id>
    Source {
        #[command(subcommand)]
        c: Src,
    },
    /// 바뀐 파일만 다시 받는다
    Sync,
    Chapter { bk: String, ch: i64, #[arg(long, default_value = "개역개정")] ver: String },
    Comm { bk: String, at: String },
    Parse { bk: String, at: String },
    Lex { code: String },
    Search { q: String, #[arg(long = "in", default_value = "bible")] area: String, #[arg(long, default_value_t = 20)] limit: usize },
    Stats,
}

#[derive(Subcommand)]
enum Src {
    Add { url: String, #[arg(long, value_delimiter = ',')] files: Option<Vec<String>> },
    List,
    Remove { id: String },
}

fn pick_source(home: &Home, want: &Option<String>) -> Result<String> {
    if let Some(s) = want {
        return Ok(s.clone());
    }
    let l = source::list_sources(home);
    match l.len() {
        1 => Ok(l[0].decl.id.clone()),
        0 => bail!("출처가 없습니다. `theolib source add <주소>`로 추가하세요"),
        _ => bail!("출처가 여러 개입니다. --source <id>를 지정하세요"),
    }
}

fn split_at(s: &str) -> Result<(i64, Option<i64>)> {
    match s.split_once(':') {
        Some((a, b)) => Ok((a.parse()?, Some(b.parse()?))),
        None => Ok((s.parse()?, None)),
    }
}

fn progress() -> impl FnMut(&str, u64, u64) {
    let mut last = 0u64;
    move |id, done, total| {
        let pct = if total > 0 { done * 100 / total } else { 0 };
        if pct / 20 != last / 20 || done == total {
            eprintln!("  {id}: {pct}% ({done}/{total} 바이트)");
        }
        last = pct;
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let home = Home::default_location()?;
    match cli.cmd {
        Cmd::Source { c: Src::Add { url, files } } => {
            let mut p = progress();
            let st = source::add(&home, &url, files.as_deref(), &mut p)?;
            println!("출처 추가: {} ({}), 받은 파일: {}", st.decl.title, st.decl.id, st.installed.join(", "));
        }
        Cmd::Source { c: Src::List } => {
            for s in source::list_sources(&home) {
                println!("{}\t{}\t설치: {}\t전체: {}", s.decl.id, s.decl.title, s.installed.join(","), s.decl.files.iter().map(|f| format!("{}({}B)", f.id, f.bytes)).collect::<Vec<_>>().join(","));
            }
        }
        Cmd::Source { c: Src::Remove { id } } => {
            source::remove(&home, &id)?;
            println!("지웠습니다: {id}");
        }
        Cmd::Sync => {
            let sid = pick_source(&home, &cli.source)?;
            let mut p = progress();
            let u = source::sync(&home, &sid, &mut p)?;
            println!("갱신한 파일: {}", if u.is_empty() { "없음".into() } else { u.join(", ") });
        }
        cmd => {
            let sid = pick_source(&home, &cli.source)?;
            let r = Reader::open(&home, &sid)?;
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
                        println!("{}\t{}\t{}\t{}\t{}\t{}", w.i, w.w, w.code, w.lemma, w.parse, w.gloss);
                    }
                }
                Cmd::Lex { code } => {
                    for e in r.lex(&code)? {
                        let t: String = strip_tags(&e.html).chars().take(150).collect();
                        println!("[{}] {} {}: {}", e.dict, e.code, e.head, t.replace('\n', " "));
                    }
                }
                Cmd::Search { q, area, limit } => {
                    for h in search::search(&home, &sid, &q, &area, limit)? {
                        println!("{}\t{} {}:{}\t{}", h.src, h.bk, h.ch, h.v, h.snippet.replace('\n', " "));
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
