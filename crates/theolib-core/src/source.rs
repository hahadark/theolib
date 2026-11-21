//! 출처(선언 파일) 읽기, 내려받기, 검증, 원자적 교체, 동기화, 삭제.
use crate::{Home, search, secret};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;

pub const FORMAT: &str = "theolib-db/1";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileDecl {
    pub id: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub db_bytes: u64,
    pub db_sha256: String,
    #[serde(default = "one")]
    pub schema: i64,
    #[serde(default)]
    pub verses: Option<i64>,
    #[serde(default)]
    pub words: Option<i64>,
    #[serde(default)]
    pub lex: Option<i64>,
    #[serde(default)]
    pub notes: Option<i64>,
    #[serde(default)]
    pub articles: Option<i64>,
    #[serde(default)]
    pub versions: Vec<String>,
}
fn one() -> i64 {
    1
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Declaration {
    pub format: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub notice: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub scope: String,
    pub files: Vec<FileDecl>,
}

/// 디스크에 남기는 상태. 주소(개인키)는 넣지 않는다.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct State {
    pub decl: Declaration,
    pub installed: Vec<String>,
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 선언 주소 기준으로 상대 주소를 푼다.
pub fn join_url(base: &str, rel: &str) -> String {
    if rel.contains("://") {
        return rel.to_string();
    }
    let no_q = base.split(['?', '#']).next().unwrap_or(base);
    let scheme_end = no_q.find("://").map(|i| i + 3).unwrap_or(0);
    if let Some(r) = rel.strip_prefix('/') {
        let host_end = no_q[scheme_end..].find('/').map(|i| i + scheme_end).unwrap_or(no_q.len());
        return format!("{}/{}", &no_q[..host_end], r);
    }
    match no_q[scheme_end..].rfind('/') {
        Some(i) => format!("{}{}", &no_q[..scheme_end + i + 1], rel),
        None => format!("{}/{}", no_q, rel),
    }
}

fn redact(msg: String, url: &str) -> String {
    let mut m = msg.replace(url, "<주소>");
    if let Some(i) = url.find("://") {
        if let Some(j) = url[i + 3..].find('/') {
            let path = &url[i + 3 + j..];
            if path.len() > 1 {
                m = m.replace(path, "/…");
            }
        }
    }
    m
}

fn http_get(url: &str) -> Result<ureq::http::Response<ureq::Body>> {
    ureq::get(url).call().map_err(|e| anyhow::anyhow!(redact(e.to_string(), url)))
}

pub fn fetch_declaration(url: &str) -> Result<Declaration> {
    let mut body = String::new();
    http_get(url)?.into_body().into_reader().take(8 << 20).read_to_string(&mut body)?;
    let d: Declaration = serde_json::from_str(&body).context("선언 파일을 읽지 못했습니다")?;
    if d.format != FORMAT {
        bail!("지원하지 않는 선언 형식입니다: {}", d.format);
    }
    if d.id.is_empty() || !d.id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        bail!("출처 id가 올바르지 않습니다");
    }
    for f in &d.files {
        if f.id.is_empty() || !f.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            bail!("파일 id가 올바르지 않습니다");
        }
    }
    Ok(d)
}

pub fn load_state(home: &Home, sid: &str) -> Result<State> {
    Ok(serde_json::from_slice(&fs::read(home.state_path(sid))?)?)
}

fn save_state(home: &Home, st: &State) -> Result<()> {
    let p = home.state_path(&st.decl.id);
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(st)?)?;
    replace(&tmp, &p)
}

pub fn list_sources(home: &Home) -> Vec<State> {
    let mut v = vec![];
    if let Ok(rd) = fs::read_dir(home.sources_dir()) {
        for e in rd.flatten() {
            if let Some(n) = e.file_name().to_str() {
                if let Ok(s) = load_state(home, n) {
                    v.push(s);
                }
            }
        }
    }
    v.sort_by(|a, b| a.decl.id.cmp(&b.decl.id));
    v
}

fn replace(from: &Path, to: &Path) -> Result<()> {
    if fs::rename(from, to).is_err() {
        let _ = fs::remove_file(to);
        fs::rename(from, to)?;
    }
    Ok(())
}

pub type Progress<'a> = &'a mut dyn FnMut(&str, u64, u64);

/// 한 파일을 받아 검증한 뒤 원자적으로 교체한다. 하나라도 다르면 Err이고 기존 파일은 그대로다.
fn install_file(home: &Home, base: &str, sid: &str, f: &FileDecl, prog: Progress) -> Result<()> {
    if f.schema != 1 {
        bail!("{}: 지원하지 않는 schema {}", f.id, f.schema);
    }
    let dir = home.source_dir(sid);
    fs::create_dir_all(&dir)?;
    let gz = dir.join(format!("{}.db.gz.part", f.id));
    let db = dir.join(format!("{}.db.part", f.id));
    let res = (|| -> Result<()> {
        // 1) 내려받으며 압축 파일 해시 계산
        let resp = http_get(&join_url(base, &f.url))?;
        let total = f.bytes;
        let mut rd = resp.into_body().into_reader();
        let mut out = File::create(&gz)?;
        let mut h = Sha256::new();
        let (mut buf, mut done) = (vec![0u8; 64 << 10], 0u64);
        loop {
            let n = rd.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            done += n as u64;
            if done > total.max(1) * 2 + (1 << 20) {
                bail!("{}: 선언보다 큰 파일입니다", f.id);
            }
            prog(&f.id, done, total);
        }
        out.flush()?;
        if hex(&h.finalize()) != f.sha256.to_lowercase() || done != f.bytes {
            bail!("{}: 압축 파일 SHA-256이 선언과 다릅니다", f.id);
        }
        // 2) 풀면서 DB 해시 계산
        let mut dec = flate2::read::GzDecoder::new(File::open(&gz)?);
        let mut out = File::create(&db)?;
        let mut h = Sha256::new();
        let mut size = 0u64;
        loop {
            let n = dec.read(&mut buf).context("압축을 풀지 못했습니다")?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            size += n as u64;
        }
        out.flush()?;
        if hex(&h.finalize()) != f.db_sha256.to_lowercase() || (f.db_bytes != 0 && size != f.db_bytes) {
            bail!("{}: DB SHA-256이 선언과 다릅니다", f.id);
        }
        // 3) meta, 행 수 확인
        verify_db(&db, f)?;
        Ok(())
    })();
    let _ = fs::remove_file(&gz);
    if let Err(e) = res {
        let _ = fs::remove_file(&db);
        return Err(e);
    }
    replace(&db, &home.db_path(sid, &f.id))
}

pub fn open_ro(p: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)?)
}

fn count(c: &Connection, table: &str) -> Result<i64> {
    Ok(c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
}

pub fn verify_db(p: &Path, f: &FileDecl) -> Result<()> {
    let c = open_ro(p)?;
    let meta = |k: &str| -> Result<String> {
        Ok(c.query_row("SELECT value FROM meta WHERE key=?", [k], |r| r.get(0)).with_context(|| format!("{}: meta.{k} 없음", f.id))?)
    };
    if meta("format")? != FORMAT {
        bail!("{}: meta.format이 {FORMAT}이 아닙니다", f.id);
    }
    if meta("file")? != f.id {
        bail!("{}: meta.file이 다릅니다", f.id);
    }
    let checks: Vec<(&str, Option<i64>, &str)> = match f.id.as_str() {
        "bible" => vec![("verse", f.verses, "verse")],
        "orig" => vec![("parse", f.words, "parse"), ("lex", f.lex, "lex")],
        "comm" => vec![("note", f.notes, "note"), ("article", f.articles, "article")],
        _ => vec![],
    };
    for (t, want, label) in checks {
        if let Some(w) = want {
            let got = count(&c, t)?;
            if got != w {
                bail!("{}: {label} 행 수가 선언({w})과 다릅니다({got})", f.id);
            }
        }
    }
    Ok(())
}

/// 출처 추가. `pick`이 None이면 모든 파일. 이미 있는 출처면 고른 파일을 추가·갱신한다.
pub fn add(home: &Home, url: &str, pick: Option<&[String]>, prog: Progress) -> Result<State> {
    let decl = fetch_declaration(url)?;
    let ids: Vec<String> = match pick {
        Some(p) => {
            for i in p {
                if !decl.files.iter().any(|f| &f.id == i) {
                    bail!("선언에 없는 파일: {i}");
                }
            }
            p.to_vec()
        }
        None => decl.files.iter().map(|f| f.id.clone()).collect(),
    };
    let prev = load_state(home, &decl.id).ok();
    let mut installed = prev.map(|s| s.installed).unwrap_or_default();
    for id in &ids {
        let f = decl.files.iter().find(|f| &f.id == id).unwrap();
        install_file(home, url, &decl.id, f, prog)?;
        if !installed.contains(id) {
            installed.push(id.clone());
        }
        // 이 파일이 확정된 시점마다 상태를 남겨 중간에 끊겨도 일관되게 한다.
        let st = State { decl: decl.clone(), installed: installed.clone() };
        secret::store(home, &decl.id, url)?;
        save_state(home, &st)?;
        if f.id == "bible" || f.id == "comm" {
            search::rebuild(home, &decl.id, &f.id)?;
        }
    }
    if ids.is_empty() {
        secret::store(home, &decl.id, url)?;
        save_state(home, &State { decl: decl.clone(), installed: installed.clone() })?;
    }
    Ok(State { decl, installed })
}

/// 선언의 sha256이 바뀐 설치 파일만 다시 받는다. 돌려주는 값은 갱신한 파일 id.
pub fn sync(home: &Home, sid: &str, prog: Progress) -> Result<Vec<String>> {
    let url = secret::load(home, sid)?;
    let old = load_state(home, sid)?;
    let decl = fetch_declaration(&url)?;
    if decl.id != sid {
        bail!("선언의 id가 달라졌습니다");
    }
    let mut updated = vec![];
    let mut installed = old.installed.clone();
    for id in &old.installed {
        let Some(f) = decl.files.iter().find(|f| &f.id == id) else { continue };
        let changed = old.decl.files.iter().find(|o| &o.id == id).map(|o| o.sha256 != f.sha256).unwrap_or(true);
        if changed || !home.db_path(sid, id).exists() {
            install_file(home, &url, sid, f, prog)?;
            if f.id == "bible" || f.id == "comm" {
                search::rebuild(home, sid, &f.id)?;
            }
            updated.push(id.clone());
        }
    }
    installed.retain(|i| decl.files.iter().any(|f| &f.id == i));
    save_state(home, &State { decl, installed })?;
    Ok(updated)
}

/// 출처의 DB, 색인, 상태, 저장된 주소를 모두 지운다.
pub fn remove(home: &Home, sid: &str) -> Result<()> {
    let d = home.source_dir(sid);
    if sid.is_empty() || sid.contains(['/', '\\']) || sid == ".." {
        bail!("출처 id가 올바르지 않습니다");
    }
    if d.exists() {
        fs::remove_dir_all(&d)?;
    }
    secret::delete(home, sid)?;
    Ok(())
}
