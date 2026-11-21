//! 검색 색인(FTS5 trigram, 내용 없는 색인). 내려받은 DB와 별도 파일(index.db)에 둔다.
//! 번역본마다 표 하나(b_*), 주석 본문(cn_*), 소논문(ca_*). 숨긴 항목은 색인에 남기고 검색 결과에서 거른다. rowid = 원본 표의 rowid.
use crate::reader::{bible_files, strip_tags};
use crate::source::{self, SID, kind_of, open_ro};
use crate::Home;
use anyhow::{Result, bail};
use rusqlite::Connection;
use serde::Serialize;

fn open_index(home: &Home) -> Result<Connection> {
    std::fs::create_dir_all(home.source_dir(SID))?;
    let c = Connection::open(home.index_path(SID))?;
    c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS idx(name TEXT PRIMARY KEY, file TEXT, ver TEXT, db_sha TEXT);")?;
    let _ = c.execute("ALTER TABLE idx ADD COLUMN unit TEXT DEFAULT ''", []);
    Ok(c)
}

/// 색인 단위: 묶음형 파일은 파일 전체("" ), 항목형 통합 DB(bible-i, comm-i)는 항목 하나.
#[derive(Clone, Debug)]
struct Unit {
    file: String,
    unit: String,
    sha: String,
    /// 항목형: 번역본 id 또는 주석 시리즈 id
    key: String,
}

fn desired(home: &Home) -> Vec<Unit> {
    let Ok(st) = source::load_state(home, SID) else { return vec![] };
    let mut v = vec![];
    for f in st.installed.iter().filter(|i| matches!(kind_of(i), "bible" | "comm") && home.db_path(SID, i).exists()) {
        if f == "bible-i" || f == "comm-i" {
            let want = if f == "bible-i" { "bible" } else { "comm" };
            for r in st.items.iter().filter(|r| r.kind == want && !has_fts(home, r)) {
                v.push(Unit { file: f.clone(), unit: r.id.clone(), sha: r.sha256.clone(), key: source::item_key(&r.id).to_string() });
            }
        } else {
            let sha = st.decl.files.iter().find(|x| &x.id == f).map(|x| x.db_sha256.clone()).unwrap_or_default();
            v.push(Unit { file: f.clone(), unit: String::new(), sha, key: String::new() });
        }
    }
    v
}

/// 미리 만든 색인을 받은 항목이면 기기에서 색인하지 않는다.
fn has_fts(home: &Home, r: &source::ItemRec) -> bool {
    r.fts && source::fts_path(home, &r.id).exists()
}

/// 미리 만든 색인(trigram, detail=none)용 질의: 3글자 조각을 모두 포함(AND). 구절 질의는 이 색인에서 쓸 수 없어 결과를 본문으로 다시 확인한다.
fn tri_q(q: &str) -> Option<String> {
    let cs: Vec<char> = q.chars().collect();
    if cs.len() < 3 {
        return None;
    }
    let mut terms: Vec<String> = vec![];
    for w in cs.windows(3) {
        let t: String = w.iter().collect::<String>().replace('"', "\"\"");
        let t = format!("\"{t}\"");
        if !terms.contains(&t) {
            terms.push(t);
        }
    }
    Some(terms.join(" AND "))
}

fn contains_ci(text: &str, q: &str) -> bool {
    strip_tags(text).to_lowercase().contains(&q.to_lowercase())
}

fn fts_ids(home: &Home, id: &str, tab: &str, q: &str, n: usize) -> Vec<i64> {
    let Some(m) = tri_q(q) else { return vec![] };
    let Ok(c) = Connection::open_with_flags(source::fts_path(home, id), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return vec![] };
    let Ok(mut s) = c.prepare(&format!("SELECT rowid FROM \"{tab}\" WHERE \"{tab}\" MATCH ?1 ORDER BY rowid LIMIT ?2")) else { return vec![] };
    s.query_map((m, n as i64), |r| r.get(0)).map(|it| it.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    source::hex(&Sha256::digest(s.as_bytes()))[..8].to_string()
}

#[derive(Serialize, Clone, Debug)]
pub struct IndexStatus {
    pub ready: bool,
    /// 아직 색인이 없는 묶음 id
    pub pending: Vec<String>,
}

fn built(idx: &Connection, u: &Unit) -> bool {
    idx.query_row("SELECT count(*) FROM idx WHERE file=? AND unit=? AND db_sha=?", (&u.file, &u.unit, &u.sha), |r| r.get::<_, i64>(0)).map(|n| n > 0).unwrap_or(false)
}

pub fn status(home: &Home) -> IndexStatus {
    let idx = Connection::open(home.index_path(SID)).ok().filter(|c| c.prepare("SELECT unit FROM idx LIMIT 1").is_ok());
    let mut pending: Vec<String> = vec![];
    for u in desired(home) {
        let ok = idx.as_ref().map(|c| built(c, &u)).unwrap_or(false);
        if !ok && !pending.contains(&u.file) {
            pending.push(u.file.clone());
        }
    }
    IndexStatus { ready: pending.is_empty(), pending }
}

fn drop_unit(idx: &Connection, file: &str, unit: &str) -> Result<()> {
    let names: Vec<String> = {
        let mut s = idx.prepare("SELECT name FROM idx WHERE file=? AND unit=?")?;
        s.query_map((file, unit), |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    for n in names {
        idx.execute_batch(&format!("DROP TABLE IF EXISTS \"{n}\""))?;
    }
    idx.execute("DELETE FROM idx WHERE file=? AND unit=?", (file, unit))?;
    Ok(())
}

/// 설치된 자료 중 색인이 없는(또는 바뀐) 단위만 만든다. 항목을 추가·삭제하면 그 항목 분만 고친다.
/// 오래 걸리므로 백그라운드에서 부른다.
pub fn build_index(home: &Home, prog: &mut dyn FnMut(&str, u64, u64)) -> Result<()> {
    let idx = open_index(home)?;
    let want = desired(home);
    let existing: Vec<(String, String, String)> = {
        let mut s = idx.prepare("SELECT DISTINCT file,unit,db_sha FROM idx")?;
        s.query_map([], |r| Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get::<_, Option<String>>(2)?.unwrap_or_default())))?.collect::<rusqlite::Result<_>>()?
    };
    for (f, u, sha) in &existing {
        if !want.iter().any(|w| &w.file == f && &w.unit == u && &w.sha == sha) {
            drop_unit(&idx, f, u)?;
        }
    }
    for u in want {
        if built(&idx, &u) {
            continue;
        }
        let file = u.file.clone();
        let src = open_ro(&home.db_path(SID, &file))?;
        let fq = file.replace('-', "_");
        let hs = short_hash(&u.unit);
        let label = if u.unit.is_empty() { format!("{file} 검색 색인 만드는 중") } else { format!("{} 검색 색인 만드는 중", source::item_key(&u.unit)) };
        idx.execute_batch("PRAGMA synchronous=OFF; BEGIN")?;
        let r: Result<()> = (|| {
            let reg = |name: &str, ver: &str| idx.execute("INSERT INTO idx(name,file,ver,db_sha,unit) VALUES(?,?,?,'',?)", (name, &file, ver, &u.unit));
            if kind_of(&file) == "bible" {
                // 묶음형: 파일 안의 모든 번역본, 항목형: 번역본 하나
                let vers: Vec<String> = if u.unit.is_empty() {
                    let mut s = src.prepare("SELECT id FROM version ORDER BY ord")?;
                    s.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
                } else {
                    vec![u.key.clone()]
                };
                let mut tab = std::collections::HashMap::new();
                for (i, v) in vers.iter().enumerate() {
                    let name = if u.unit.is_empty() { format!("b_{fq}_{i}") } else { format!("b_{fq}_u{hs}") };
                    idx.execute_batch(&format!("CREATE VIRTUAL TABLE \"{name}\" USING fts5(t, content='', tokenize='trigram')"))?;
                    reg(&name, v)?;
                    tab.insert(v.clone(), format!("INSERT INTO \"{name}\"(rowid,t) VALUES(?,?)"));
                }
                let total: i64 = if u.unit.is_empty() { src.query_row("SELECT count(*) FROM verse", [], |r| r.get(0))? } else { src.query_row("SELECT count(*) FROM verse WHERE version=?", [&u.key], |r| r.get(0))? };
                let mut s = if u.unit.is_empty() { src.prepare("SELECT rowid,version,text FROM verse")? } else { src.prepare("SELECT rowid,version,text FROM verse WHERE version=?1")? };
                let mut rows = if u.unit.is_empty() { s.query([])? } else { s.query([&u.key])? };
                let mut n = 0u64;
                while let Some(r) = rows.next()? {
                    let ver: String = r.get(1)?;
                    if let Some(sql) = tab.get(&ver) {
                        let t: String = r.get::<_, Option<String>>(2)?.unwrap_or_default();
                        idx.prepare_cached(sql)?.execute((r.get::<_, i64>(0)?, strip_tags(&t)))?;
                    }
                    n += 1;
                    if n % 20000 == 0 {
                        prog(&label, n, total as u64);
                    }
                }
                prog(&label, total as u64, total as u64);
            } else {
                let (nn, na, vn, va) = if u.unit.is_empty() { (format!("cn_{fq}"), format!("ca_{fq}"), "note".to_string(), "art".to_string()) } else { (format!("cn_{fq}_u{hs}"), format!("ca_{fq}_u{hs}"), format!("note:{}", u.key), format!("art:{}", u.key)) };
                idx.execute_batch(&format!("CREATE VIRTUAL TABLE \"{nn}\" USING fts5(t, content='', tokenize='trigram'); CREATE VIRTUAL TABLE \"{na}\" USING fts5(t, content='', tokenize='trigram');"))?;
                reg(&nn, &vn)?;
                reg(&na, &va)?;
                let filt = if u.unit.is_empty() { "" } else { " WHERE series=?1" };
                let total: i64 = if u.unit.is_empty() { src.query_row("SELECT (SELECT count(*) FROM note)+(SELECT count(*) FROM article)", [], |r| r.get(0))? } else { src.query_row("SELECT (SELECT count(*) FROM note WHERE series=?1)+(SELECT count(*) FROM article WHERE series=?1)", [&u.key], |r| r.get(0))? };
                let mut n = 0u64;
                for (tab, tb) in [(&nn, "note"), (&na, "article")] {
                    let mut s = src.prepare(&format!("SELECT id,coalesce(title,'')||char(10)||coalesce(text,'') FROM {tb}{filt}"))?;
                    let mut rows = if u.unit.is_empty() { s.query([])? } else { s.query([&u.key])? };
                    let ins = format!("INSERT INTO \"{tab}\"(rowid,t) VALUES(?,?)");
                    while let Some(r) = rows.next()? {
                        idx.prepare_cached(&ins)?.execute((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))?;
                        n += 1;
                        if n % 5000 == 0 {
                            prog(&label, n, total as u64);
                        }
                    }
                }
                // 절별 해설(comm_verse): 파일로 가져온 주석(series.kind='cdb')만. 서버 DB의 것은 앞 절을 이어 쓴 중복이라 뺀다.
                let cv = if u.unit.is_empty() { format!("cv_{fq}") } else { format!("cv_{fq}_u{hs}") };
                idx.execute_batch(&format!("CREATE VIRTUAL TABLE \"{cv}\" USING fts5(t, content='', tokenize='trigram')"))?;
                reg(&cv, &if u.unit.is_empty() { "cv".to_string() } else { format!("cv:{}", u.key) })?;
                let cond = if u.unit.is_empty() { "comm IN (SELECT id FROM series WHERE kind='cdb')" } else { "comm=?1 AND comm IN (SELECT id FROM series WHERE kind='cdb')" };
                let mut s = src.prepare(&format!("SELECT rowid,html FROM comm_verse WHERE {cond}"))?;
                let mut rows = if u.unit.is_empty() { s.query([])? } else { s.query([&u.key])? };
                while let Some(r) = rows.next()? {
                    idx.prepare_cached(&format!("INSERT INTO \"{cv}\"(rowid,t) VALUES(?,?)"))?.execute((r.get::<_, i64>(0)?, strip_tags(&r.get::<_, Option<String>>(1)?.unwrap_or_default())))?;
                }
                prog(&label, total as u64, total as u64);
            }
            idx.execute("UPDATE idx SET db_sha=? WHERE file=? AND unit=?", (&u.sha, &file, &u.unit))?;
            Ok(())
        })();
        match r {
            Ok(()) => idx.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = idx.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    /// bible | comm | article
    pub area: String,
    /// 번역본 id 또는 주석서(시리즈) id
    pub src: String,
    pub bk: i64,
    pub ch: i64,
    pub v: i64,
    pub ref_: String,
    pub note_id: i64,
    pub snippet: String,
}

fn snippet(text: &str, q: &str) -> String {
    let t: Vec<char> = strip_tags(text).replace('\n', " ").chars().collect();
    let ql: Vec<char> = q.to_lowercase().chars().collect();
    let tl: Vec<char> = t.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let pos = if ql.is_empty() { None } else { (0..tl.len().saturating_sub(ql.len() - 1)).find(|&i| tl[i..i + ql.len()] == ql[..]) };
    match pos {
        Some(i) => {
            let a = i.saturating_sub(24);
            let b = (i + ql.len() + 48).min(t.len());
            let s = |r: std::ops::Range<usize>| t[r].iter().collect::<String>();
            format!("{}{}[{}]{}{}", if a > 0 { "…" } else { "" }, s(a..i), s(i..i + ql.len()), s(i + ql.len()..b), if b < t.len() { "…" } else { "" })
        }
        None => t.iter().take(70).collect(),
    }
}

fn fts_q(q: &str) -> String {
    format!("\"{}\"", q.replace('"', "\"\""))
}

/// area: "bible"(vers 로 고른 번역본들) 또는 "comm"(주석 본문과 소논문).
pub fn search(home: &Home, q: &str, area: &str, vers: &[String], limit: usize) -> Result<Vec<Hit>> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let short = q.chars().count() < 3;
    let st = status(home);
    let idx = Connection::open(home.index_path(SID)).ok();
    let mut out = vec![];
    if area == "comm" {
        let hidden = source::load_state(home, SID).map(|s| s.hidden).unwrap_or_default();
        let comms: Vec<String> = wanted_files(home).into_iter().filter(|f| kind_of(f) == "comm").collect();
        let stt = source::load_state(home, SID).ok();
        let fts_comm: Vec<source::ItemRec> = stt.as_ref().map(|s| s.items.iter().filter(|r| r.kind == "comm" && has_fts(home, r) && !hidden.contains(&format!("s:{}", source::item_key(&r.id)))).cloned().collect()).unwrap_or_default();
        if comms.is_empty() && fts_comm.is_empty() {
            bail!("주석 자료를 받지 않았습니다.");
        }
        // 짧은 검색어(2글자 이하)는 색인 없이 본문을 훑는다: 주석이 든 통합 DB 전체
        let scan: Vec<String> = if short { stt.as_ref().map(|s| s.installed.iter().filter(|i| kind_of(i) == "comm" && home.db_path(SID, i).exists()).cloned().collect()).unwrap_or_default() } else { comms.clone() };
        if st.pending.iter().any(|p| comms.contains(p)) || idx.is_none() {
            bail!("주석 검색 색인을 아직 만들지 못했습니다. 자료 출처 화면의 색인 진행률을 확인하세요.");
        }
        let idx = idx.as_ref().unwrap();
        let mut tabs: Vec<(String, String, String)> = vec![];
        {
            let mut s = idx.prepare("SELECT name,file,ver FROM idx WHERE ver='note' OR ver LIKE 'note:%' OR ver='art' OR ver LIKE 'art:%' OR ver='cv' OR ver LIKE 'cv:%' ORDER BY name")?;
            for x in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
                tabs.push(x?);
            }
        }
        for file in &scan {
            let src = open_ro(&home.db_path(SID, file))?;
            let mk = |r: &rusqlite::Row| -> rusqlite::Result<Hit> {
                let key: i64 = r.get(2)?;
                Ok(Hit { area: "comm".into(), src: r.get(0)?, bk: r.get(1)?, ch: key / 1000, v: key % 1000, ref_: r.get::<_, Option<String>>(3)?.unwrap_or_default(), note_id: r.get(4)?, snippet: snippet(&r.get::<_, String>(5)?, q) })
            };
            if short {
                let mut s = src.prepare("SELECT series,bk,start_key,ref,id,coalesce(title,'')||char(10)||coalesce(text,'') FROM note WHERE title LIKE '%'||?1||'%' OR text LIKE '%'||?1||'%' LIMIT ?2")?;
                let mut rows = s.query((q, (limit * 30) as i64))?;
                while let Some(r) = rows.next()? {
                    let h = mk(r)?;
                    if !hidden.contains(&format!("s:{}", h.src)) && out.len() < limit {
                        out.push(h);
                    }
                }
                continue;
            }
            let mut ns = src.prepare("SELECT series,bk,start_key,ref,id,coalesce(title,'')||char(10)||coalesce(text,'') FROM note WHERE id=?")?;
            let mut cvs = src.prepare("SELECT comm,book,chapter,verse,coalesce(html,'') FROM comm_verse WHERE rowid=?")?;
            let mut as_ = src.prepare("SELECT series,coalesce(title,''),id,coalesce(title,'')||char(10)||coalesce(text,'') FROM article WHERE id=?")?;
            for (name, f, ver) in tabs.iter().filter(|t| &t.1 == file) {
                let _ = f;
                let is_note = ver.starts_with("note");
                let is_cv = ver.starts_with("cv");
                let ids: Vec<i64> = {
                    let mut s = idx.prepare(&format!("SELECT rowid FROM \"{name}\" WHERE \"{name}\" MATCH ?1 ORDER BY rank LIMIT ?2"))?;
                    s.query_map((fts_q(q), if is_note || is_cv { (limit * 2) as i64 } else { 20 }), |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
                };
                for id in ids {
                    if is_cv {
                        if let Ok(h) = cvs.query_row([id], |r| Ok(Hit { area: "comm".into(), src: r.get(0)?, bk: r.get(1)?, ch: r.get(2)?, v: r.get(3)?, ref_: format!("{}:{}", r.get::<_, i64>(2)?, r.get::<_, i64>(3)?), note_id: 0, snippet: snippet(&r.get::<_, String>(4)?, q) })) {
                            if !hidden.contains(&format!("s:{}", h.src)) && out.len() < limit {
                                out.push(h);
                            }
                        }
                    } else if is_note {
                        if let Ok(h) = ns.query_row([id], |r| mk(r)) {
                            if !hidden.contains(&format!("s:{}", h.src)) && out.len() < limit {
                                out.push(h);
                            }
                        }
                    } else if let Ok(h) = as_.query_row([id], |r| Ok(Hit { area: "article".into(), src: r.get(0)?, bk: 0, ch: 0, v: 0, ref_: r.get(1)?, note_id: r.get(2)?, snippet: snippet(&r.get::<_, String>(3)?, q) })) {
                        if !hidden.contains(&format!("s:{}", h.src)) {
                            out.push(h);
                        }
                    }
                }
            }
        }
        // 미리 만든 색인을 받은 주석: 항목마다 색인 파일을 조회
        if !short && !fts_comm.is_empty() {
            let src = open_ro(&home.db_path(SID, "comm-i"))?;
            let mut ns = src.prepare("SELECT series,bk,start_key,ref,id,coalesce(title,'')||char(10)||coalesce(text,'') FROM note WHERE series=?1 AND bk=?2 AND seq=?3")?;
            let mut as_ = src.prepare("SELECT series,coalesce(title,''),id,coalesce(title,'')||char(10)||coalesce(text,'') FROM article WHERE series=?1 AND ord=?2")?;
            let mut cvs = src.prepare("SELECT comm,book,chapter,verse,coalesce(html,'') FROM comm_verse WHERE comm=?1 AND book=?2 AND chapter=?3 AND verse=?4")?;
            for it in &fts_comm {
                let key = source::item_key(&it.id).to_string();
                let mut n = 0;
                for id in fts_ids(home, &it.id, "f_n", q, limit * 6) {
                    if n >= limit {
                        break;
                    }
                    let (bk, seq) = (id / 1_000_000, id % 1_000_000);
                    if let Ok(Some(h)) = ns.query_row((&key, bk, seq), |r| {
                        let k: i64 = r.get(2)?;
                        let body: String = r.get(5)?;
                        Ok(contains_ci(&body, q).then(|| Hit { area: "comm".into(), src: r.get(0).unwrap_or_default(), bk: r.get(1).unwrap_or(0), ch: k / 1000, v: k % 1000, ref_: r.get::<_, Option<String>>(3).ok().flatten().unwrap_or_default(), note_id: r.get(4).unwrap_or(0), snippet: snippet(&body, q) }))
                    }) {
                        out.push(h);
                        n += 1;
                    }
                }
                for id in fts_ids(home, &it.id, "f_a", q, 100) {
                    if let Ok(Some(h)) = as_.query_row((&key, id), |r| {
                        let body: String = r.get(3)?;
                        Ok(contains_ci(&body, q).then(|| Hit { area: "article".into(), src: r.get(0).unwrap_or_default(), bk: 0, ch: 0, v: 0, ref_: r.get(1).unwrap_or_default(), note_id: r.get(2).unwrap_or(0), snippet: snippet(&body, q) }))
                    }) {
                        out.push(h);
                    }
                }
                for id in fts_ids(home, &it.id, "f_v", q, limit * 6) {
                    if n >= limit {
                        break;
                    }
                    let (b, c, v) = (id / 100_000_000, (id / 10_000) % 10_000, id % 10_000);
                    let mut rows = cvs.query((&key, b, c, v))?;
                    while let Some(r) = rows.next()? {
                        let html: String = r.get(4)?;
                        if contains_ci(&html, q) {
                            out.push(Hit { area: "comm".into(), src: r.get(0)?, bk: b, ch: c, v, ref_: format!("{c}:{v}"), note_id: 0, snippet: snippet(&html, q) });
                            n += 1;
                            break;
                        }
                    }
                }
            }
        }
        return Ok(out);
    }
    // 성경 본문
    let files = bible_files(home);
    let all = crate::reader::Reader::open(home)?.versions()?;
    let mut picked: Vec<String> = vers.to_vec();
    picked.retain(|v| all.iter().any(|x| &x.id == v && x.kind == "text"));
    if picked.is_empty() {
        picked = all.iter().filter(|x| x.kind == "text").take(1).map(|x| x.id.clone()).collect();
    }
    for ver in picked {
        let Some(vi) = all.iter().find(|x| x.id == ver) else { continue };
        if !files.contains(&vi.file) {
            continue;
        }
        let pre = source::load_state(home, SID).ok().and_then(|st| st.items.into_iter().find(|r| r.id == format!("bible:{ver}") && has_fts(home, r)));
        if let (Some(it), false) = (&pre, short) {
            let src = open_ro(&home.db_path(SID, &vi.file))?;
            let mut s = src.prepare("SELECT text FROM verse WHERE version=?1 AND book=?2 AND chapter=?3 AND verse=?4")?;
            let mut n = 0;
            for id in fts_ids(home, &it.id, "f_t", q, limit * 6) {
                if n >= limit {
                    break;
                }
                let (b, c, v) = (id / 100_000_000, (id / 10_000) % 10_000, id % 10_000);
                let mut rows = s.query((&ver, b, c, v))?;
                while let Some(r) = rows.next()? {
                    let t: String = r.get::<_, Option<String>>(0)?.unwrap_or_default();
                    if contains_ci(&t, q) {
                        out.push(Hit { area: "bible".into(), src: ver.clone(), bk: b, ch: c, v, ref_: String::new(), note_id: 0, snippet: snippet(&t, q) });
                        n += 1;
                        break;
                    }
                }
            }
            if out.len() >= limit {
                out.truncate(limit);
                break;
            }
            continue;
        }
        let have_idx = idx.as_ref().map(|c| c.query_row("SELECT count(*) FROM idx WHERE file=? AND ver=?", (&vi.file, &ver), |r| r.get::<_, i64>(0)).unwrap_or(0) > 0).unwrap_or(false);
        if !have_idx && !short {
            bail!("성경 검색 색인을 아직 만드는 중입니다. 자료 출처 화면의 진행률을 확인하세요.");
        }
        let src = open_ro(&home.db_path(SID, &vi.file))?;
        let per = (limit / 1).max(1) as i64;
        let ids: Vec<i64> = if short {
            let mut s = src.prepare("SELECT rowid FROM verse WHERE version=?1 AND text LIKE '%'||?2||'%' LIMIT ?3")?;
            s.query_map((&ver, q, per), |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        } else {
            let idx = idx.as_ref().ok_or_else(|| anyhow::anyhow!("검색 색인이 없습니다"))?;
            let name: String = idx.query_row("SELECT name FROM idx WHERE file=? AND ver=?", (&vi.file, &ver), |r| r.get(0))?;
            let mut s = idx.prepare(&format!("SELECT rowid FROM \"{name}\" WHERE \"{name}\" MATCH ?1 LIMIT ?2"))?;
            s.query_map((fts_q(q), per), |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        let mut s = src.prepare("SELECT book,chapter,verse,text FROM verse WHERE rowid=?")?;
        for id in ids {
            if let Ok(h) = s.query_row([id], |r| Ok(Hit { area: "bible".into(), src: ver.clone(), bk: r.get(0)?, ch: r.get(1)?, v: r.get(2)?, ref_: String::new(), note_id: 0, snippet: snippet(&r.get::<_, Option<String>>(3)?.unwrap_or_default(), q) })) {
                out.push(h);
            }
        }
        if out.len() >= limit {
            out.truncate(limit);
            break;
        }
    }
    Ok(out)
}

fn wanted_files(home: &Home) -> Vec<String> {
    let mut v: Vec<String> = vec![];
    for u in desired(home) {
        if !v.contains(&u.file) {
            v.push(u.file);
        }
    }
    v
}
