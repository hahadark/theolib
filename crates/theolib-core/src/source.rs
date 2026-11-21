//! 출처(선언 파일) 읽기, 이어받기, 검증, 원자적 교체, 동기화, 삭제. 실제 서버 형식(theolib-db/1) 기준.
use crate::{Home, secret};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

pub const FORMAT: &str = "theolib-db/1";
/// 출처는 하나뿐이다(주소 하나). 폴더·키체인 항목 이름으로 쓴다.
pub const SID: &str = "main";

fn default_schema() -> serde_json::Value {
    serde_json::Value::Null
}

/// 모르는 칸은 무시한다. 행 수 칸은 없다.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileDecl {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub db_bytes: u64,
    pub db_sha256: String,
    #[serde(default = "default_schema")]
    pub schema: serde_json::Value,
    #[serde(default)]
    pub built_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Declaration {
    pub format: String,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub note: String,
    pub files: Vec<FileDecl>,
}

/// 디스크에 남기는 상태. 주소(개인키)는 넣지 않는다.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct State {
    pub decl: Declaration,
    pub installed: Vec<String>,
    /// 화면에 보여도 되는 출처 이름(GitHub 는 github.com/<owner>/<repo>, 그 밖에는 빈 문자열)
    #[serde(default)]
    pub origin: String,
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

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_body(Some(Duration::from_secs(60)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// 상태 코드를 원인별 문구로. 주소·토큰은 넣지 않는다.
pub fn explain_status(code: u16, rate_limited: bool, gh: bool) -> String {
    if gh {
        return match code {
            401 => "GitHub 토큰이 거부되었습니다(401). 토큰이 만료됐거나 틀렸는지 확인하세요.".into(),
            403 if rate_limited => "GitHub 요청 한도를 넘었습니다(403, 한도 초과). 잠시 뒤 다시 시도하세요.".into(),
            403 => "GitHub가 접근을 거부했습니다(403). 토큰 권한을 확인하세요.".into(),
            404 | 410 => "저장소 또는 릴리스(db)를 찾을 수 없습니다(404). 주소를 확인하세요. 비공개 저장소는 토큰에 권한이 없어도 404로 보입니다.".into(),
            500..=599 => format!("GitHub 서버가 응답하지 않습니다({code}). 잠시 뒤 다시 시도하세요."),
            c => format!("GitHub가 오류를 돌려주었습니다({c})."),
        };
    }
    match code {
        404 | 410 => "주소가 올바르지 않습니다(404). 주소를 다시 확인하세요.".into(),
        401 | 403 => "접근이 거부되었습니다(401/403). 주소의 키가 맞는지 확인하세요.".into(),
        502..=504 => format!("서버가 꺼져 있거나 응답하지 않습니다({code}). 잠시 뒤 다시 시도하세요."),
        c => format!("서버가 오류를 돌려주었습니다({c})."),
    }
}

fn explain(e: &ureq::Error, url: &str) -> String {
    match e {
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Timeout(_) | ureq::Error::Io(_) => "서버에 연결하지 못했습니다. 인터넷 연결과 주소를 확인하세요.".into(),
        other => format!("연결 오류: {}", redact(other.to_string(), url)),
    }
}

type Hdrs = Vec<(&'static str, String)>;

fn get(url: &str, range: Option<(u64, &str)>, hdrs: &Hdrs, gh: bool) -> Result<ureq::http::Response<ureq::Body>> {
    let mut rq = agent().get(url);
    for (k, v) in hdrs {
        rq = rq.header(*k, v.as_str());
    }
    if let Some((from, etag)) = range {
        rq = rq.header("Range", format!("bytes={from}-"));
        if !etag.is_empty() {
            rq = rq.header("If-Range", etag);
        }
    }
    let r = rq.call().map_err(|e| anyhow::anyhow!(explain(&e, url)))?;
    let c = r.status().as_u16();
    if c >= 400 {
        let rate = r.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()) == Some("0");
        bail!(explain_status(c, rate, gh));
    }
    Ok(r)
}

#[derive(Clone, Debug)]
pub struct Gh {
    pub owner: String,
    pub repo: String,
    pub tag: String,
    pub token: Option<String>,
    /// (자산 이름, 자산 id)
    pub assets: Vec<(String, u64)>,
}

/// `https://<토큰>@github.com/<owner>/<repo>[.git][/releases/…]` 꼴이면 (owner, repo, 토큰, 태그).
pub fn parse_github(url: &str) -> Option<(String, String, Option<String>, String)> {
    let rest = url.trim().strip_prefix("https://").or_else(|| url.trim().strip_prefix("http://"))?;
    let (auth, rest) = match rest.split_once('@') {
        Some((a, r)) if !a.contains('/') => (Some(a), r),
        _ => (None, rest),
    };
    let (host, path) = rest.split_once('/')?;
    if host != "github.com" && host != "www.github.com" {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    let seg: Vec<&str> = path.split('/').filter(|x| !x.is_empty()).collect();
    if seg.len() < 2 {
        return None;
    }
    let repo = seg[1].trim_end_matches(".git").to_string();
    let token = auth.map(|a| a.rsplit(':').next().unwrap_or(a).to_string()).filter(|t| !t.is_empty());
    let tag = if seg.len() >= 5 && seg[2] == "releases" && seg[3] == "tag" { seg[4].to_string() } else { "db".to_string() };
    Some((seg[0].to_string(), repo, token, tag))
}

pub struct Ctx {
    base: String,
    pub gh: Option<Gh>,
}

impl Ctx {
    pub fn new(url: &str) -> Result<Ctx> {
        let Some((owner, repo, token, tag)) = parse_github(url) else { return Ok(Ctx { base: url.to_string(), gh: None }) };
        let mut gh = Gh { owner, repo, tag, token, assets: vec![] };
        let api = format!("https://api.github.com/repos/{}/{}/releases/tags/{}", gh.owner, gh.repo, gh.tag);
        let mut body = String::new();
        get(&api, None, &gh_headers(&gh, false), true)?.into_body().into_reader().take(8 << 20).read_to_string(&mut body).map_err(|_| anyhow::anyhow!("GitHub 응답을 끝까지 받지 못했습니다."))?;
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| anyhow::anyhow!("GitHub 응답의 형식이 다릅니다."))?;
        for a in v["assets"].as_array().cloned().unwrap_or_default() {
            if let (Some(n), Some(i)) = (a["name"].as_str(), a["id"].as_u64()) {
                gh.assets.push((n.to_string(), i));
            }
        }
        if gh.assets.is_empty() {
            bail!("릴리스({})에 자료 파일이 없습니다.", gh.tag);
        }
        Ok(Ctx { base: String::new(), gh: Some(gh) })
    }

    pub fn origin(&self) -> String {
        self.gh.as_ref().map(|g| format!("github.com/{}/{}", g.owner, g.repo)).unwrap_or_default()
    }

    /// 선언의 url(상대 또는 자산 이름) → (요청 주소, 헤더)
    fn resolve(&self, rel: &str) -> Result<(String, Hdrs)> {
        match &self.gh {
            None => Ok((join_url(&self.base, rel), vec![])),
            Some(g) => {
                let name = rel.rsplit('/').next().unwrap_or(rel);
                let id = g.assets.iter().find(|(n, _)| n == name).map(|(_, i)| *i).ok_or_else(|| anyhow::anyhow!("릴리스에 '{name}' 파일이 없습니다."))?;
                Ok((format!("https://api.github.com/repos/{}/{}/releases/assets/{id}", g.owner, g.repo), gh_headers(g, true)))
            }
        }
    }

    pub fn declaration(&self) -> Result<Declaration> {
        let (url, h) = match &self.gh {
            None => (self.base.clone(), vec![]),
            Some(_) => self.resolve("theolib.json")?,
        };
        let mut body = String::new();
        get(&url, None, &h, self.gh.is_some())?
            .into_body()
            .into_reader()
            .take(8 << 20)
            .read_to_string(&mut body)
            .map_err(|_| anyhow::anyhow!("선언 파일을 끝까지 받지 못했습니다(연결이 끊김 또는 글자 형식 다름)."))?;
        parse_declaration(&body)
    }
}

fn gh_headers(g: &Gh, octet: bool) -> Hdrs {
    let mut h: Hdrs = vec![("User-Agent", "theolib".into()), ("X-GitHub-Api-Version", "2022-11-28".into()), ("Accept", if octet { "application/octet-stream".into() } else { "application/vnd.github+json".into() })];
    if let Some(t) = &g.token {
        h.push(("Authorization", format!("Bearer {t}")));
    }
    h
}

pub fn parse_declaration(body: &str) -> Result<Declaration> {
    let d: Declaration = serde_json::from_str(body).map_err(|_| anyhow::anyhow!("선언 파일의 형식이 다릅니다(JSON이 아니거나 필요한 칸이 없음)."))?;
    if d.format != FORMAT {
        bail!("지원하지 않는 선언 형식입니다: {}", d.format);
    }
    for f in &d.files {
        if f.id.is_empty() || !f.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            bail!("선언의 파일 id가 올바르지 않습니다");
        }
    }
    Ok(d)
}

pub fn fetch_declaration(url: &str) -> Result<Declaration> {
    Ctx::new(url)?.declaration()
}

pub fn load_state(home: &Home, sid: &str) -> Result<State> {
    Ok(serde_json::from_slice(&fs::read(home.state_path(sid))?)?)
}

fn save_state(home: &Home, st: &State) -> Result<()> {
    fs::create_dir_all(home.source_dir(SID))?;
    let p = home.state_path(SID);
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(st)?)?;
    replace(&tmp, &p)
}

pub fn list_sources(home: &Home) -> Vec<State> {
    load_state(home, SID).into_iter().collect()
}

fn replace(from: &Path, to: &Path) -> Result<()> {
    if fs::rename(from, to).is_err() {
        let _ = fs::remove_file(to);
        fs::rename(from, to)?;
    }
    Ok(())
}

/// (단계 설명, 지금까지, 전체) — 설명에는 파일 id가 들어 있다.
pub type Progress<'a> = &'a mut dyn FnMut(&str, u64, u64);

fn sha_of_part(p: &Path) -> Result<(Sha256, u64)> {
    let mut h = Sha256::new();
    let mut f = File::open(p)?;
    let mut buf = vec![0u8; 256 << 10];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((h, n))
}

/// 압축본을 받는다. 중간 파일이 있으면 Range(If-Range=ETag)로 이어받는다. 서버가 200이면 처음부터.
fn download(url: &str, hdrs: &Hdrs, gh: bool, f: &FileDecl, gz: &Path, prog: Progress) -> Result<Sha256> {
    let info = gz.with_extension("part.info");
    let label = format!("{} 받는 중", f.id);
    let mut etag = String::new();
    let mut have = 0u64;
    if gz.exists() {
        let want = fs::read_to_string(&info).unwrap_or_default();
        let mut it = want.lines();
        if it.next() == Some(f.sha256.as_str()) {
            etag = it.next().unwrap_or("").to_string();
            have = fs::metadata(gz)?.len();
        }
        if have == 0 || have >= f.bytes {
            have = 0;
            etag.clear();
            let _ = fs::remove_file(gz);
        }
    }
    let mut resp = if have > 0 {
        match get(url, Some((have, &etag)), hdrs, gh) {
            Ok(r) => r,
            Err(_) => {
                have = 0;
                let _ = fs::remove_file(gz);
                get(url, None, hdrs, gh)?
            }
        }
    } else {
        get(url, None, hdrs, gh)?
    };
    let mut h = Sha256::new();
    let mut out;
    if resp.status().as_u16() == 206 && have > 0 {
        let (hh, n) = sha_of_part(gz)?;
        h = hh;
        have = n;
        out = OpenOptions::new().append(true).open(gz)?;
    } else {
        have = 0;
        out = File::create(gz)?;
        let tag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        fs::write(&info, format!("{}\n{}\n", f.sha256, tag))?;
    }
    let total = f.bytes;
    let mut rd = resp.body_mut().as_reader();
    let (mut buf, mut done) = (vec![0u8; 64 << 10], have);
    prog(&label, done, total);
    loop {
        let n = rd.read(&mut buf).map_err(|_| anyhow::anyhow!("{}: 내려받는 중 연결이 끊겼습니다. 다시 시도하면 이어받습니다.", f.id))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        out.write_all(&buf[..n])?;
        done += n as u64;
        if done > total.max(1) * 2 + (1 << 20) {
            let _ = fs::remove_file(gz);
            bail!("{}: 선언보다 큰 파일입니다", f.id);
        }
        prog(&label, done, total);
    }
    out.flush()?;
    if done < f.bytes {
        bail!("{}: 내려받는 중 연결이 끊겼습니다({done}/{} 바이트). 다시 시도하면 이어받습니다.", f.id, f.bytes);
    }
    Ok(h)
}

/// 한 파일을 받아 검증한 뒤 원자적으로 교체한다. 하나라도 다르면 Err이고 기존 파일은 그대로다.
fn install_file(home: &Home, ctx: &Ctx, f: &FileDecl, prog: Progress) -> Result<()> {
    let dir = home.source_dir(SID);
    fs::create_dir_all(&dir)?;
    let gz = dir.join(format!("{}.db.gz.part", f.id));
    let info = gz.with_extension("part.info");
    let db = dir.join(format!("{}.db.part", f.id));
    let res = (|| -> Result<()> {
        let (u, hd) = ctx.resolve(&f.url)?;
        let h = download(&u, &hd, ctx.gh.is_some(), f, &gz, prog)?;
        if hex(&h.finalize()) != f.sha256.to_lowercase() || fs::metadata(&gz)?.len() != f.bytes {
            let _ = fs::remove_file(&gz);
            let _ = fs::remove_file(&info);
            bail!("{}: 압축 파일 SHA-256이 선언과 다릅니다(받은 파일 폐기)", f.id);
        }
        let label = format!("{} 풀고 확인하는 중", f.id);
        let mut dec = flate2::read::GzDecoder::new(File::open(&gz)?);
        let mut out = File::create(&db)?;
        let mut h = Sha256::new();
        let (mut buf, mut size) = (vec![0u8; 256 << 10], 0u64);
        loop {
            let n = dec.read(&mut buf).context("압축을 풀지 못했습니다")?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            size += n as u64;
            prog(&label, size, f.db_bytes);
        }
        out.flush()?;
        if hex(&h.finalize()) != f.db_sha256.to_lowercase() || (f.db_bytes != 0 && size != f.db_bytes) {
            bail!("{}: DB SHA-256이 선언과 다릅니다", f.id);
        }
        verify_db(&db, f)?;
        Ok(())
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&db);
        return Err(e);
    }
    let _ = fs::remove_file(&gz);
    let _ = fs::remove_file(&info);
    replace(&db, &home.db_path(SID, &f.id))
}

pub fn open_ro(p: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)?)
}

/// meta(k,v)의 format 확인(행 수 검증은 하지 않는다).
pub fn verify_db(p: &Path, f: &FileDecl) -> Result<()> {
    let c = open_ro(p)?;
    let meta = |k: &str| -> Option<String> { c.query_row("SELECT v FROM meta WHERE k=?", [k], |r| r.get(0)).ok() };
    match meta("format") {
        Some(x) if x == FORMAT => {}
        Some(_) => bail!("{}: meta.format이 {FORMAT}이 아닙니다", f.id),
        None => bail!("{}: meta.format이 없습니다(형식 다름)", f.id),
    }
    if let Some(pk) = meta("pack") {
        if pk != f.id {
            bail!("{}: meta.pack({pk})이 선언의 id와 다릅니다", f.id);
        }
    }
    Ok(())
}

/// 출처 추가. `pick`이 None이면 모든 파일. 이미 있는 출처면 고른 파일을 추가·갱신한다.
/// 검색 색인은 따로 `search::build_index`로 만든다(백그라운드 가능).
pub fn add(home: &Home, url: &str, pick: Option<&[String]>, prog: Progress) -> Result<State> {
    let ctx = Ctx::new(url)?;
    let decl = ctx.declaration()?;
    let origin = ctx.origin();
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
    let prev = load_state(home, SID).ok();
    let mut installed = prev.map(|s| s.installed).unwrap_or_default();
    secret::store(home, SID, url)?;
    for id in &ids {
        let f = decl.files.iter().find(|f| &f.id == id).unwrap();
        install_file(home, &ctx, f, prog)?;
        if !installed.contains(id) {
            installed.push(id.clone());
        }
        save_state(home, &State { decl: decl.clone(), installed: installed.clone(), origin: origin.clone() })?;
    }
    let st = State { decl, installed, origin };
    save_state(home, &st)?;
    Ok(st)
}

/// 선언의 sha256이 바뀐 설치 파일만 다시 받는다. 돌려주는 값은 갱신한 파일 id.
pub fn sync(home: &Home, prog: Progress) -> Result<Vec<String>> {
    let url = secret::load(home, SID)?;
    let old = load_state(home, SID)?;
    let ctx = Ctx::new(&url)?;
    let decl = ctx.declaration()?;
    let mut updated = vec![];
    for id in &old.installed {
        let Some(f) = decl.files.iter().find(|f| &f.id == id) else { continue };
        let changed = old.decl.files.iter().find(|o| &o.id == id).map(|o| o.sha256 != f.sha256).unwrap_or(true);
        if changed || !home.db_path(SID, id).exists() {
            install_file(home, &ctx, f, prog)?;
            updated.push(id.clone());
        }
    }
    let mut installed = old.installed.clone();
    installed.retain(|i| decl.files.iter().any(|f| &f.id == i));
    save_state(home, &State { decl, installed, origin: old.origin.clone() })?;
    Ok(updated)
}

/// 출처의 DB, 색인, 상태, 저장된 주소를 모두 지운다.
pub fn remove(home: &Home) -> Result<()> {
    let d = home.source_dir(SID);
    if d.exists() {
        fs::remove_dir_all(&d)?;
    }
    secret::delete(home, SID)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lenient_declaration() {
        let d = parse_declaration(r#"{"format":"theolib-db/1","extra":1,"files":[{"id":"bible-ko","url":"a.gz","sha256":"x","db_sha256":"y","schema":{"verse":["a"]},"zzz":3}]}"#).unwrap();
        assert_eq!(d.files[0].id, "bible-ko");
        assert!(parse_declaration("<html>").is_err());
        let g = parse_github("https://tok123@github.com/hahadark/theolib-data.git/releases/tag/db").unwrap();
        assert_eq!((g.0.as_str(), g.1.as_str(), g.2.as_deref(), g.3.as_str()), ("hahadark", "theolib-data", Some("tok123"), "db"));
        assert_eq!(parse_github("https://github.com/a/b").unwrap().2, None);
        assert_eq!(parse_github("https://u:tk@github.com/a/b/releases").unwrap().2.as_deref(), Some("tk"));
        assert!(parse_github("http://127.0.0.1:8792/theolib.json").is_none());
        assert!(explain_status(403, true, true).contains("한도"));
        assert!(explain_status(401, false, true).contains("토큰"));
        assert!(parse_declaration(r#"{"format":"other/1","files":[]}"#).is_err());
    }
}
