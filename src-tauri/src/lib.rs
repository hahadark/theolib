use serde::Serialize;
use tauri::{AppHandle, Emitter};
use theolib_core::reader::{self, Reader};
use theolib_core::{Home, html, search, source};

type R<T> = Result<T, String>;
fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}
fn home() -> R<Home> {
    Home::default_location().map_err(e)
}

#[tauri::command]
fn sources() -> R<Vec<source::State>> {
    Ok(source::list_sources(&home()?))
}

#[tauri::command]
async fn preview_source(url: String) -> R<source::Declaration> {
    tauri::async_runtime::spawn_blocking(move || source::fetch_declaration(url.trim()).map_err(e)).await.map_err(e)?
}

#[derive(Serialize, Clone)]
struct Progress {
    file: String,
    done: u64,
    total: u64,
}

#[tauri::command]
async fn add_source(app: AppHandle, url: String, files: Vec<String>) -> R<source::State> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut p = |f: &str, d: u64, t: u64| {
            let _ = app.emit("progress", Progress { file: f.into(), done: d, total: t });
        };
        source::add(&h, url.trim(), Some(&files), &mut p).map_err(e)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
async fn sync_source(app: AppHandle, sid: String) -> R<Vec<String>> {
    let h = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut p = |f: &str, d: u64, t: u64| {
            let _ = app.emit("progress", Progress { file: f.into(), done: d, total: t });
        };
        source::sync(&h, &sid, &mut p).map_err(e)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
fn remove_source(sid: String) -> R<()> {
    source::remove(&home()?, &sid).map_err(e)
}

fn rd(sid: &str) -> R<Reader> {
    Reader::open(&home()?, sid).map_err(e)
}

#[tauri::command]
fn books(sid: String) -> R<Vec<reader::Book>> {
    rd(&sid)?.books().map_err(e)
}

#[tauri::command]
fn versions(sid: String) -> R<Vec<reader::Version>> {
    rd(&sid)?.versions().map_err(e)
}

#[derive(Serialize)]
struct VText {
    ver: String,
    html: String,
}
#[derive(Serialize)]
struct VRow {
    v: i64,
    texts: Vec<VText>,
}

/// 원어 번호 본문은 낱말 뒤에 번호 단추를 붙인 HTML로, 일반 본문은 걸러낸 HTML로 바꿔 준다.
fn verse_html(kind: &str, t: &str) -> String {
    if kind == "code" {
        let mut s = String::new();
        for (w, c) in reader::code_tokens(t) {
            s.push_str(&html::text_to_html(&w));
            if let Some(c) = c {
                if c != "G0" && c != "H0" {
                    s.push_str(&html::sanitize(&format!("<a class=\"sc\" data-c=\"{c}\">{c}</a>")));
                }
            }
        }
        s
    } else {
        html::sanitize(t)
    }
}

#[tauri::command]
fn chapter(sid: String, bk: i64, ch: i64, vers: Vec<String>) -> R<Vec<VRow>> {
    let r = rd(&sid)?;
    let kinds: std::collections::HashMap<String, String> = r.versions().map_err(e)?.into_iter().map(|v| (v.id, v.kind)).collect();
    Ok(r.chapter(bk, ch, &vers)
        .map_err(e)?
        .into_iter()
        .map(|row| VRow {
            v: row.v,
            texts: row.texts.into_iter().map(|(ver, t)| VText { html: verse_html(kinds.get(&ver).map(|s| s.as_str()).unwrap_or("text"), &t), ver }).collect(),
        })
        .collect())
}

#[derive(Serialize)]
struct NoteOut {
    id: i64,
    comm: String,
    comm_name: String,
    kind: String,
    title: String,
    r#ref: String,
    html: String,
}

#[tauri::command]
fn notes(sid: String, bk: i64, ch: i64, v: Option<i64>) -> R<Vec<NoteOut>> {
    Ok(rd(&sid)?
        .comm_for(bk, ch, v)
        .map_err(e)?
        .into_iter()
        .map(|n| NoteOut {
            html: if n.fmt == "html" { html::sanitize(&n.body) } else { html::text_to_html(&n.body) },
            id: n.id,
            comm: n.comm,
            comm_name: n.comm_name,
            kind: n.kind,
            title: n.title,
            r#ref: n.r#ref,
        })
        .collect())
}

#[tauri::command]
fn parse(sid: String, bk: i64, ch: i64, v: i64) -> R<Vec<reader::ParseWord>> {
    rd(&sid)?.parse(bk, ch, v).map_err(e)
}

#[derive(Serialize)]
struct LexOut {
    dict: String,
    code: String,
    head: String,
    html: String,
}

#[tauri::command]
fn lex(sid: String, code: String) -> R<Vec<LexOut>> {
    Ok(rd(&sid)?.lex(&code).map_err(e)?.into_iter().map(|x| LexOut { html: html::sanitize(&x.html), dict: x.dict, code: x.code, head: x.head }).collect())
}

#[tauri::command]
fn search_text(sid: String, q: String, area: String) -> R<Vec<search::Hit>> {
    search::search(&home()?, &sid, &q, &area, 100).map_err(e)
}

#[tauri::command]
fn goto_ref(sid: String, input: String) -> R<Option<(i64, i64, Option<i64>)>> {
    Ok(rd(&sid)?.parse_ref(&input))
}

#[tauri::command]
fn articles(sid: String) -> R<Vec<reader::Article>> {
    rd(&sid)?.articles().map_err(e)
}

/// 시험 빌드(--features selftest) 전용: 화면 조작을 흉내 내고 결과를 파일로 남긴다. 배포 빌드에는 없다.
#[cfg(feature = "selftest")]
#[tauri::command]
fn selftest_report(text: String) {
    let _ = std::fs::write(std::env::var("THEOLIB_SELFTEST_OUT").unwrap_or("/tmp/theolib-selftest.txt".into()), text);
}

#[cfg(feature = "selftest")]
const SELFTEST_JS: &str = include_str!("../selftest.js");

pub fn run() {
    let b = tauri::Builder::default();
    #[cfg(feature = "selftest")]
    let b = b.on_page_load(|w, _| {
        if let Ok(url) = std::env::var("THEOLIB_SELFTEST_URL") {
            let _ = w.eval(format!("window.__SELFTEST_URL={};{}", serde_json::to_string(&url).unwrap(), SELFTEST_JS));
        }
    });
    #[cfg(feature = "selftest")]
    let b = b.invoke_handler(tauri::generate_handler![
        sources, preview_source, add_source, sync_source, remove_source, books, versions, chapter, notes, parse, lex, search_text, goto_ref, articles, selftest_report
    ]);
    #[cfg(not(feature = "selftest"))]
    let b = b
        .invoke_handler(tauri::generate_handler![
            sources, preview_source, add_source, sync_source, remove_source, books, versions, chapter, notes, parse, lex, search_text, goto_ref, articles
        ]);
    b.run(tauri::generate_context!())
        .expect("앱을 실행하지 못했습니다");
}
