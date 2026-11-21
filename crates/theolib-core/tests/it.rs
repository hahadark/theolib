use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Instant;
use theolib_core::reader::Reader;
use theolib_core::{Home, search, source};

fn dev_source() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../dev-source")
}

/// 폴더를 127.0.0.1에서 서빙하는 간이 서버. 주소를 돌려준다.
fn serve(dir: PathBuf) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { continue };
            let dir = dir.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
                match std::fs::read(dir.join(path)) {
                    Ok(b) => {
                        let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len());
                        let _ = s.write_all(&b);
                    }
                    Err(_) => {
                        let _ = write!(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
            });
        }
    });
    format!("http://127.0.0.1:{port}/theolib.json")
}

fn setup() -> (tempfile::TempDir, Home, String) {
    unsafe { std::env::set_var("THEOLIB_KEYSTORE", "file") };
    let t = tempfile::tempdir().unwrap();
    let home = Home::at(t.path().join("home"));
    let url = serve(dev_source());
    (t, home, url)
}

fn add_all(home: &Home, url: &str) -> source::State {
    source::add(home, url, None, &mut |_, _, _| {}).unwrap()
}

const SID: &str = "tg-bible-view";

#[test]
fn rows_match_declaration() {
    let (_t, home, url) = setup();
    let st = add_all(&home, &url);
    let r = Reader::open(&home, SID).unwrap();
    let s = r.stats().unwrap();
    for f in &st.decl.files {
        if let Some(v) = f.verses { assert_eq!(s["verse"], v); }
        if let Some(v) = f.words { assert_eq!(s["parse"], v); }
        if let Some(v) = f.lex { assert_eq!(s["lex"], v); }
        if let Some(v) = f.notes { assert_eq!(s["note"], v); }
        if let Some(v) = f.articles { assert_eq!(s["article"], v); }
    }
    println!("행 수: {s:?}");
}

#[test]
fn acts_24_10_text_comm_and_lexicon() {
    let (_t, home, url) = setup();
    add_all(&home, &url);
    let r = Reader::open(&home, SID).unwrap();
    let bk = r.resolve_book("행").unwrap();
    assert_eq!(bk, 44);
    assert_eq!(r.parse_ref("행 24:10"), Some((44, 24, Some(10))));
    assert_eq!(r.parse_ref("사도행전 24"), Some((44, 24, None)));
    let ch = r.chapter(44, 24, &["개역개정".into()]).unwrap();
    let v10 = ch.iter().find(|x| x.v == 10).unwrap();
    assert!(v10.texts[0].1.contains("총독이"), "{}", v10.texts[0].1);
    let notes = r.comm_for(44, 24, Some(10)).unwrap();
    assert!(notes.iter().any(|n| n.comm_name.contains("카리스")), "카리스 주석 없음");
    println!("24:10 주석 {}건: {:?}", notes.len(), notes.iter().map(|n| n.comm_name.clone()).collect::<std::collections::BTreeSet<_>>());
    // 원전 분해 낱말 -> 사전
    let words = r.parse(44, 24, 10).unwrap();
    assert!(!words.is_empty());
    let found: Vec<_> = words.iter().filter(|w| !w.code.is_empty() && !r.lex(&w.code).unwrap().is_empty()).collect();
    assert!(!found.is_empty(), "사전 항목 없음");
    println!("24:10 낱말 {}개 중 사전 항목 있는 낱말 {}개", words.len(), found.len());
}

fn tampered_copy(t: &Path, f: impl Fn(&Path)) -> String {
    let d = t.join("bad");
    std::fs::create_dir_all(&d).unwrap();
    for e in std::fs::read_dir(dev_source()).unwrap().flatten() {
        let n = e.file_name();
        if n.to_str().unwrap() != "sample-acts.json" {
            std::fs::copy(e.path(), d.join(&n)).unwrap();
        }
    }
    f(&d);
    serve(d)
}

#[test]
fn tampered_file_is_rejected() {
    let (t, home, _) = setup();
    // 압축 파일 한 바이트 변경
    let url = tampered_copy(t.path(), |d| {
        let p = d.join("bible.db.gz");
        let mut b = std::fs::read(&p).unwrap();
        let m = b.len() / 2;
        b[m] ^= 1;
        std::fs::write(p, b).unwrap();
    });
    let e = source::add(&home, &url, Some(&["bible".into()]), &mut |_, _, _| {}).unwrap_err();
    println!("거부 사유: {e}");
    assert!(!home.db_path(SID, "bible").exists());
    // 선언의 db_sha256이 다른 경우(압축은 정상)
    let url2 = tampered_copy(t.path(), |d| {
        let p = d.join("theolib.json");
        let s = std::fs::read_to_string(&p).unwrap();
        let bad = s.replacen("e1b42f0e7024007071596c05f465ce11e612fa32bc9adafcc8deac870228d662", "e1b42f0e7024007071596c05f465ce11e612fa32bc9adafcc8deac870228d663", 1);
        std::fs::write(p, bad).unwrap();
    });
    let e2 = source::add(&home, &url2, Some(&["bible".into()]), &mut |_, _, _| {}).unwrap_err();
    println!("거부 사유2: {e2}");
    assert!(!home.db_path(SID, "bible").exists());
    // 임시 파일이 남지 않는다
    let left: Vec<_> = std::fs::read_dir(home.source_dir(SID)).map(|r| r.flatten().map(|e| e.file_name()).collect()).unwrap_or_default();
    assert!(left.iter().all(|n: &std::ffi::OsString| !n.to_string_lossy().ends_with(".part")), "{left:?}");
}

#[test]
fn failed_update_keeps_old_file() {
    let (t, home, url) = setup();
    add_all(&home, &url);
    let before = std::fs::read(home.db_path(SID, "bible")).unwrap();
    let bad = tampered_copy(t.path(), |d| {
        let p = d.join("bible.db.gz");
        let mut b = std::fs::read(&p).unwrap();
        b[100] ^= 1;
        std::fs::write(p, b).unwrap();
    });
    assert!(source::add(&home, &bad, Some(&["bible".into()]), &mut |_, _, _| {}).is_err());
    assert_eq!(before, std::fs::read(home.db_path(SID, "bible")).unwrap());
}

#[test]
fn remove_deletes_everything() {
    let (_t, home, url) = setup();
    add_all(&home, &url);
    assert!(home.db_path(SID, "comm").exists() && home.index_path(SID).exists());
    source::remove(&home, SID).unwrap();
    assert!(!home.source_dir(SID).exists());
    assert!(source::list_sources(&home).is_empty());
    assert!(!home.secrets_file().exists() || !std::fs::read_to_string(home.secrets_file()).unwrap().contains("127.0.0.1"));
}

#[test]
fn sync_only_changed_files() {
    let (_t, home, url) = setup();
    add_all(&home, &url);
    let mut touched = vec![];
    let u = source::sync(&home, SID, &mut |id, _, _| { if !touched.contains(&id.to_string()) { touched.push(id.to_string()) } }).unwrap();
    assert!(u.is_empty() && touched.is_empty(), "{u:?}");
}

#[test]
fn timing_chapter_and_search() {
    let (_t, home, url) = setup();
    add_all(&home, &url);
    let r = Reader::open(&home, SID).unwrap();
    let t0 = Instant::now();
    let rows = r.chapter(44, 24, &["개역개정".into(), "새번역".into(), "ESV".into()]).unwrap();
    let _ = r.comm_for(44, 24, Some(10)).unwrap();
    let chap = t0.elapsed();
    assert!(!rows.is_empty());
    let t1 = Instant::now();
    let b = search::search(&home, SID, "총독", "bible", 50).unwrap();
    let sb = t1.elapsed();
    let t2 = Instant::now();
    let c = search::search(&home, SID, "벨릭스", "comm", 50).unwrap();
    let sc = t2.elapsed();
    println!("장 열기(본문 3종+주석) {chap:?}, 성경 검색 {sb:?}({}건), 주석 검색 {sc:?}({}건)", b.len(), c.len());
    assert!(chap.as_secs_f64() < 0.2 && sb.as_secs_f64() < 1.0 && sc.as_secs_f64() < 1.0);
    assert!(!b.is_empty() && !c.is_empty());
}

#[test]
fn join_url_cases() {
    assert_eq!(source::join_url("https://h/app/K/theolib.json", "packs/a.gz"), "https://h/app/K/packs/a.gz");
    assert_eq!(source::join_url("https://h/app/K/theolib.json?x=1", "/p/a.gz"), "https://h/p/a.gz");
    assert_eq!(source::join_url("https://h/a/t.json", "https://o/x"), "https://o/x");
}
