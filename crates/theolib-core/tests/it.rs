//! 실제 DB 사본(app/real-source)을 로컬 간이 서버(127.0.0.1, Range 지원)로 띄워 시험한다.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use theolib_core::reader::Reader;
use theolib_core::{Home, search, source};

fn real_source() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../real-source")
}

#[derive(Default)]
struct Cfg {
    /// 모든 요청에 이 상태 코드를 돌려준다
    status: Mutex<Option<u16>>,
    /// 경로별로 처음 한 번만 이만큼 보내고 연결을 끊는다
    cut_once: Mutex<HashMap<String, usize>>,
    /// (경로, Range 헤더, 돌려준 코드)
    log: Mutex<Vec<(String, String, u16)>>,
    /// true 면 Range 를 무시하고 항상 200
    no_range: std::sync::atomic::AtomicBool,
    /// 보낸 본문 바이트 합
    sent: std::sync::atomic::AtomicU64,
}

fn serve(dir: PathBuf, cfg: Arc<Cfg>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { continue };
            let (dir, cfg) = (dir.clone(), cfg.clone());
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
                let hdr = |k: &str| req.lines().find_map(|l| l.to_lowercase().strip_prefix(&format!("{k}:")).map(|v| v.trim().to_string())).unwrap_or_default();
                let mut range = hdr("range");
                if cfg.no_range.load(std::sync::atomic::Ordering::SeqCst) {
                    range.clear();
                }
                if let Some(c) = *cfg.status.lock().unwrap() {
                    let _ = write!(s, "HTTP/1.1 {c} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                }
                let Ok(b) = std::fs::read(dir.join(&path)) else {
                    let _ = write!(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                };
                let (mut start, mut end, mut code) = (0usize, b.len(), 200u16);
                if let Some(r) = range.strip_prefix("bytes=") {
                    if hdr("if-range").is_empty() || hdr("if-range") == "\"t1\"" {
                        let (a, bb) = r.split_once('-').unwrap_or((r, ""));
                        if a.is_empty() {
                            start = b.len().saturating_sub(bb.parse::<usize>().unwrap_or(0));
                        } else {
                            start = a.parse().unwrap_or(0);
                            if let Ok(e) = bb.parse::<usize>() {
                                end = (e + 1).min(b.len());
                            }
                        }
                        code = 206;
                    }
                }
                cfg.log.lock().unwrap().push((path.clone(), range, code));
                let body = &b[start..end];
                cfg.sent.fetch_add(body.len() as u64, std::sync::atomic::Ordering::SeqCst);
                let extra = if code == 206 { format!("Content-Range: bytes {start}-{}/{}\r\n", end - 1, b.len()) } else { String::new() };
                let _ = write!(s, "HTTP/1.1 {code} X\r\nETag: \"t1\"\r\nAccept-Ranges: bytes\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let cut = cfg.cut_once.lock().unwrap().remove(&path);
                match cut {
                    Some(k) => {
                        let _ = s.write_all(&body[..k.min(body.len())]);
                    }
                    None => {
                        let _ = s.write_all(body);
                    }
                }
            });
        }
    });
    format!("http://127.0.0.1:{port}/theolib.json")
}

struct Shared {
    _t: tempfile::TempDir,
    home: Home,
    install_secs: f64,
}

/// 5묶음을 한 번만 설치한다(읽기 시험 공용).
fn shared() -> &'static Shared {
    static S: OnceLock<Shared> = OnceLock::new();
    S.get_or_init(|| {
        unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
        let t = tempfile::tempdir().unwrap();
        let home = Home::at(t.path().join("home"));
        let url = serve(real_source(), Arc::new(Cfg::default()));
        let t0 = Instant::now();
        let st = source::add(&home, &url, None, &[], &mut |_, _, _| {}).unwrap();
        assert_eq!(st.installed.len(), 5);
        search::build_index(&home, &mut |_, _, _| {}).unwrap();
        Shared { _t: t, home, install_secs: t0.elapsed().as_secs_f64() }
    })
}

#[test]
fn install_five_packs_and_sha() {
    let s = shared();
    let r = Reader::open(&s.home).unwrap();
    assert_eq!(r.installed().len(), 5);
    let st = r.stats().unwrap();
    println!("설치+색인 {:.1}초, 통계 {:?}", s.install_secs, st);
    assert_eq!(st["bible-ko:version"], 44);
    assert!(search::status(&s.home).ready);
    // 상태 파일에 주소 없음
    let state = std::fs::read_to_string(s.home.state_path(source::SID)).unwrap();
    assert!(!state.contains("127.0.0.1"));
}

#[test]
fn verse_and_82_versions() {
    let r = Reader::open(&shared().home).unwrap();
    let vs = r.versions().unwrap();
    let text = vs.iter().filter(|v| v.kind == "text").count();
    println!("번역본 {text}종, 원어 번호 본문 {}종", vs.iter().filter(|v| v.kind == "code").count());
    assert_eq!(text, 82);
    assert_eq!(vs.iter().filter(|v| v.kind == "code").count(), 3);
    let rows = r.chapter(44, 24, &["개역개정".into(), "KJV".into()]).unwrap();
    let v10 = rows.iter().find(|x| x.v == 10).unwrap();
    assert!(v10.texts[0].1.starts_with("총독이 바울에게"));
    assert_eq!(r.parse_ref("행 24:10"), Some((44, 24, Some(10))));
}

#[test]
fn comm_tabs_and_henry() {
    let r = Reader::open(&shared().home).unwrap();
    let notes = r.comm_for(44, 24, Some(10)).unwrap();
    let names: std::collections::BTreeSet<_> = notes.iter().map(|n| n.comm_name.clone()).collect();
    println!("24:10 주석 탭: {:?}", names);
    for n in ["카리스 종합주석", "IVP 성경주석", "ESV 스터디 바이블", "매튜헨리"] {
        assert!(names.contains(n), "{n}");
    }
    assert!(notes.iter().any(|n| n.comm == "카리스종합주석" && n.kind == "주해" && n.body.contains("뉴오")));
    let ch = r.comm_for(44, 24, None).unwrap();
    assert!(ch.iter().filter(|n| n.comm == "매튜헨리").count() >= 2);
    assert!(r.comm_for(44, 1, None).unwrap().iter().any(|n| n.title == "서론"));
}

#[test]
fn parse_and_two_dicts() {
    let r = Reader::open(&shared().home).unwrap();
    let w = r.parse(44, 24, 10).unwrap();
    println!("24:10 원전분해 {}줄", w.len());
    assert!(w.len() >= 15 && w[0].code == "G611" && w[0].gloss == "대답하되");
    let mut found = 0;
    for x in &w {
        if !x.code.is_empty() && !r.lex(&x.code).unwrap().is_empty() {
            found += 1;
        }
    }
    println!("사전 찾은 낱말 {found}/{}", w.len());
    assert!(found * 10 >= w.len() * 8);
    let l = r.lex("G611").unwrap();
    assert_eq!(l.iter().map(|e| e.dict.as_str()).collect::<Vec<_>>(), ["HebGrkKo", "HebGrkEn"]);
    assert!(!r.lex("H430").unwrap().is_empty());
    assert!(!r.lex("G2115b").unwrap().is_empty());
    let toks = theolib_core::reader::code_tokens(&r.chapter(44, 24, &["개역개정S".into()]).unwrap().iter().find(|x| x.v == 10).unwrap().texts[0].1);
    assert!(toks.iter().any(|t| t.1.as_deref() == Some("G2232")));
}

#[test]
fn search_and_timing() {
    let s = shared();
    let r = Reader::open(&s.home).unwrap();
    let t = Instant::now();
    let rows = r.chapter(44, 24, &["개역개정".into(), "새번역".into(), "개역개정S".into()]).unwrap();
    let t_ch = t.elapsed().as_secs_f64();
    let notes = r.comm_for(44, 24, None).unwrap();
    let t_ch2 = t.elapsed().as_secs_f64();
    assert!(!rows.is_empty() && !notes.is_empty());
    let t = Instant::now();
    let b = search::search(&s.home, "총독", "bible", &["개역개정".into()], 100).unwrap();
    let t_b = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let c = search::search(&s.home, "뉴산토스", "comm", &[], 100).unwrap();
    let t_c = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let b2 = search::search(&s.home, "하나님이 세상을", "bible", &["개역개정".into(), "KJV".into(), "ESV".into()], 100).unwrap();
    let t_b2 = t.elapsed().as_secs_f64();
    println!("장 열기(본문3종) {:.4}초, +주석 {:.4}초, 성경 검색 {} 건 {:.4}초, 주석 검색 {} 건 {:.4}초, 3종 구절 검색 {} 건 {:.4}초", t_ch, t_ch2, b.len(), t_b, c.len(), t_c, b2.len(), t_b2);
    assert!(t_ch2 < 0.2 && t_b < 1.0 && t_c < 1.0 && t_b2 < 1.0);
    assert!(b.len() >= 50 && b.iter().all(|h| h.snippet.contains("[총독]")));
    assert!(c.iter().any(|h| h.bk == 44 && h.ch == 24 && h.v == 10));
}

fn small_server(tamper: impl Fn(&Path)) -> (tempfile::TempDir, String, Arc<Cfg>) {
    let t = tempfile::tempdir().unwrap();
    let d = t.path().join("srv");
    std::fs::create_dir_all(&d).unwrap();
    for f in ["theolib.json", "theolib-bible-etc.db.gz", "theolib-orig.db.gz"] {
        std::fs::copy(real_source().join(f), d.join(f)).unwrap();
    }
    tamper(&d);
    let cfg = Arc::new(Cfg::default());
    let url = serve(d, cfg.clone());
    (t, url, cfg)
}

#[test]
fn tampered_files_rejected() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    // 압축 파일 1바이트 변경
    let (t, url, _) = small_server(|d| {
        let p = d.join("theolib-bible-etc.db.gz");
        let mut b = std::fs::read(&p).unwrap();
        let m = b.len() / 2;
        b[m] ^= 1;
        std::fs::write(&p, b).unwrap();
    });
    let home = Home::at(t.path().join("home"));
    let e = source::add(&home, &url, Some(&["bible-etc".to_string()]), &[], &mut |_, _, _| {}).unwrap_err().to_string();
    println!("변조 거부 문구: {e}");
    assert!(e.contains("SHA-256"));
    assert!(!home.db_path(source::SID, "bible-etc").exists());
    // 선언의 db_sha256 변경
    let (t, url, _) = small_server(|d| {
        let p = d.join("theolib.json");
        let s = std::fs::read_to_string(&p).unwrap();
        let b = s.find("\"bible-etc\"").unwrap();
        let i = b + s[b..].find("\"db_sha256\"").unwrap();
        let mut s2 = s.clone();
        let j = i + s[i..].find(": \"").unwrap() + 3;
        s2.replace_range(j..j + 1, if &s[j..j + 1] == "0" { "1" } else { "0" });
        std::fs::write(&p, s2).unwrap();
    });
    let home = Home::at(t.path().join("home"));
    let all: Vec<String> = source::fetch_declaration(&url).unwrap().files.iter().map(|f| f.id.clone()).collect();
    let mut any_err = false;
    for id in all.iter().filter(|i| *i == "bible-etc" || *i == "orig") {
        if let Err(e) = source::add(&home, &url, Some(&[id.clone()]), &[], &mut |_, _, _| {}) {
            assert!(e.to_string().contains("SHA-256"));
            assert!(!home.db_path(source::SID, id).exists());
            any_err = true;
        }
    }
    assert!(any_err);
}

#[test]
fn resume_after_cut() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let (t, url, cfg) = small_server(|_| {});
    cfg.cut_once.lock().unwrap().insert("theolib-bible-etc.db.gz".into(), 5_000_000);
    let home = Home::at(t.path().join("home"));
    let ids = ["bible-etc".to_string()];
    let e = source::add(&home, &url, Some(&ids), &[], &mut |_, _, _| {}).unwrap_err().to_string();
    println!("끊김 문구: {e}");
    assert!(e.contains("이어받") && !home.db_path(source::SID, "bible-etc").exists());
    let part = home.source_dir(source::SID).join("bible-etc.db.gz.part");
    assert!(part.exists() && std::fs::metadata(&part).unwrap().len() >= 4_000_000);
    let mut first = u64::MAX;
    source::add(&home, &url, Some(&ids), &[], &mut |l, d, _| {
        if l.contains("받는 중") && first == u64::MAX {
            first = d;
        }
    })
    .unwrap();
    println!("이어받기 시작 위치 {first} 바이트");
    assert!(first >= 4_000_000);
    assert!(cfg.log.lock().unwrap().iter().any(|(p, r, c)| p.contains("bible-etc") && r.starts_with("bytes=") && *c == 206));
    assert!(home.db_path(source::SID, "bible-etc").exists());
}

#[test]
fn distinct_errors() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let (_t, url, cfg) = small_server(|_| {});
    let bad = url.replace("theolib.json", "nope.json");
    let e404 = source::fetch_declaration(&bad).unwrap_err().to_string();
    *cfg.status.lock().unwrap() = Some(503);
    let e503 = source::fetch_declaration(&url).unwrap_err().to_string();
    *cfg.status.lock().unwrap() = None;
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let econn = source::fetch_declaration(&format!("http://127.0.0.1:{port}/theolib.json")).unwrap_err().to_string();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("theolib.json"), "<html>hi</html>").unwrap();
    let url2 = serve(dir.path().to_path_buf(), Arc::new(Cfg::default()));
    let efmt = source::fetch_declaration(&url2).unwrap_err().to_string();
    println!("404: {e404}\n503: {e503}\n연결: {econn}\n형식: {efmt}");
    assert!(e404.contains("404") && e503.contains("503") && econn.contains("연결하지 못") && efmt.contains("형식"));
    for e in [&e404, &e503, &econn, &efmt] {
        assert!(!e.contains("127.0.0.1"));
    }
}

#[test]
fn partial_install_and_remove() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let (t, url, _) = small_server(|_| {});
    let home = Home::at(t.path().join("home"));
    source::add(&home, &url, Some(&["orig".to_string()]), &[], &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    assert!(r.versions().unwrap().iter().all(|v| v.file == "orig"));
    assert!(!r.lex("G25").unwrap().is_empty());
    assert!(r.chapter(44, 24, &["개역개정S".into()]).unwrap().len() > 10);
    source::add(&home, &url, Some(&["bible-etc".to_string()]), &[], &mut |_, _, _| {}).unwrap();
    assert!(search::status(&home).pending.contains(&"bible-etc".to_string()));
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    assert!(search::status(&home).ready);
    let up = source::sync(&home, &mut |_, _, _| {}).unwrap();
    assert!(up.is_empty());
    source::remove(&home).unwrap();
    assert!(!home.source_dir(source::SID).exists());
    assert!(source::list_sources(&home).is_empty());
}

fn free_source() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../free-source")
}

#[test]
fn free_pack_kjv_and_strong() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let home = Home::at(t.path().join("home"));
    let url = serve(free_source(), Arc::new(Cfg::default()));
    let d = source::fetch_declaration(&url).unwrap();
    assert!(d.title.contains("기본 자료"));
    assert!(d.files.iter().all(|f| f.contents.is_some()));
    let t0 = Instant::now();
    let st = source::add(&home, &url, None, &[], &mut |_, _, _| {}).unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    println!("기본 자료 설치+색인 {:.1}초, 묶음 {:?}", t0.elapsed().as_secs_f64(), st.installed);
    let r = Reader::open(&home).unwrap();
    let vs = r.versions().unwrap();
    println!("기본 자료 번역본 {:?}", vs.iter().map(|v| v.id.as_str()).collect::<Vec<_>>());
    let rows = r.chapter(44, 24, &["개역한글".into(), "KJV1769".into(), "KJV_S".into()]).unwrap();
    let v10 = rows.iter().find(|x| x.v == 10).unwrap();
    assert!(v10.texts[0].1.starts_with("총독이 바울에게"));
    assert!(v10.texts[1].1.to_lowercase().contains("governor"));
    let toks = theolib_core::reader::code_tokens(&v10.texts[2].1);
    assert!(toks.iter().any(|x| x.1.as_deref() == Some("G611")));
    let l = r.lex("G611").unwrap();
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].dict, "HebGrkEn");
    let items = r.items().unwrap();
    let ko = items.iter().find(|p| p.pack == "bible-free").unwrap().items.iter().find(|i| i.key == "v:개역한글").unwrap();
    assert!(ko.license.contains("보호기간"));
    let b = search::search(&home, "governor", "bible", &["KJV1769".into()], 10).unwrap();
    assert!(!b.is_empty());
    source::set_hidden(&home, vec!["v:KJV1769".into(), "d:HebGrkEn".into()]).unwrap();
    let r = Reader::open(&home).unwrap();
    assert!(!r.versions().unwrap().iter().any(|v| v.id == "KJV1769"));
    assert!(r.lex("G611").unwrap().is_empty());
    let b = search::search(&home, "governor", "bible", &["KJV1769".into()], 10).unwrap();
    assert!(b.iter().all(|h| h.src != "KJV1769"));
    let before = std::fs::metadata(home.db_path(source::SID, "bible-free")).unwrap().len();
    let saved = source::prune_hidden(&home).unwrap();
    let after = std::fs::metadata(home.db_path(source::SID, "bible-free")).unwrap().len();
    println!("지워 줄이기: {before} → {after} 바이트 (줄어든 합계 {saved})");
    assert!(after < before && saved > 0);
    assert!(source::load_state(&home, source::SID).unwrap().pruned.contains(&"bible-free".to_string()));
}

#[test]
fn comm_only_and_merge_sources() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let home = Home::at(t.path().join("home"));
    let real = serve(real_source(), Arc::new(Cfg::default()));
    let free = serve(free_source(), Arc::new(Cfg::default()));
    source::add(&home, &real, Some(&["comm".to_string()]), &["s:BST주석".to_string()], &mut |_, _, _| {}).unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    assert!(!r.has("bible") && r.versions().unwrap().is_empty());
    let h = search::search(&home, "뉴산토스", "comm", &[], 20).unwrap();
    assert!(h.iter().any(|x| x.bk == 44 && x.ch == 24 && x.v == 10));
    assert!(!r.comm_names().unwrap().iter().any(|c| c.0 == "BST주석"));
    source::add(&home, &free, None, &[], &mut |_, _, _| {}).unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let st = source::load_state(&home, source::SID).unwrap();
    assert_eq!(st.sources.len(), 2);
    println!("합친 출처 {}개, 묶음 {:?}", st.sources.len(), st.installed);
    let r = Reader::open(&home).unwrap();
    assert!(r.versions().unwrap().iter().any(|v| v.id == "KJV1611"));
    assert!(!r.comm_for(44, 24, Some(10)).unwrap().is_empty());
    let st_txt = std::fs::read_to_string(home.state_path(source::SID)).unwrap();
    assert!(!st_txt.contains("127.0.0.1"));
    assert!(source::sync(&home, &mut |_, _, _| {}).unwrap().is_empty());
    source::remove_pack(&home, "bible-free").unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    assert!(!home.db_path(source::SID, "bible-free").exists());
}

/// 실제 GitHub 릴리스 시험: THEOLIB_TEST_GH_URL 이 있을 때만(토큰이 든 주소라 값은 출력하지 않는다).
#[test]
fn github_comm_only() {
    let Ok(url) = std::env::var("THEOLIB_TEST_GH_URL") else { return };
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let home = Home::at(t.path().join("home"));
    let t0 = Instant::now();
    let d = source::fetch_declaration(&url).unwrap();
    assert!(d.files.iter().any(|f| f.id == "comm" && f.contents.is_some()));
    source::add(&home, &url, Some(&["comm".to_string()]), &[], &mut |_, _, _| {}).unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let h = search::search(&home, "뉴산토스", "comm", &[], 20).unwrap();
    println!("GitHub 주석 묶음만 받기+색인 {:.1}초, 주석 검색 {}건", t0.elapsed().as_secs_f64(), h.len());
    assert!(!h.is_empty());
    let state = std::fs::read_to_string(home.state_path(source::SID)).unwrap();
    assert!(state.contains("github.com/hahadark/theolib-data") && !state.contains('@'));
}

fn items_dir(n: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../").join(n)
}

fn s(x: &str) -> String {
    x.to_string()
}

#[test]
fn items_free_add_remove_incremental() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let home = Home::at(t.path().join("home"));
    let url = serve(items_dir("items-free"), Arc::new(Cfg::default()));
    let d = source::fetch_declaration(&url).unwrap();
    assert_eq!(d.layout, "items");
    assert_eq!(d.files.len(), 9);
    // 번역본 1종만 받기
    source::add_items(&home, &url, &[s("bible:개역한글")], &mut |_, _, _| {}).unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    assert_eq!(r.versions().unwrap().len(), 1);
    assert_eq!(r.chapter(44, 24, &[s("개역한글")]).unwrap().iter().find(|x| x.v == 10).unwrap().texts[0].1.starts_with("총독이 바울에게"), true);
    // 추가로 2종 더 받기 → 색인은 새 항목 분만
    source::add_items(&home, &url, &[s("bible:KJV1769"), s("code:KJV_S"), s("lex:HebGrkEn"), s("bible:개역한글")], &mut |_, _, _| {}).unwrap();
    let mut labels = std::collections::BTreeSet::new();
    search::build_index(&home, &mut |l, _, _| {
        labels.insert(l.to_string());
    })
    .unwrap();
    println!("추가 색인 단계: {:?}", labels);
    assert!(labels.iter().all(|l| l.contains("KJV1769")));
    let r = Reader::open(&home).unwrap();
    let ids: Vec<_> = r.versions().unwrap().iter().map(|v| v.id.clone()).collect();
    assert_eq!(ids, ["개역한글", "KJV1769", "KJV_S"]);
    assert_eq!(r.lex("G611").unwrap().len(), 1);
    let b = search::search(&home, "governor", "bible", &[s("KJV1769")], 10).unwrap();
    assert!(!b.is_empty());
    // 삭제 후 검색에서 빠짐
    source::remove_items(&home, &[s("bible:KJV1769")]).unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    assert!(!r.versions().unwrap().iter().any(|v| v.id == "KJV1769"));
    let b = search::search(&home, "governor", "bible", &[s("KJV1769")], 10).unwrap();
    assert!(b.is_empty());
    let st = source::load_state(&home, source::SID).unwrap();
    assert_eq!(st.items.len(), 3);
    assert!(!search::status(&home).pending.iter().any(|_| true));
    // 모두 지우면 통합 DB 파일도 사라짐
    source::remove_items(&home, &st.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>()).unwrap();
    assert!(!home.db_path(source::SID, "bible-i").exists() && !home.db_path(source::SID, "orig-i").exists());
}

#[test]
fn items_sync_only_changed() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let dir = t.path().join("srv");
    std::fs::create_dir_all(&dir).unwrap();
    for e in std::fs::read_dir(items_dir("items-free")).unwrap().flatten() {
        std::fs::copy(e.path(), dir.join(e.file_name())).unwrap();
    }
    let cfg = Arc::new(Cfg::default());
    let url = serve(dir.clone(), cfg.clone());
    let home = Home::at(t.path().join("home"));
    let ids = [s("bible:Darby"), s("bible:WEB"), s("bible:YLT")];
    source::add_items(&home, &url, &ids, &mut |_, _, _| {}).unwrap();
    cfg.log.lock().unwrap().clear();
    assert!(source::sync(&home, &mut |_, _, _| {}).unwrap().is_empty());
    assert!(cfg.log.lock().unwrap().iter().all(|(p, _, _)| p == "theolib.json"));
    // Darby 항목의 선언을 NHEB 파일 내용으로 바꾼다(sha 변경)
    let txt = std::fs::read_to_string(dir.join("theolib.json")).unwrap();
    let mut j: serde_json::Value = serde_json::from_str(&txt).unwrap();
    let files = j["files"].as_array().unwrap().clone();
    let nheb = files.iter().find(|f| f["id"] == "bible:NHEB").unwrap().clone();
    for f in j["files"].as_array_mut().unwrap() {
        if f["id"] == "bible:Darby" {
            for k in ["url", "bytes", "sha256", "db_bytes", "db_sha256"] {
                f[k] = nheb[k].clone();
            }
        }
    }
    std::fs::write(dir.join("theolib.json"), serde_json::to_vec(&j).unwrap()).unwrap();
    cfg.log.lock().unwrap().clear();
    let up = source::sync(&home, &mut |_, _, _| {}).unwrap();
    println!("갱신된 항목: {:?}, 받은 파일 요청: {:?}", up, cfg.log.lock().unwrap().iter().map(|x| x.0.clone()).collect::<Vec<_>>());
    assert_eq!(up, vec![s("bible:Darby")]);
    let gz: Vec<_> = cfg.log.lock().unwrap().iter().filter(|x| x.0.ends_with(".gz")).map(|x| x.0.clone()).collect();
    assert_eq!(gz.len(), 1);
}

#[test]
fn items_full_all_timing() {
    let dir = items_dir("items-full");
    if !dir.join("theolib.json").exists() {
        return;
    }
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let home = Home::at(t.path().join("home"));
    let url = serve(dir, Arc::new(Cfg::default()));
    let d = source::fetch_declaration(&url).unwrap();
    let ids: Vec<String> = d.files.iter().map(|f| f.id.clone()).collect();
    let t0 = Instant::now();
    source::add_items(&home, &url, &ids, &mut |_, _, _| {}).unwrap();
    let t_dl = t0.elapsed().as_secs_f64();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let t_all = t0.elapsed().as_secs_f64();
    println!("전체 {}항목 받기 {:.1}초, 색인까지 {:.1}초", ids.len(), t_dl, t_all);
    let r = Reader::open(&home).unwrap();
    let vs = r.versions().unwrap();
    assert_eq!(vs.iter().filter(|v| v.kind == "text").count(), 82);
    let rows = r.chapter(44, 24, &[s("개역개정")]).unwrap();
    assert!(rows.iter().find(|x| x.v == 10).unwrap().texts[0].1.starts_with("총독이"));
    assert!(r.comm_for(44, 24, Some(10)).unwrap().iter().any(|n| n.comm_name == "매튜헨리"));
    assert_eq!(r.parse(44, 24, 10).unwrap().len(), 24);
    assert_eq!(r.lex("G611").unwrap().len(), 2);
    let c = search::search(&home, "뉴산토스", "comm", &[], 20).unwrap();
    assert!(c.iter().any(|h| h.bk == 44 && h.ch == 24 && h.v == 10));
    let b = search::search(&home, "총독", "bible", &[s("개역개정")], 100).unwrap();
    assert_eq!(b.len(), 56);
    // 주석 1종 삭제 → 검색에서 빠짐
    let charis: Vec<String> = ids.iter().filter(|i| i.starts_with("comm:카리스종합주석:")).cloned().collect();
    // 카리스 책 항목 수는 반영이 늘면 같이 는다: 선언에 있는 수와 비교한다.
    let want = d.files.iter().filter(|f| f.id.starts_with("comm:카리스종합주석:")).count();
    assert_eq!(charis.len(), want);
    source::remove_items(&home, &charis).unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let c = search::search(&home, "뉴산토스", "comm", &[], 20).unwrap();
    assert!(c.iter().all(|h| h.src != "카리스종합주석"));
}

#[test]
fn comm_split_books_merge() {
    let dir = items_dir("items-full");
    if !dir.join("theolib.json").exists() {
        return;
    }
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let srv = t.path().join("srv");
    std::fs::create_dir_all(&srv).unwrap();
    let txt = std::fs::read_to_string(dir.join("theolib.json")).unwrap();
    let mut j: serde_json::Value = serde_json::from_str(&txt).unwrap();
    let all = j["files"].as_array().unwrap().clone();
    let by = |id: &str| all.iter().find(|f| f["id"] == id).unwrap().clone();
    let (acts, rom, g1) = (by("comm:카리스종합주석:44"), by("comm:카리스종합주석:45"), by("comm:카리스종합주석:1"));
    // 선언 구조: 카리스 33책, 매튜헨리 66책, 책별 칸
    let n_of = |sid: &str| all.iter().filter(|f| f["series"] == sid).count();
    let want = all.iter().filter(|f| f["series"] == "카리스종합주석").count();
    assert!(want >= 33 && n_of("카리스종합주석") == want);
    assert_eq!(n_of("매튜헨리"), 66);
    assert!(acts["series_bytes"].as_u64().unwrap() > 80_000_000 && acts["book"] == "사도행전" && acts["bk"] == 44 && acts["default"] == true);
    let sizes: Vec<u64> = all.iter().filter(|f| f["series"] == "카리스종합주석").map(|f| f["bytes"].as_u64().unwrap()).collect();
    println!("카리스 책별 항목 35개, 크기 {}~{} 바이트, 합 {}", sizes.iter().min().unwrap(), sizes.iter().max().unwrap(), sizes.iter().sum::<u64>());
    for f in [&acts, &rom, &g1] {
        let u = f["url"].as_str().unwrap();
        std::fs::copy(dir.join(u), srv.join(u)).unwrap();
    }
    j["files"] = serde_json::json!([acts.clone(), rom.clone(), g1.clone()]);
    std::fs::write(srv.join("theolib.json"), serde_json::to_vec(&j).unwrap()).unwrap();
    let cfg = Arc::new(Cfg::default());
    let url = serve(srv.clone(), cfg.clone());
    let home = Home::at(t.path().join("home"));
    // 사도행전만 받기
    source::add_items(&home, &url, &[s("comm:카리스종합주석:44")], &mut |_, _, _| {}).unwrap();
    println!("사도행전 항목만 받은 크기 {} 바이트(선언 {})", cfg.sent.load(std::sync::atomic::Ordering::SeqCst), acts["bytes"]);
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    let ns = r.comm_for(44, 24, None).unwrap();
    assert!(ns.len() > 5 && ns.iter().all(|n| n.comm == "카리스종합주석"));
    println!("행 24장 장 전체 주석 {}건", ns.len());
    assert!(r.comm_for(45, 1, None).unwrap().is_empty());
    let ss = r.comm_series().unwrap();
    assert_eq!(ss.len(), 1);
    assert_eq!(ss[0].id, "카리스종합주석");
    assert!(ss[0].books.len() >= 33, "카리스 책 수 {} < 33", ss[0].books.len());
    assert_eq!(ss[0].have, vec![44]);
    assert!(ss[0].books.contains(&45) && ss[0].books.contains(&1));
    let c = search::search(&home, "총독", "comm", &[], 50).unwrap();
    assert!(!c.is_empty() && c.iter().all(|h| h.src == "카리스종합주석" && h.bk == 44));
    // 로마서 추가: 합쳐서 한 시리즈
    source::add_items(&home, &url, &[s("comm:카리스종합주석:45")], &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    assert!(!r.comm_for(45, 1, None).unwrap().is_empty() && !r.comm_for(44, 24, None).unwrap().is_empty());
    assert_eq!(r.comm_names().unwrap().len(), 1);
    assert_eq!(r.comm_series().unwrap()[0].have, vec![44, 45]);
    // 사도행전 삭제 → 그 책만 빠짐
    source::remove_items(&home, &[s("comm:카리스종합주석:44")]).unwrap();
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    assert!(r.comm_for(44, 24, None).unwrap().is_empty());
    assert!(!r.comm_for(45, 1, None).unwrap().is_empty());
    assert_eq!(r.comm_series().unwrap()[0].have, vec![45]);
    assert!(search::search(&home, "총독", "comm", &[], 50).unwrap().iter().all(|h| h.bk != 44));
    // 갱신: 로마서 항목의 선언만 창세기 파일로 바꾸면 그 항목만 다시 받는다
    source::add_items(&home, &url, &[s("comm:카리스종합주석:44")], &mut |_, _, _| {}).unwrap();
    let mut j2 = j.clone();
    for f in j2["files"].as_array_mut().unwrap() {
        if f["id"] == "comm:카리스종합주석:45" {
            for k in ["url", "bytes", "sha256", "db_bytes", "db_sha256"] {
                f[k] = g1[k].clone();
            }
        }
    }
    std::fs::write(srv.join("theolib.json"), serde_json::to_vec(&j2).unwrap()).unwrap();
    cfg.log.lock().unwrap().clear();
    let up = source::sync(&home, &mut |_, _, _| {}).unwrap();
    assert_eq!(up, vec![s("comm:카리스종합주석:45")]);
    let gz: Vec<_> = cfg.log.lock().unwrap().iter().filter(|x| x.0.ends_with(".gz")).map(|x| x.0.clone()).collect();
    println!("갱신 때 받은 항목 파일: {gz:?}");
    assert_eq!(gz.len(), 1);
    let r = Reader::open(&home).unwrap();
    assert!(!r.comm_for(44, 24, None).unwrap().is_empty());
}

/// 자료 파일 샘플 폴더: THEOLIB_SAMPLES 환경변수(없으면 건너뜀). 본문은 기록하지 않는다.
#[test]
fn local_files_import() {
    let Ok(dir) = std::env::var("THEOLIB_SAMPLES") else { return };
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let home = Home::at(t.path().join("home"));
    let items = theolib_core::localfiles::scan(&[PathBuf::from(&dir)]);
    println!("인식 {}개: {:?}", items.len(), items.iter().map(|i| (i.id.clone(), i.rows, i.grp.clone())).collect::<Vec<_>>());
    assert_eq!(items.len(), 5);
    let ok: Vec<_> = items.iter().filter(|i| i.skip.is_empty()).cloned().collect();
    assert_eq!(ok.len(), 5);
    assert!(items.iter().find(|i| i.name == "KJV1769").unwrap().desc.len() > 3);
    let (done, skipped) = theolib_core::localfiles::import(&home, &ok, false, &mut |_, _, _| {}).unwrap();
    assert_eq!(done.len(), 5);
    assert!(skipped.is_empty());
    let (done2, skipped2) = theolib_core::localfiles::import(&home, &ok[..1], false, &mut |_, _, _| {}).unwrap();
    assert!(done2.is_empty() && skipped2.len() == 1);
    search::build_index(&home, &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    let rows = r.chapter(44, 24, &[s("KJV1769"), s("KJV_S"), s("WEB")]).unwrap();
    assert!(rows.iter().find(|x| x.v == 10).unwrap().texts[0].1.to_lowercase().contains("governor"));
    let web = r.chapter(44, 24, &[s("WEB")]).unwrap().len();
    let web_total = {
        let mut n = 0;
        for bk in 1..=66 {
            for ch in 1..=150 {
                n += r.chapter(bk, ch, &[s("WEB")]).unwrap().len();
            }
        }
        n
    };
    println!("WEB 총 {web_total}절(24장 {web}절)");
    assert_eq!(web_total, 31103);
    let toks = theolib_core::reader::code_tokens(&rows.iter().find(|x| x.v == 10).unwrap().texts[1].1);
    assert!(toks.iter().any(|x| x.1.as_deref() == Some("G611")));
    assert!(r.lex("G611").unwrap().iter().any(|e| e.dict == "HebGrkEn"));
    // 주석: 24:1 에 있고 24:3(행 없음)은 24:2 것을 이어 보임
    let n1 = r.comm_for(44, 24, Some(1)).unwrap();
    let n2 = r.comm_for(44, 24, Some(2)).unwrap();
    let n3 = r.comm_for(44, 24, Some(3)).unwrap();
    assert!(n1.iter().any(|n| n.comm == "Ellicott"));
    assert!(!n3.is_empty() && n3[0].body == n2[0].body && n3[0].body != n1[0].body);
    let b = search::search(&home, "governor", "bible", &[s("WEB")], 5).unwrap();
    assert!(!b.is_empty());
    let c = search::search(&home, "Felix", "comm", &[], 5).unwrap();
    assert!(!c.is_empty());
    // 찬송가 파일은 건너뜀 안내
    let hd = t.path().join("x");
    std::fs::create_dir_all(&hd).unwrap();
    std::fs::write(hd.join("찬송.hdb"), b"x").unwrap();
    std::fs::write(hd.join("망가짐.bdb"), b"not sqlite").unwrap();
    let it = theolib_core::localfiles::scan(&[hd]);
    println!("건너뜀 안내: {:?}", it.iter().map(|i| i.skip.clone()).collect::<Vec<_>>());
    assert!(it.iter().any(|i| i.skip.contains("찬송가는 아직 지원하지 않습니다")) && it.iter().all(|i| !i.skip.is_empty()));
}

/// 저장(무압축) zip 을 만든다. 이름은 UTF-8 표시를 켠다.
fn make_zip(entries: &[(&str, &[u8])], deflate: bool) -> Vec<u8> {
    use std::io::Write as _;
    let mut out = vec![];
    let mut cd = vec![];
    for (name, data) in entries {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let (method, body): (u16, Vec<u8>) = if deflate {
            let mut e = flate2::write::DeflateEncoder::new(vec![], flate2::Compression::default());
            e.write_all(data).unwrap();
            (8, e.finish().unwrap())
        } else {
            (0, data.to_vec())
        };
        let off = out.len() as u32;
        let mut lh = vec![];
        lh.extend(0x04034b50u32.to_le_bytes());
        lh.extend([20, 0, 0, 8]); // 버전, 플래그(UTF-8)
        lh.extend(method.to_le_bytes());
        lh.extend([0u8; 4]);
        lh.extend(crc.sum().to_le_bytes());
        lh.extend((body.len() as u32).to_le_bytes());
        lh.extend((data.len() as u32).to_le_bytes());
        lh.extend((name.len() as u16).to_le_bytes());
        lh.extend(0u16.to_le_bytes());
        lh.extend(name.as_bytes());
        out.extend(&lh);
        out.extend(&body);
        cd.extend(0x02014b50u32.to_le_bytes());
        cd.extend([20, 0, 20, 0, 0, 8]);
        cd.extend(method.to_le_bytes());
        cd.extend([0u8; 4]);
        cd.extend(crc.sum().to_le_bytes());
        cd.extend((body.len() as u32).to_le_bytes());
        cd.extend((data.len() as u32).to_le_bytes());
        cd.extend((name.len() as u16).to_le_bytes());
        cd.extend([0u8; 12]);
        cd.extend(off.to_le_bytes());
        cd.extend(name.as_bytes());
    }
    let cd_off = out.len() as u32;
    out.extend(&cd);
    out.extend(0x06054b50u32.to_le_bytes());
    out.extend([0u8; 4]);
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((cd.len() as u32).to_le_bytes());
    out.extend(cd_off.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

fn tiny_bdb(path: &Path, rows: &[(i64, i64, i64, &str)]) {
    let c = rusqlite::Connection::open(path).unwrap();
    c.execute_batch("CREATE TABLE Bible(id INTEGER PRIMARY KEY AUTOINCREMENT, book INTEGER, chapter INTEGER, verse INTEGER, btext VARCHAR)").unwrap();
    for r in rows {
        c.execute("INSERT INTO Bible(book,chapter,verse,btext) VALUES(?,?,?,?)", (r.0, r.1, r.2, r.3)).unwrap();
    }
}

#[test]
fn zip_range_and_fallback() {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let srv = t.path().join("srv");
    std::fs::create_dir_all(&srv).unwrap();
    tiny_bdb(&t.path().join("Tiny.bdb"), &[(44, 24, 10, "Governor beckoned"), (44, 24, 11, "Eleven")]);
    tiny_bdb(&t.path().join("Other.bdb"), &[(44, 24, 10, "Other text")]);
    let mut x = 88172645463325252u64;
    let big: Vec<u8> = (0..300_000).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x as u8 }).collect(); // 압축 안 되는 큰 항목(목록 읽기에 받으면 안 됨)
    let tiny = std::fs::read(t.path().join("Tiny.bdb")).unwrap();
    let other = std::fs::read(t.path().join("Other.bdb")).unwrap();
    let zip = make_zip(&[("dir/Big.cmp", &big), ("dir/번역본파일목록.txt", "◆ Tiny : 작은 시험 번역본\n".as_bytes()), ("dir/Tiny.bdb", &tiny), ("dir/Other.bdb", &other), ("dir/찬송.hdb", b"h")], true);
    std::fs::write(srv.join("pack.zip"), &zip).unwrap();
    let cfg = Arc::new(Cfg::default());
    let url = serve(srv.clone(), cfg.clone()).replace("theolib.json", "pack.zip");
    assert!(theolib_core::zipsrc::looks_zip(&url));
    let home = Home::at(t.path().join("home"));
    let (files, fetched, size) = theolib_core::zipsrc::preview(&home, &url).unwrap();
    println!("zip 크기 {size}, 목록 읽기에 받은 바이트 {fetched}, 항목 {:?}", files.iter().map(|f| f["id"].as_str().unwrap().to_string()).collect::<Vec<_>>());
    assert_eq!(size as usize, zip.len());
    assert!(files.iter().any(|f| f["id"] == "bible:Tiny" && f["license"] == "작은 시험 번역본"));
    assert!(files.iter().any(|f| !f["skip"].as_str().unwrap().is_empty()));
    // 고른 항목 하나만 받기: 받은 바이트는 그 항목 압축 크기 근처
    cfg.sent.store(0, std::sync::atomic::Ordering::SeqCst);
    source::add_items(&home, &url, &[s("bible:Tiny")], &mut |_, _, _| {}).unwrap();
    let sent = cfg.sent.load(std::sync::atomic::Ordering::SeqCst);
    println!("항목 1개 받기에 보낸 바이트 {sent}");
    assert!(sent < 200_000);
    let r = Reader::open(&home).unwrap();
    assert!(r.chapter(44, 24, &[s("Tiny")]).unwrap()[0].texts[0].1.contains("Governor"));
    // 갱신: 바뀐 것 없음
    assert!(source::sync(&home, &mut |_, _, _| {}).unwrap().is_empty());
    // 중앙 목록의 CRC 가 바뀐 항목만 갱신
    let zip2 = make_zip(&[("dir/Tiny.bdb", &other), ("dir/Other.bdb", &other)], true);
    std::fs::write(srv.join("pack.zip"), &zip2).unwrap();
    let up = source::sync(&home, &mut |_, _, _| {}).unwrap();
    assert_eq!(up, vec![s("bible:Tiny")]);
    // Range 를 안 주는 서버: 전체를 받아 고른 것만 푼다
    cfg.no_range.store(true, std::sync::atomic::Ordering::SeqCst);
    let home2 = Home::at(t.path().join("home2"));
    source::add_items(&home2, &url, &[s("bible:Other")], &mut |_, _, _| {}).unwrap();
    assert!(Reader::open(&home2).unwrap().chapter(44, 24, &[s("Other")]).unwrap()[0].texts[0].1.contains("Other text"));
    // 깨진 항목은 CRC 로 거부
    cfg.no_range.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut bad = zip.clone();
    let n = bad.len();
    bad[n / 3] ^= 0xff;
    std::fs::write(srv.join("pack.zip"), &bad).unwrap();
    let home3 = Home::at(t.path().join("home3"));
    let r = source::add_items(&home3, &url, &[s("bible:Tiny"), s("bible:Other")], &mut |_, _, _| {});
    println!("깨진 zip 결과: {:?}", r.as_ref().err().map(|e| e.to_string()));
}

/// 실제 배포 zip 을 로컬 Range 서버로 띄운 주소(THEOLIB_ZIP_URL)가 있을 때만. 본문은 기록하지 않는다.
#[test]
fn zip_real_url() {
    let Ok(url) = std::env::var("THEOLIB_ZIP_URL") else { return };
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let home = Home::at(t.path().join("home"));
    let t0 = Instant::now();
    let (files, fetched, size) = theolib_core::zipsrc::preview(&home, &url).unwrap();
    println!("실제 zip: 전체 {size}바이트, 목록 {}개 인식, 목록 읽기에 받은 바이트 {fetched}, {:.2}초", files.len(), t0.elapsed().as_secs_f64());
    assert!(fetched < 2_000_000);
    let kjv = files.iter().find(|f| f["id"] == "bible:KJV1769").unwrap();
    let csize = kjv["bytes"].as_u64().unwrap();
    source::add_items(&home, &url, &[s("bible:KJV1769")], &mut |_, _, _| {}).unwrap();
    let r = Reader::open(&home).unwrap();
    assert!(r.chapter(44, 24, &[s("KJV1769")]).unwrap().iter().any(|x| x.v == 10));
    println!("KJV1769 한 항목 받기 완료(압축 크기 {csize}바이트), {:.2}초", t0.elapsed().as_secs_f64());
}

/// 폴더 통째 인식 시간(THEOLIB_FOLDER 가 있을 때만, 읽기 전용, 내용은 기록하지 않음)
#[test]
fn scan_folder_timing() {
    let Ok(dir) = std::env::var("THEOLIB_FOLDER") else { return };
    let t0 = Instant::now();
    let items = theolib_core::localfiles::scan(&[PathBuf::from(dir)]);
    let skipped = items.iter().filter(|i| !i.skip.is_empty()).count();
    println!("폴더 인식 {}개(건너뜀 {skipped}개), {:.2}초", items.len(), t0.elapsed().as_secs_f64());
}
