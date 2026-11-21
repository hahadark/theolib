//! 검색 색인(FTS5 trigram, 내용 없는 색인). 내려받은 DB와 별도 파일(index.db)에 둔다.
//! 번역본마다 표 하나(b_N), 주석 본문(c_note), 소논문(c_art). rowid = 원본 표의 rowid.
use crate::reader::{bible_files, strip_tags};
use crate::source::{self, SID, open_ro};
use crate::Home;
use anyhow::{Result, bail};
use rusqlite::Connection;
use serde::Serialize;

fn open_index(home: &Home) -> Result<Connection> {
    std::fs::create_dir_all(home.source_dir(SID))?;
    let c = Connection::open(home.index_path(SID))?;
    c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS idx(name TEXT PRIMARY KEY, file TEXT, ver TEXT, db_sha TEXT);")?;
    Ok(c)
}

fn db_sha(home: &Home, file: &str) -> String {
    source::load_state(home, SID).ok().and_then(|s| s.decl.files.iter().find(|f| f.id == file).map(|f| f.db_sha256.clone())).unwrap_or_default()
}

fn wanted(home: &Home) -> Vec<String> {
    let mut v = bible_files(home);
    if home.db_path(SID, "comm").exists() && source::load_state(home, SID).map(|s| s.installed.iter().any(|i| i == "comm")).unwrap_or(false) {
        v.push("comm".into());
    }
    v
}

#[derive(Serialize, Clone, Debug)]
pub struct IndexStatus {
    pub ready: bool,
    /// 아직 색인이 없는 묶음 id
    pub pending: Vec<String>,
}

pub fn status(home: &Home) -> IndexStatus {
    let pending: Vec<String> = match Connection::open(home.index_path(SID)).ok() {
        Some(c) => wanted(home)
            .into_iter()
            .filter(|f| {
                let sha = db_sha(home, f);
                c.query_row("SELECT count(*) FROM idx WHERE file=? AND db_sha=?", (f, &sha), |r| r.get::<_, i64>(0)).map(|n| n == 0).unwrap_or(true)
            })
            .collect(),
        None => wanted(home),
    };
    IndexStatus { ready: pending.is_empty(), pending }
}

fn drop_file(idx: &Connection, file: &str) -> Result<()> {
    let names: Vec<String> = {
        let mut s = idx.prepare("SELECT name FROM idx WHERE file=?")?;
        s.query_map([file], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    for n in names {
        idx.execute_batch(&format!("DROP TABLE IF EXISTS \"{n}\""))?;
    }
    idx.execute("DELETE FROM idx WHERE file=?", [file])?;
    Ok(())
}

/// 설치된 모든 묶음 중 색인이 없는(또는 DB가 바뀐) 것을 만든다. 오래 걸리므로 백그라운드에서 부른다.
pub fn build_index(home: &Home, prog: &mut dyn FnMut(&str, u64, u64)) -> Result<()> {
    let idx = open_index(home)?;
    let want = wanted(home);
    // 설치에서 빠진 묶음의 색인 제거
    let files: Vec<String> = {
        let mut s = idx.prepare("SELECT DISTINCT file FROM idx")?;
        s.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    for f in files.iter().filter(|f| !want.contains(f)) {
        drop_file(&idx, f)?;
    }
    for file in want {
        let sha = db_sha(home, &file);
        let have: i64 = idx.query_row("SELECT count(*) FROM idx WHERE file=? AND db_sha=?", (&file, &sha), |r| r.get(0))?;
        if have > 0 {
            continue;
        }
        drop_file(&idx, &file)?;
        let src = open_ro(&home.db_path(SID, &file))?;
        let label = format!("{file} 검색 색인 만드는 중");
        idx.execute_batch("PRAGMA synchronous=OFF; BEGIN")?;
        let r: Result<()> = (|| {
            if file.starts_with("bible-") {
                let vers: Vec<String> = {
                    let mut s = src.prepare("SELECT id FROM version ORDER BY ord")?;
                    s.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
                };
                let mut tab = std::collections::HashMap::new();
                for (i, v) in vers.iter().enumerate() {
                    let name = format!("b_{}_{}", file.replace('-', "_"), i);
                    idx.execute_batch(&format!("CREATE VIRTUAL TABLE \"{name}\" USING fts5(t, content='', tokenize='trigram')"))?;
                    idx.execute("INSERT INTO idx(name,file,ver,db_sha) VALUES(?,?,?,'')", (&name, &file, v))?;
                    tab.insert(v.clone(), format!("INSERT INTO \"{name}\"(rowid,t) VALUES(?,?)"));
                }
                let total: i64 = src.query_row("SELECT count(*) FROM verse", [], |r| r.get(0))?;
                let mut s = src.prepare("SELECT rowid,version,text FROM verse")?;
                let mut rows = s.query([])?;
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
                idx.execute_batch("CREATE VIRTUAL TABLE c_note USING fts5(t, content='', tokenize='trigram'); CREATE VIRTUAL TABLE c_art USING fts5(t, content='', tokenize='trigram');")?;
                idx.execute("INSERT INTO idx(name,file,ver,db_sha) VALUES('c_note',?,'','')", [&file])?;
                idx.execute("INSERT INTO idx(name,file,ver,db_sha) VALUES('c_art',?,'','')", [&file])?;
                let total: i64 = src.query_row("SELECT (SELECT count(*) FROM note)+(SELECT count(*) FROM article)", [], |r| r.get(0))?;
                let mut n = 0u64;
                for (sql, ins) in [("SELECT id,coalesce(title,'')||char(10)||coalesce(text,'') FROM note", "INSERT INTO c_note(rowid,t) VALUES(?,?)"), ("SELECT id,coalesce(title,'')||char(10)||coalesce(text,'') FROM article", "INSERT INTO c_art(rowid,t) VALUES(?,?)")] {
                    let mut s = src.prepare(sql)?;
                    let mut rows = s.query([])?;
                    while let Some(r) = rows.next()? {
                        idx.prepare_cached(ins)?.execute((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))?;
                        n += 1;
                        if n % 5000 == 0 {
                            prog(&label, n, total as u64);
                        }
                    }
                }
                prog(&label, total as u64, total as u64);
            }
            // 이 묶음의 색인이 끝났음을 db_sha 로 표시
            idx.execute("UPDATE idx SET db_sha=? WHERE file=?", (&sha, &file))?;
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
        if st.pending.iter().any(|p| p == "comm") || idx.is_none() {
            bail!("주석 검색 색인을 아직 만들지 못했습니다. 자료 출처 화면의 색인 진행률을 확인하세요.");
        }
        let src = open_ro(&home.db_path(SID, "comm"))?;
        if short {
            let mut s = src.prepare("SELECT series,bk,start_key,ref,id,coalesce(title,'')||char(10)||coalesce(text,'') FROM note WHERE title LIKE '%'||?1||'%' OR text LIKE '%'||?1||'%' LIMIT ?2")?;
            let mut rows = s.query((q, limit as i64))?;
            while let Some(r) = rows.next()? {
                let key: i64 = r.get(2)?;
                out.push(Hit { area: "comm".into(), src: r.get(0)?, bk: r.get(1)?, ch: key / 1000, v: key % 1000, ref_: r.get::<_, Option<String>>(3)?.unwrap_or_default(), note_id: r.get(4)?, snippet: snippet(&r.get::<_, String>(5)?, q) });
            }
        } else {
            let idx = idx.unwrap();
            let ids: Vec<i64> = {
                let mut s = idx.prepare("SELECT rowid FROM c_note WHERE c_note MATCH ?1 ORDER BY rank LIMIT ?2")?;
                s.query_map((fts_q(q), limit as i64), |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
            };
            let mut s = src.prepare("SELECT series,bk,start_key,ref,id,coalesce(title,'')||char(10)||coalesce(text,'') FROM note WHERE id=?")?;
            for id in ids {
                if let Ok(h) = s.query_row([id], |r| {
                    let key: i64 = r.get(2)?;
                    Ok(Hit { area: "comm".into(), src: r.get(0)?, bk: r.get(1)?, ch: key / 1000, v: key % 1000, ref_: r.get::<_, Option<String>>(3)?.unwrap_or_default(), note_id: r.get(4)?, snippet: snippet(&r.get::<_, String>(5)?, q) })
                }) {
                    out.push(h);
                }
            }
            let aids: Vec<i64> = {
                let mut s = idx.prepare("SELECT rowid FROM c_art WHERE c_art MATCH ?1 ORDER BY rank LIMIT 20")?;
                s.query_map([fts_q(q)], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
            };
            let mut s = src.prepare("SELECT series,coalesce(title,''),id,coalesce(title,'')||char(10)||coalesce(text,'') FROM article WHERE id=?")?;
            for id in aids {
                if let Ok(h) = s.query_row([id], |r| Ok(Hit { area: "article".into(), src: r.get(0)?, bk: 0, ch: 0, v: 0, ref_: r.get(1)?, note_id: r.get(2)?, snippet: snippet(&r.get::<_, String>(3)?, q) })) {
                    out.push(h);
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
        if st.pending.iter().any(|p| *p == vi.file) && !short {
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
