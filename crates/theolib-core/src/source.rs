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
    /// 항목 목록(있으면 선택 화면에 쓴다): versions / code_versions / dicts / series / articles
    #[serde(default)]
    pub contents: Option<serde_json::Value>,
    // 항목별 선언(layout: "items") 전용 칸
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub grp: String,
    #[serde(default)]
    pub rows: Option<i64>,
    #[serde(default)]
    pub pack: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub notes: Option<i64>,
    #[serde(default)]
    pub articles: Option<i64>,
    /// 항목 파일에 검색 색인(FTS5)이 미리 들어 있는지, 색인 버전
    #[serde(default)]
    pub fts: bool,
    #[serde(default)]
    pub fts_ver: i64,
    /// 기본 체크 힌트(크기 기준)
    #[serde(default)]
    pub default: Option<bool>,
    /// 책별로 쪼갠 주석 항목(`comm:<시리즈>:<bk>`)의 시리즈 id·책 번호(0=공통)·책 이름·시리즈 전체 크기
    #[serde(default)]
    pub series: String,
    #[serde(default)]
    pub bk: Option<i64>,
    #[serde(default)]
    pub book: String,
    #[serde(default)]
    pub series_bytes: Option<u64>,
}

/// 로컬 통합 DB에 넣은 항목 한 개의 기록.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ItemRec {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub grp: String,
    pub sha256: String,
    pub bytes: u64,
    pub db_bytes: u64,
    #[serde(default)]
    pub license: String,
    pub source: String,
    /// 받은 미리 만든 색인을 쓰고 있다(기기에서 색인하지 않음)
    #[serde(default)]
    pub fts: bool,
}

/// 앱이 이해하는 미리 만든 색인 버전
pub const FTS_VER: i64 = 1;

/// 항목의 미리 만든 색인 파일 위치
pub fn fts_path(home: &Home, id: &str) -> std::path::PathBuf {
    let h = hex(&Sha256::digest(id.as_bytes()));
    home.source_dir(SID).join("fts").join(format!("{}.db", &h[..16]))
}

/// 받은 항목 DB 에서 본문 표를 빼고 색인만 남겨 보관한다.
fn keep_fts(home: &Home, id: &str, item_db: &Path) -> Result<()> {
    let to = fts_path(home, id);
    fs::create_dir_all(to.parent().unwrap())?;
    let tmp = to.with_extension("tmp");
    let _ = fs::remove_file(&tmp);
    fs::copy(item_db, &tmp)?;
    {
        let c = Connection::open(&tmp)?;
        for t in ["version", "verse", "code_version", "code_verse", "lex", "series", "note", "article", "comm_verse"] {
            c.execute_batch(&format!("DROP TABLE IF EXISTS \"{t}\""))?;
        }
        c.execute_batch("VACUUM")?;
    }
    replace(&tmp, &to)
}

/// 항목 종류 → 통합 DB 묶음 id (bible-i / orig-i / comm-i)
pub fn item_pack(kind: &str) -> Option<&'static str> {
    match kind {
        "bible" => Some("bible-i"),
        "code" | "lex" => Some("orig-i"),
        "comm" => Some("comm-i"),
        _ => None,
    }
}

/// 항목 id(`bible:개역개정`)에서 DB 안의 키(번역본 id·사전 id·시리즈 id)
pub fn item_key(id: &str) -> &str {
    let k = id.split_once(':').map(|x| x.1).unwrap_or(id);
    if id.starts_with("comm:") {
        if let Some((s, _)) = split_book_key(k) {
            return s;
        }
    }
    k
}

/// `<시리즈>:<bk>` 꼴이면 (시리즈, bk). 책별 주석 항목의 키.
pub fn split_book_key(k: &str) -> Option<(&str, i64)> {
    let (s, n) = k.rsplit_once(':')?;
    if s.is_empty() || n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((s, n.parse().ok()?))
}

/// 항목 id 가 책별 주석 항목이면 책 번호(0=공통)
pub fn item_bk(id: &str) -> Option<i64> {
    if !id.starts_with("comm:") {
        return None;
    }
    split_book_key(id.split_once(':')?.1).map(|x| x.1)
}

/// 묶음 id 접두어로 종류를 판단한다: bible / orig / comm
pub fn kind_of(id: &str) -> &'static str {
    if id.starts_with("bible") {
        "bible"
    } else if id.starts_with("orig") {
        "orig"
    } else if id.starts_with("comm") {
        "comm"
    } else {
        "other"
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Declaration {
    /// 선언에 적힌 추가 출처 링크(화면에 "추가" 단추로 보인다)
    #[serde(default)]
    pub links: Vec<Link>,
    pub format: String,
    #[serde(default)]
    pub layout: String,
    #[serde(default)]
    pub title: String,
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
    /// 출처별 정보(여러 출처를 함께 쓴다)
    #[serde(default)]
    pub sources: Vec<SrcInfo>,
    /// 숨긴 항목 키: `v:<번역본/원어 본문 id>`, `d:<사전 id>`, `s:<주석 시리즈 id>`
    #[serde(default)]
    pub hidden: Vec<String>,
    /// 선택 안 한 자료를 지워 줄인 묶음(갱신 때 전체를 다시 받는다)
    #[serde(default)]
    pub pruned: Vec<String>,
    /// 항목별로 받아 통합 DB에 넣은 항목들
    #[serde(default)]
    pub items: Vec<ItemRec>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Link {
    #[serde(default)]
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SrcInfo {
    /// "zip" 이면 압축 파일 주소 출처
    #[serde(default)]
    pub kind: String,
    pub key: String,
    pub origin: String,
    #[serde(default)]
    pub title: String,
    pub files: Vec<String>,
}

/// 출처 식별 키(주소 해시 앞 12자리). 키체인 항목 이름에 쓰며 주소·토큰은 담지 않는다.
pub fn source_key(url: &str) -> String {
    let id = match parse_github(url) {
        Some((o, r, _, t)) => format!("github.com/{o}/{r}#{t}"),
        None => url.split(['?', '#']).next().unwrap_or(url).to_string(),
    };
    hex(&Sha256::digest(id.as_bytes()))[..12].to_string()
}

static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 진행 중인 내려받기를 멈춘다(받은 부분은 남아 다음에 이어받는다).
pub(crate) fn is_cancelled() -> bool {
    CANCEL.load(std::sync::atomic::Ordering::SeqCst)
}
pub(crate) fn reset_cancel() {
    CANCEL.store(false, std::sync::atomic::Ordering::SeqCst);
}
pub fn cancel() {
    CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
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

/// 구간 요청(`bytes=…` 문자열 그대로). 서버가 구간을 안 주면(200) 응답 그대로 돌려준다.
pub(crate) fn get_range(url: &str, spec: &str) -> Result<ureq::http::Response<ureq::Body>> {
    let r = agent().get(url).header("Range", spec).call().map_err(|e| anyhow::anyhow!(explain(&e, url)))?;
    let c = r.status().as_u16();
    if c >= 400 {
        bail!(explain_status(c, false, false));
    }
    Ok(r)
}

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
        match &self.gh {
            Some(g) => format!("github.com/{}/{}", g.owner, g.repo),
            None if self.base.starts_with('/') => "내 폴더".to_string(),
            None => String::new(),
        }
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
        if self.base.starts_with('/') {
            let body = fs::read_to_string(&self.base).map_err(|_| anyhow::anyhow!("선언 파일을 읽지 못했습니다(파일 없음)."))?;
            return parse_declaration(&body);
        }
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
        let ok = if d.layout == "items" { !f.id.is_empty() && !f.id.contains(['/', '\\']) } else { !f.id.is_empty() && f.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') };
        if !ok {
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

pub(crate) fn save_state(home: &Home, st: &State) -> Result<()> {
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
    if url.starts_with('/') {
        // 폴더로 전달받은 파일: 복사하면서 해시 계산
        let mut h = Sha256::new();
        let mut rd = File::open(url).map_err(|_| anyhow::anyhow!("{}: 파일이 폴더에 없습니다", f.id))?;
        let mut out = File::create(gz)?;
        let (mut buf, mut done) = (vec![0u8; 256 << 10], 0u64);
        loop {
            let n = rd.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            done += n as u64;
            prog(&label, done, f.bytes);
        }
        out.flush()?;
        return Ok(h);
    }
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
        if CANCEL.load(std::sync::atomic::Ordering::SeqCst) {
            bail!("취소했습니다. 다시 받기를 누르면 이어받습니다.");
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

fn part_name(id: &str) -> String {
    if id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        id.to_string()
    } else {
        format!("x{}", &hex(&Sha256::digest(id.as_bytes()))[..12])
    }
}

/// 한 파일을 받아 검증한 뒤 원자적으로 교체한다. 하나라도 다르면 Err이고 기존 파일은 그대로다.
fn install_file(home: &Home, ctx: &Ctx, f: &FileDecl, prog: Progress) -> Result<()> {
    let db = fetch_db(home, ctx, f, prog)?;
    replace(&db, &home.db_path(SID, &f.id))
}

/// 받아서 SHA-256 두 가지와 meta.format 을 확인한 푼 DB(.part 경로)를 돌려준다.
fn fetch_db(home: &Home, ctx: &Ctx, f: &FileDecl, prog: Progress) -> Result<std::path::PathBuf> {
    let dir = home.source_dir(SID);
    fs::create_dir_all(&dir)?;
    let pn = part_name(&f.id);
    let gz = dir.join(format!("{pn}.db.gz.part"));
    let info = gz.with_extension("part.info");
    let db = dir.join(format!("{pn}.db.part"));
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
    Ok(db)
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

pub(crate) fn push_unique(v: &mut Vec<String>, x: &str) {
    if !v.iter().any(|i| i == x) {
        v.push(x.to_string());
    }
}

/// 출처 추가(여러 출처를 함께 쓴다). `pick`이 None이면 모든 파일. `hide`는 선택하지 않은 항목 키(숨김).
/// 같은 묶음 id 가 다른 출처에서 이미 설치돼 있으면 먼저 설치한 것을 그대로 두고 건너뛴다.
/// 검색 색인은 따로 `search::build_index`로 만든다(백그라운드 가능).
pub fn add(home: &Home, url: &str, pick: Option<&[String]>, hide: &[String], prog: Progress) -> Result<State> {
    CANCEL.store(false, std::sync::atomic::Ordering::SeqCst);
    let ctx = Ctx::new(url)?;
    let decl = ctx.declaration()?;
    let key = source_key(url);
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
    let mut st = load_state(home, SID).unwrap_or(State { decl: Declaration { links: vec![], format: FORMAT.into(), layout: String::new(), title: String::new(), updated: String::new(), note: String::new(), files: vec![] }, installed: vec![], origin: String::new(), sources: vec![], hidden: vec![], pruned: vec![], items: vec![] });
    secret::store(home, &format!("src-{key}"), url)?;
    for id in &ids {
        let f = decl.files.iter().find(|f| &f.id == id).unwrap();
        let owner = st.sources.iter().find(|s| s.files.contains(id)).map(|s| s.key.clone());
        if matches!(&owner, Some(k) if *k != key) {
            continue; // 다른 출처에 같은 묶음이 이미 있다
        }
        install_file(home, &ctx, f, prog)?;
        push_unique(&mut st.installed, id);
        st.pruned.retain(|p| p != id);
        match st.decl.files.iter_mut().find(|x| &x.id == id) {
            Some(x) => *x = f.clone(),
            None => st.decl.files.push(f.clone()),
        }
        if !st.sources.iter().any(|s| s.key == key) {
            st.sources.push(SrcInfo { kind: String::new(), key: key.clone(), origin: ctx.origin(), title: decl.title.clone(), files: vec![] });
        }
        let si = st.sources.iter_mut().find(|s| s.key == key).unwrap();
        si.title = decl.title.clone();
        push_unique(&mut si.files, id);
        st.decl.updated = decl.updated.clone();
        st.decl.note = decl.note.clone();
        st.origin = ctx.origin();
        save_state(home, &st)?;
    }
    for k in hide {
        push_unique(&mut st.hidden, k);
    }
    save_state(home, &st)?;
    Ok(st)
}

/// 선언의 sha256이 바뀐 설치 파일만 다시 받는다(출처마다). 돌려주는 값은 갱신한 파일 id.
pub fn sync(home: &Home, prog: Progress) -> Result<Vec<String>> {
    CANCEL.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut st = load_state(home, SID)?;
    let mut updated = vec![];
    for si in st.sources.clone() {
        if si.kind == "zip" {
            let url = secret::load(home, &format!("src-{}", si.key))?;
            updated.extend(crate::zipsrc::sync(home, &url, &mut st, prog)?);
            continue;
        }
        if si.key == "local" {
            continue; // 내 파일은 갱신 확인 대상이 아니다
        }
        let url = secret::load(home, &format!("src-{}", si.key))?;
        let ctx = Ctx::new(&url)?;
        let decl = ctx.declaration()?;
        for id in &si.files {
            if let Some(rec) = st.items.iter().find(|r| &r.id == id).cloned() {
                let Some(f) = decl.files.iter().find(|f| &f.id == id) else { continue };
                if rec.sha256 != f.sha256 {
                    install_item(home, &ctx, f, &si.key, &mut st, prog)?;
                    updated.push(id.clone());
                    save_state(home, &st)?;
                }
                continue;
            }
            let Some(f) = decl.files.iter().find(|f| &f.id == id) else { continue };
            let old = st.decl.files.iter().find(|o| &o.id == id);
            let changed = old.map(|o| o.sha256 != f.sha256).unwrap_or(true);
            let pruned = st.pruned.contains(id);
            if changed || !home.db_path(SID, id).exists() {
                install_file(home, &ctx, f, prog)?;
                st.pruned.retain(|p| p != id);
                if let Some(x) = st.decl.files.iter_mut().find(|x| &x.id == id) {
                    *x = f.clone();
                }
                updated.push(id.clone());
                save_state(home, &st)?;
            } else if pruned {
                // 지워 줄인 묶음은 선언이 같으면 그대로 둔다(바뀌면 위에서 전체를 다시 받는다)
            }
        }
        st.decl.updated = decl.updated.clone();
    }
    save_state(home, &st)?;
    Ok(updated)
}

/// 묶음 하나를 지운다(DB 파일). 검색 색인은 `search::build_index`가 정리한다.
pub fn remove_pack(home: &Home, id: &str) -> Result<()> {
    if id.is_empty() || id.contains(['/', '\\', '.']) {
        bail!("묶음 id가 올바르지 않습니다");
    }
    let mut st = load_state(home, SID)?;
    let _ = fs::remove_file(home.db_path(SID, id));
    st.installed.retain(|i| i != id);
    st.pruned.retain(|i| i != id);
    st.decl.files.retain(|f| f.id != id);
    for s in &mut st.sources {
        s.files.retain(|f| f != id);
    }
    let gone: Vec<String> = st.sources.iter().filter(|s| s.files.is_empty()).map(|s| s.key.clone()).collect();
    for k in gone {
        let _ = secret::delete(home, &format!("src-{k}"));
    }
    st.sources.retain(|s| !s.files.is_empty());
    save_state(home, &st)
}

/// 숨김 항목 목록을 통째로 바꾼다.
pub fn set_hidden(home: &Home, hidden: Vec<String>) -> Result<()> {
    let mut st = load_state(home, SID)?;
    st.hidden = hidden;
    save_state(home, &st)
}

/// 출처의 DB, 색인, 상태, 저장된 주소를 모두 지운다.
pub fn remove(home: &Home) -> Result<()> {
    if let Ok(st) = load_state(home, SID) {
        for s in st.sources {
            let _ = secret::delete(home, &format!("src-{}", s.key));
        }
    }
    let d = home.source_dir(SID);
    if d.exists() {
        fs::remove_dir_all(&d)?;
    }
    let _ = secret::delete(home, SID);
    Ok(())
}

/// 숨긴 항목의 행을 DB에서 지워 용량을 줄인다. 지운 묶음은 갱신 때 전체를 다시 받는다.
pub fn prune_hidden(home: &Home) -> Result<u64> {
    let mut st = load_state(home, SID)?;
    let before: u64 = st.installed.iter().filter_map(|i| fs::metadata(home.db_path(SID, i)).ok()).map(|m| m.len()).sum();
    for id in st.installed.clone() {
        let p = home.db_path(SID, &id);
        if !p.exists() {
            continue;
        }
        let c = Connection::open(&p)?;
        let mut changed = false;
        for k in &st.hidden {
            let Some((t, v)) = k.split_once(':') else { continue };
            let n = match (kind_of(&id), t) {
                ("bible", "v") => c.execute("DELETE FROM verse WHERE version=?", [v])? + c.execute("DELETE FROM version WHERE id=?", [v])?,
                ("orig", "v") => c.execute("DELETE FROM code_verse WHERE version=?", [v])? + c.execute("DELETE FROM code_version WHERE id=?", [v])?,
                ("orig", "d") => c.execute("DELETE FROM lex WHERE dict=?", [v])?,
                ("comm", "s") => c.execute("DELETE FROM note WHERE series=?", [v])? + c.execute("DELETE FROM article WHERE series=?", [v])? + c.execute("DELETE FROM comm_verse WHERE comm=?", [v])? + c.execute("DELETE FROM series WHERE id=?", [v])?,
                _ => 0,
            };
            changed |= n > 0;
        }
        if changed {
            c.execute_batch("VACUUM")?;
            push_unique(&mut st.pruned, &id);
        }
    }
    let after: u64 = st.installed.iter().filter_map(|i| fs::metadata(home.db_path(SID, i)).ok()).map(|m| m.len()).sum();
    save_state(home, &st)?;
    Ok(before.saturating_sub(after))
}

const SCHEMA_BIBLE: &str = "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS version(id TEXT PRIMARY KEY, name TEXT, grp TEXT, ord INTEGER, descr TEXT);
CREATE TABLE IF NOT EXISTS verse(version TEXT, book INTEGER, chapter INTEGER, verse INTEGER, text TEXT);
CREATE INDEX IF NOT EXISTS verse_loc ON verse(version, book, chapter, verse);";
const SCHEMA_ORIG: &str = "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS code_version(id TEXT PRIMARY KEY, name TEXT, ord INTEGER);
CREATE TABLE IF NOT EXISTS code_verse(version TEXT, book INTEGER, chapter INTEGER, verse INTEGER, text TEXT);
CREATE TABLE IF NOT EXISTS lex(dict TEXT, code TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS code_loc ON code_verse(version, book, chapter, verse);
CREATE INDEX IF NOT EXISTS lex_code ON lex(dict, code);";
const SCHEMA_COMM: &str = "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS series(id TEXT PRIMARY KEY, name TEXT, kind TEXT, unit TEXT, types TEXT, ord INTEGER, coverage TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS note(id INTEGER PRIMARY KEY, series TEXT, bk INTEGER, seq INTEGER, ch1 INTEGER, v1 INTEGER, ch2 INTEGER, v2 INTEGER, start_key INTEGER, end_key INTEGER, ref TEXT, title TEXT, text TEXT, book_id TEXT, p INTEGER);
CREATE TABLE IF NOT EXISTS article(id INTEGER PRIMARY KEY, series TEXT, section TEXT, ord INTEGER, title TEXT, kind TEXT, text TEXT, book_id TEXT, p1 INTEGER, p2 INTEGER);
CREATE TABLE IF NOT EXISTS comm_verse(comm TEXT, book INTEGER, chapter INTEGER, verse INTEGER, html TEXT);
CREATE INDEX IF NOT EXISTS note_loc ON note(series, bk, start_key);
CREATE INDEX IF NOT EXISTS comm_loc ON comm_verse(comm, book, chapter, verse);
CREATE INDEX IF NOT EXISTS note_seq ON note(series, bk, seq);
CREATE INDEX IF NOT EXISTS article_ord ON article(series, ord);";

pub(crate) fn ensure_pack_db(home: &Home, pack: &str) -> Result<()> {
    let p = home.db_path(SID, pack);
    fs::create_dir_all(home.source_dir(SID))?;
    let c = Connection::open(&p)?;
    c.execute_batch(match kind_of(pack) {
        "bible" => SCHEMA_BIBLE,
        "orig" => SCHEMA_ORIG,
        _ => SCHEMA_COMM,
    })?;
    c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('format',?)", [FORMAT])?;
    c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('pack',?)", [pack])?;
    Ok(())
}

/// 항목의 행을 통합 DB에서 지운다(같은 id 로 다시 넣기 전, 또는 삭제).
pub(crate) fn delete_rows(c: &Connection, kind: &str, key: &str) -> Result<()> {
    match kind {
        "bible" => {
            c.execute("DELETE FROM verse WHERE version=?", [key])?;
            c.execute("DELETE FROM version WHERE id=?", [key])?;
        }
        "code" => {
            c.execute("DELETE FROM code_verse WHERE version=?", [key])?;
            c.execute("DELETE FROM code_version WHERE id=?", [key])?;
        }
        "lex" => {
            c.execute("DELETE FROM lex WHERE dict=?", [key])?;
        }
        "comm" => {
            c.execute("DELETE FROM note WHERE series=?", [key])?;
            c.execute("DELETE FROM article WHERE series=?", [key])?;
            c.execute("DELETE FROM comm_verse WHERE comm=?", [key])?;
            c.execute("DELETE FROM series WHERE id=?", [key])?;
        }
        _ => bail!("알 수 없는 항목 종류: {kind}"),
    }
    Ok(())
}

/// 책별 주석 항목 하나의 행만 지운다. 시리즈 행은 다른 책 행이 남아 있으면 둔다.
pub(crate) fn delete_comm_book(c: &Connection, series: &str, bk: i64) -> Result<()> {
    c.execute("DELETE FROM note WHERE series=?1 AND coalesce(bk,0)=?2", (series, bk))?;
    c.execute("DELETE FROM comm_verse WHERE comm=?1 AND coalesce(book,0)=?2", (series, bk))?;
    // 소논문: 숫자 book_id(1~66)면 그 책, 아니면 공통(0)
    c.execute("DELETE FROM article WHERE series=?1 AND (CASE WHEN book_id GLOB '[0-9]*' AND CAST(book_id AS INTEGER) BETWEEN 1 AND 66 THEN CAST(book_id AS INTEGER) ELSE 0 END)=?2", (series, bk))?;
    let left: i64 = c.query_row("SELECT (SELECT count(*) FROM note WHERE series=?1)+(SELECT count(*) FROM article WHERE series=?1)+(SELECT count(*) FROM comm_verse WHERE comm=?1)", [series], |r| r.get(0))?;
    if left == 0 {
        c.execute("DELETE FROM series WHERE id=?", [series])?;
    }
    Ok(())
}

/// 받은 항목 DB(.part)의 행을 통합 DB에 한 트랜잭션으로 넣는다(같은 항목이 있으면 교체).
fn merge_item(home: &Home, f: &FileDecl, item_db: &Path) -> Result<()> {
    let pack = item_pack(&f.kind).ok_or_else(|| anyhow::anyhow!("{}: 알 수 없는 항목 종류 {}", f.id, f.kind))?;
    ensure_pack_db(home, pack)?;
    let c = Connection::open(home.db_path(SID, pack))?;
    c.execute("ATTACH DATABASE ?1 AS it", [item_db.to_string_lossy().as_ref()])?;
    c.execute_batch("BEGIN")?;
    let r: Result<()> = (|| {
        match f.kind.as_str() {
            "bible" => {
                let ids: Vec<String> = c.prepare("SELECT id FROM it.version")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
                for i in &ids {
                    delete_rows(&c, "bible", i)?;
                }
                c.execute_batch("INSERT INTO version(id,name,grp,ord,descr) SELECT id,name,grp,ord,descr FROM it.version; INSERT INTO verse(version,book,chapter,verse,text) SELECT version,book,chapter,verse,text FROM it.verse;")?;
            }
            "code" => {
                let ids: Vec<String> = c.prepare("SELECT id FROM it.code_version")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
                for i in &ids {
                    delete_rows(&c, "code", i)?;
                }
                c.execute_batch("INSERT INTO code_version(id,name,ord) SELECT id,name,ord FROM it.code_version; INSERT INTO code_verse(version,book,chapter,verse,text) SELECT version,book,chapter,verse,text FROM it.code_verse;")?;
            }
            "lex" => {
                c.execute_batch("DELETE FROM lex WHERE dict IN (SELECT DISTINCT dict FROM it.lex); INSERT INTO lex(dict,code,text) SELECT dict,code,text FROM it.lex;")?;
            }
            _ => {
                let ids: Vec<String> = c.prepare("SELECT id FROM it.series")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
                if let Some(bk) = item_bk(&f.id) {
                    for i in &ids {
                        delete_comm_book(&c, i, bk)?;
                        c.execute("DELETE FROM series WHERE id=?", [i])?;
                    }
                } else {
                    for i in &ids {
                        delete_rows(&c, "comm", i)?;
                    }
                }
                c.execute_batch(
                    "INSERT INTO series(id,name,kind,unit,types,ord,coverage,note) SELECT id,name,kind,unit,types,ord,coverage,note FROM it.series;
                     INSERT INTO note(series,bk,seq,ch1,v1,ch2,v2,start_key,end_key,ref,title,text,book_id,p) SELECT series,bk,seq,ch1,v1,ch2,v2,start_key,end_key,ref,title,text,book_id,p FROM it.note;
                     INSERT INTO article(series,section,ord,title,kind,text,book_id,p1,p2) SELECT series,section,ord,title,kind,text,book_id,p1,p2 FROM it.article;
                     INSERT INTO comm_verse(comm,book,chapter,verse,html) SELECT comm,book,chapter,verse,html FROM it.comm_verse;",
                )?;
            }
        }
        Ok(())
    })();
    match r {
        Ok(()) => c.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    let _ = c.execute_batch("DETACH DATABASE it");
    Ok(())
}

fn install_item(home: &Home, ctx: &Ctx, f: &FileDecl, key: &str, st: &mut State, prog: Progress) -> Result<()> {
    let pack = item_pack(&f.kind).ok_or_else(|| anyhow::anyhow!("{}: 알 수 없는 항목 종류 {}", f.id, f.kind))?;
    let db = fetch_db(home, ctx, f, prog)?;
    let r = merge_item(home, f, &db);
    if r.is_err() {
        let _ = fs::remove_file(&db);
    }
    r?;
    let use_fts = f.fts && f.fts_ver == FTS_VER;
    if use_fts {
        keep_fts(home, &f.id, &db)?;
    } else {
        let _ = fs::remove_file(fts_path(home, &f.id));
    }
    let _ = fs::remove_file(&db);
    st.items.retain(|x| x.id != f.id);
    st.items.push(ItemRec { id: f.id.clone(), kind: f.kind.clone(), name: if f.name.is_empty() { item_key(&f.id).to_string() } else { f.name.clone() }, grp: f.grp.clone(), sha256: f.sha256.clone(), bytes: f.bytes, db_bytes: f.db_bytes, license: f.license.clone(), source: key.to_string(), fts: use_fts });
    push_unique(&mut st.installed, pack);
    Ok(())
}

/// 항목별 선언(layout: items)에서 고른 항목만 받아 통합 DB에 넣는다. 이미 같은 판이 있으면 건너뛴다.
/// 같은 id 가 다른 출처에서 먼저 들어와 있으면 먼저 받은 것을 쓴다.
pub fn add_items(home: &Home, url: &str, ids: &[String], prog: Progress) -> Result<State> {
    if crate::zipsrc::looks_zip(url) {
        return crate::zipsrc::add(home, url, ids, prog);
    }
    CANCEL.store(false, std::sync::atomic::Ordering::SeqCst);
    let ctx = Ctx::new(url)?;
    let decl = ctx.declaration()?;
    if decl.layout != "items" {
        bail!("이 선언은 항목별 형식이 아닙니다(묶음형).");
    }
    let key = source_key(url);
    let mut st = load_state(home, SID).unwrap_or(State { decl: Declaration { links: vec![], format: FORMAT.into(), layout: String::new(), title: String::new(), updated: String::new(), note: String::new(), files: vec![] }, installed: vec![], origin: String::new(), sources: vec![], hidden: vec![], pruned: vec![], items: vec![] });
    secret::store(home, &format!("src-{key}"), url)?;
    for id in ids {
        let f = decl.files.iter().find(|f| &f.id == id).ok_or_else(|| anyhow::anyhow!("선언에 없는 항목: {id}"))?;
        if let Some(r) = st.items.iter().find(|r| &r.id == id) {
            if r.source != key || r.sha256 == f.sha256 {
                continue;
            }
        }
        install_item(home, &ctx, f, &key, &mut st, prog)?;
        if !st.sources.iter().any(|s| s.key == key) {
            st.sources.push(SrcInfo { kind: String::new(), key: key.clone(), origin: ctx.origin(), title: decl.title.clone(), files: vec![] });
        }
        let si = st.sources.iter_mut().find(|s| s.key == key).unwrap();
        si.title = decl.title.clone();
        push_unique(&mut si.files, id);
        st.origin = ctx.origin();
        st.decl.updated = decl.updated.clone();
        save_state(home, &st)?;
    }
    save_state(home, &st)?;
    Ok(st)
}

/// 항목 삭제 = 통합 DB에서 그 항목의 행 삭제. 검색 색인은 `search::build_index`가 그 항목 분만 정리한다.
pub fn remove_items(home: &Home, ids: &[String]) -> Result<()> {
    let mut st = load_state(home, SID)?;
    for id in ids {
        let Some(r) = st.items.iter().find(|r| &r.id == id).cloned() else { continue };
        let pack = item_pack(&r.kind).unwrap_or("bible-i");
        if home.db_path(SID, pack).exists() {
            let c = Connection::open(home.db_path(SID, pack))?;
            match item_bk(id) {
                Some(bk) => delete_comm_book(&c, item_key(id), bk)?,
                None => delete_rows(&c, &r.kind, item_key(id))?,
            }
        }
        let _ = fs::remove_file(fts_path(home, id));
        st.items.retain(|x| &x.id != id);
        for s in &mut st.sources {
            s.files.retain(|f| f != id);
        }
    }
    for pack in ["bible-i", "orig-i", "comm-i"] {
        let has = st.items.iter().any(|r| item_pack(&r.kind) == Some(pack));
        if !has && st.installed.iter().any(|i| i == pack) {
            let _ = fs::remove_file(home.db_path(SID, pack));
            st.installed.retain(|i| i != pack);
        } else if has && home.db_path(SID, pack).exists() {
            let _ = Connection::open(home.db_path(SID, pack)).and_then(|c| c.execute_batch("VACUUM"));
        }
    }
    let gone: Vec<String> = st.sources.iter().filter(|s| s.files.is_empty()).map(|s| s.key.clone()).collect();
    for k in gone {
        let _ = secret::delete(home, &format!("src-{k}"));
    }
    st.sources.retain(|s| !s.files.is_empty());
    save_state(home, &st)
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
