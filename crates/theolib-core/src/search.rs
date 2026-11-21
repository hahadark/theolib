//! 검색 색인(FTS5 trigram). 내려받은 DB와 별도 파일(index.db)에 둔다.
use crate::reader::strip_tags;
use crate::source::open_ro;
use crate::Home;
use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

fn open_index(home: &Home, sid: &str) -> Result<Connection> {
    let c = Connection::open(home.index_path(sid))?;
    c.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS bible_fts USING fts5(t, ver UNINDEXED, bk UNINDEXED, ch UNINDEXED, v UNINDEXED, tokenize='trigram');
         CREATE VIRTUAL TABLE IF NOT EXISTS comm_fts USING fts5(t, comm UNINDEXED, note_id UNINDEXED, bk UNINDEXED, ref UNINDEXED, tokenize='trigram');",
    )?;
    Ok(c)
}

/// 파일 id(bible 또는 comm)의 색인을 처음부터 다시 만든다.
pub fn rebuild(home: &Home, sid: &str, file: &str) -> Result<usize> {
    let idx = open_index(home, sid)?;
    let src = open_ro(&home.db_path(sid, file))?;
    idx.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; BEGIN")?;
    let mut n = 0;
    match file {
        "bible" => {
            idx.execute("DELETE FROM bible_fts", [])?;
            let mut s = src.prepare("SELECT v.ver,v.bk,v.ch,v.v,v.t FROM verse v JOIN version x ON x.id=v.ver WHERE coalesce(x.kind,'text')='text'")?;
            let mut ins = idx.prepare("INSERT INTO bible_fts(t,ver,bk,ch,v) VALUES(?,?,?,?,?)")?;
            let mut rows = s.query([])?;
            while let Some(r) = rows.next()? {
                ins.execute((strip_tags(&r.get::<_, String>(4)?), r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))?;
                n += 1;
            }
        }
        "comm" => {
            idx.execute("DELETE FROM comm_fts", [])?;
            let mut s = src.prepare("SELECT id,comm,bk,coalesce(ref,''),coalesce(title,''),coalesce(body,''),coalesce(fmt,'text') FROM note")?;
            let mut ins = idx.prepare("INSERT INTO comm_fts(t,comm,note_id,bk,ref) VALUES(?,?,?,?,?)")?;
            let mut rows = s.query([])?;
            while let Some(r) = rows.next()? {
                let body: String = r.get(5)?;
                let fmt: String = r.get(6)?;
                let text = if fmt == "html" { strip_tags(&body) } else { body };
                let title: String = r.get(4)?;
                ins.execute((format!("{title}\n{text}"), r.get::<_, String>(1)?, r.get::<_, i64>(0)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))?;
                n += 1;
            }
        }
        _ => {}
    }
    idx.execute_batch("COMMIT")?;
    Ok(n)
}

#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    pub area: String,
    /// 번역본 id 또는 주석서 id
    pub src: String,
    pub bk: i64,
    pub ch: i64,
    pub v: i64,
    pub ref_: String,
    pub note_id: i64,
    pub snippet: String,
}

pub fn search(home: &Home, sid: &str, q: &str, area: &str, limit: usize) -> Result<Vec<Hit>> {
    let idx = open_index(home, sid)?;
    let q = q.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let short = q.chars().count() < 3;
    let (table, cols) = if area == "comm" { ("comm_fts", "comm,note_id,bk,ref") } else { ("bible_fts", "ver,bk,ch,v") };
    let sql = if short {
        format!("SELECT {cols}, substr(t, max(1, instr(t, ?1) - 20), 60) FROM {table} WHERE t LIKE '%' || ?1 || '%' LIMIT ?2")
    } else {
        format!("SELECT {cols}, snippet({table}, 0, '[', ']', '…', 12) FROM {table} WHERE {table} MATCH ?1 ORDER BY rank LIMIT ?2")
    };
    let m = if short { q.to_string() } else { format!("\"{}\"", q.replace('"', "\"\"")) };
    let mut s = idx.prepare(&sql)?;
    let lim = limit as i64;
    let mut out = vec![];
    let mut rows = s.query((m, lim))?;
    while let Some(r) = rows.next()? {
        if area == "comm" {
            let rf: String = r.get(3)?;
            let (ch, v) = parse_ref_pos(&rf);
            out.push(Hit { area: "comm".into(), src: r.get(0)?, note_id: r.get(1)?, bk: r.get(2)?, ch, v, ref_: rf, snippet: r.get(4)? });
        } else {
            out.push(Hit { area: "bible".into(), src: r.get(0)?, bk: r.get(1)?, ch: r.get(2)?, v: r.get(3)?, ref_: String::new(), note_id: 0, snippet: r.get(4)? });
        }
    }
    Ok(out)
}

/// 주석 ref("24:10-12", "24장")에서 시작 장·절.
fn parse_ref_pos(r: &str) -> (i64, i64) {
    let d = |s: &str| s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<i64>().unwrap_or(0);
    match r.split_once(':') {
        Some((a, b)) => (d(a), d(b)),
        None => (d(r), 0),
    }
}
