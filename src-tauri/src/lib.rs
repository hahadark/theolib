use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
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

#[derive(Serialize, Clone)]
struct Progress {
    label: String,
    done: u64,
    total: u64,
}

#[derive(Serialize)]
struct Preview {
    origin: String,
    layout: String,
    title: String,
    updated: String,
    note: String,
    files: serde_json::Value,
    links: Vec<source::Link>,
    /// zip 출처: 목록을 읽느라 받은 바이트 수와 전체 크기
    fetched: u64,
    size: u64,
}

#[tauri::command]
fn sources() -> R<Vec<source::State>> {
    Ok(source::list_sources(&home()?))
}

#[tauri::command]
async fn preview_source(url: String) -> R<Preview> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = url.trim();
        if theolib_core::zipsrc::looks_zip(url) {
            let h = home()?;
            let (files, fetched, size) = theolib_core::zipsrc::preview(&h, url).map_err(e)?;
            return Ok(Preview { origin: "압축 파일".into(), layout: "items".into(), title: "압축 파일".into(), updated: String::new(), note: String::new(), files: serde_json::Value::Array(files), links: vec![], fetched, size });
        }
        let ctx = source::Ctx::new(url).map_err(e)?;
        let d = ctx.declaration().map_err(e)?;
        Ok(Preview { origin: ctx.origin(), layout: d.layout, title: d.title, updated: d.updated, note: d.note, files: serde_json::to_value(&d.files).map_err(e)?, links: d.links, fetched: 0, size: 0 })
    })
    .await
    .map_err(e)?
}

static INDEXING: AtomicBool = AtomicBool::new(false);

/// 검색 색인을 백그라운드 스레드에서 만든다. 진행률은 "progress" 이벤트, 끝나면 "index-done".
fn start_index(app: AppHandle) {
    if INDEXING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(h) = home() else {
        INDEXING.store(false, Ordering::SeqCst);
        return;
    };
    if search::status(&h).ready {
        INDEXING.store(false, Ordering::SeqCst);
        return;
    }
    std::thread::spawn(move || {
        let a = app.clone();
        let mut p = move |l: &str, d: u64, t: u64| {
            let _ = a.emit("progress", Progress { label: l.into(), done: d, total: t });
        };
        let r = search::build_index(&h, &mut p);
        INDEXING.store(false, Ordering::SeqCst);
        let _ = app.emit("index-done", r.err().map(|x| x.to_string()));
    });
}

#[tauri::command]
fn index_status() -> R<serde_json::Value> {
    let st = search::status(&home()?);
    Ok(serde_json::json!({"ready": st.ready, "pending": st.pending, "running": INDEXING.load(Ordering::SeqCst)}))
}

#[tauri::command]
fn resume_index(app: AppHandle) {
    start_index(app);
}

#[tauri::command]
async fn add_source(app: AppHandle, url: String, files: Vec<String>) -> R<source::State> {
    let h = home()?;
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let mut p = |l: &str, d: u64, t: u64| {
            let _ = a.emit("progress", Progress { label: l.into(), done: d, total: t });
        };
        source::add(&h, url.trim(), Some(&files), &[], &mut p).map_err(e)
    })
    .await
    .map_err(e)??;
    start_index(app);
    Ok(r)
}

#[tauri::command]
async fn add_items(app: AppHandle, url: String, ids: Vec<String>) -> R<source::State> {
    let h = home()?;
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let mut p = |l: &str, d: u64, t: u64| {
            let _ = a.emit("progress", Progress { label: l.into(), done: d, total: t });
        };
        source::add_items(&h, url.trim(), &ids, &mut p).map_err(e)
    })
    .await
    .map_err(e)??;
    start_index(app);
    Ok(r)
}

#[tauri::command]
fn remove_items(app: AppHandle, ids: Vec<String>) -> R<()> {
    source::remove_items(&home()?, &ids).map_err(e)?;
    start_index(app);
    Ok(())
}

/// 파일(여러 개) 또는 폴더를 고르는 대화상자. 고른 경로 목록(취소하면 빈 목록).
#[tauri::command]
async fn pick_paths(app: AppHandle, folder: bool) -> R<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let d = app.dialog().file();
        let v: Vec<String> = if folder {
            d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| vec![p.to_string_lossy().into_owned()]).unwrap_or_default()
        } else {
            d.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect()
        };
        Ok(v)
    })
    .await
    .map_err(e)?
}

#[derive(Serialize)]
struct LocalScan {
    /// 이 앱의 항목 선언(theolib.json)이 든 폴더면 그 선언 경로
    declaration: Option<String>,
    items: Vec<theolib_core::localfiles::LocalItem>,
}

#[tauri::command]
async fn scan_local(paths: Vec<String>) -> R<LocalScan> {
    tauri::async_runtime::spawn_blocking(move || {
        let ps: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
        for p in &ps {
            let d = if p.is_dir() { p.join("theolib.json") } else { p.clone() };
            if d.file_name().map(|n| n == "theolib.json").unwrap_or(false) && d.exists() {
                return Ok(LocalScan { declaration: Some(d.to_string_lossy().into_owned()), items: vec![] });
            }
        }
        Ok(LocalScan { declaration: None, items: theolib_core::localfiles::scan(&ps) })
    })
    .await
    .map_err(e)?
}

#[tauri::command]
async fn import_local(app: AppHandle, items: Vec<theolib_core::localfiles::LocalItem>, replace: bool) -> R<(Vec<String>, Vec<String>)> {
    let h = home()?;
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let mut p = |l: &str, d: u64, t: u64| {
            let _ = a.emit("progress", Progress { label: l.into(), done: d, total: t });
        };
        theolib_core::localfiles::import(&h, &items, replace, &mut p).map_err(e)
    })
    .await
    .map_err(e)??;
    start_index(app);
    Ok(r)
}

#[tauri::command]
fn cancel_download() {
    source::cancel();
}

/// 저작권 자유 기본 자료 저장소 주소(공개, 토큰 없음). THEOLIB_FREE_URL 은 시험용.
#[tauri::command]
fn free_url() -> String {
    std::env::var("THEOLIB_FREE_URL").unwrap_or_else(|_| "https://github.com/hahadark/theolib-free".into())
}

#[tauri::command]
async fn sync_source(app: AppHandle) -> R<Vec<String>> {
    let h = home()?;
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let mut p = |l: &str, d: u64, t: u64| {
            let _ = a.emit("progress", Progress { label: l.into(), done: d, total: t });
        };
        source::sync(&h, &mut p).map_err(e)
    })
    .await
    .map_err(e)??;
    start_index(app);
    Ok(r)
}

#[tauri::command]
fn remove_source() -> R<()> {
    source::remove(&home()?).map_err(e)
}

fn rd() -> R<Reader> {
    Reader::open(&home()?).map_err(e)
}

#[tauri::command]
fn books() -> R<Vec<theolib_core::books::Book>> {
    Ok(theolib_core::books::books())
}

#[tauri::command]
fn versions() -> R<Vec<reader::Version>> {
    rd()?.versions().map_err(e)
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
                s.push_str(&html::sanitize(&format!("<a class=\"sc\" data-c=\"{c}\">{c}</a>")));
            }
        }
        s
    } else {
        html::sanitize(t)
    }
}

#[tauri::command]
fn chapter(bk: i64, ch: i64, vers: Vec<String>) -> R<Vec<VRow>> {
    let r = rd()?;
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
    start_key: i64,
    end_key: i64,
    ch1: i64,
    ch2: i64,
}

fn note_html(fmt: &str, body: &str) -> String {
    if fmt == "html" { html::sanitize(body) } else { html::text_to_html(body) }
}

#[tauri::command]
fn notes(bk: i64, ch: i64, v: Option<i64>) -> R<Vec<NoteOut>> {
    let r = rd()?;
    if !r.has("comm") {
        return Ok(vec![]);
    }
    Ok(r.comm_for(bk, ch, v)
        .map_err(e)?
        .into_iter()
        .map(|n| NoteOut { html: note_html(&n.fmt, &n.body), id: n.id, comm: n.comm, comm_name: n.comm_name, kind: n.kind, title: n.title, r#ref: n.r#ref, start_key: n.start_key, end_key: n.end_key, ch1: n.ch1, ch2: n.ch2 })
        .collect())
}

#[tauri::command]
fn parse(bk: i64, ch: i64, v: i64) -> R<Vec<reader::ParseWord>> {
    let r = rd()?;
    if !r.has("orig") {
        return Ok(vec![]);
    }
    r.parse(bk, ch, v).map_err(e)
}

#[derive(Serialize)]
struct LexOut {
    dict: String,
    code: String,
    head: String,
    html: String,
}

#[tauri::command]
fn lex(code: String) -> R<Vec<LexOut>> {
    let r = rd()?;
    if !r.has("orig") {
        return Ok(vec![]);
    }
    Ok(r.lex(&code).map_err(e)?.into_iter().map(|x| LexOut { html: html::sanitize(&x.html), dict: x.dict, code: x.code, head: x.head }).collect())
}

/// 화면의 숨김 목록(v:/d:/s: 키)을 코어에 전달한다. 검색·목록에서 빠진다.
#[tauri::command]
fn set_hidden(hidden: Vec<String>) -> R<()> {
    source::set_hidden(&home()?, hidden).map_err(e)
}

#[tauri::command]
fn search_text(q: String, area: String, vers: Vec<String>) -> R<Vec<search::Hit>> {
    search::search(&home()?, &q, &area, &vers, 100).map_err(e)
}

#[tauri::command]
fn goto_ref(input: String) -> R<Option<(i64, i64, Option<i64>)>> {
    Ok(theolib_core::books::parse_ref(&input))
}

#[tauri::command]
fn articles() -> R<Vec<reader::Article>> {
    let r = rd()?;
    if !r.has("comm") {
        return Ok(vec![]);
    }
    r.articles().map_err(e)
}

#[tauri::command]
fn article_body(id: i64) -> R<String> {
    Ok(html::text_to_html(&rd()?.article_body(id).map_err(e)?))
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
    let b = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "selftest")]
    let b = b.on_page_load(|w, _| {
        if let Ok(url) = std::env::var("THEOLIB_SELFTEST_URL") {
            let local = std::env::var("THEOLIB_SELFTEST_LOCAL").unwrap_or_default();
            let _ = w.eval(format!("window.__SELFTEST_URL={};window.__SELFTEST_LOCAL={};{}", serde_json::to_string(&url).unwrap(), serde_json::to_string(&local).unwrap(), SELFTEST_JS));
        }
    });
    #[cfg(feature = "selftest")]
    let b = b.invoke_handler(tauri::generate_handler![
        sources, preview_source, add_source, add_items, remove_items, pick_paths, scan_local, import_local, cancel_download, free_url, sync_source, remove_source, index_status, resume_index, books, versions, chapter, notes, parse, lex, search_text, set_hidden, goto_ref, articles, article_body, selftest_report
    ]);
    #[cfg(not(feature = "selftest"))]
    let b = b
        .invoke_handler(tauri::generate_handler![
            sources, preview_source, add_source, add_items, remove_items, pick_paths, scan_local, import_local, cancel_download, free_url, sync_source, remove_source, index_status, resume_index, books, versions, chapter, notes, parse, lex, search_text, set_hidden, goto_ref, articles, article_body
        ]);
    b.run(tauri::generate_context!())
        .expect("앱을 실행하지 못했습니다");
}
