//! 내려받은 DB를 읽는 유일한 모듈. 선언의 schema 값으로 분기한다(지금은 1만 지원).
use crate::source::{self, open_ro};
use crate::Home;
use anyhow::{Result, bail};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize, Clone, Debug)]
pub struct Book {
    pub n: i64,
    pub name: String,
    pub abbr: String,
    pub en: String,
    pub ch: i64,
    pub alias: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Version {
    pub id: String,
    pub name: String,
    pub grp: String,
    pub ord: i64,
    pub desc: String,
    pub kind: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct VerseRow {
    pub v: i64,
    /// (번역본 id, 본문)
    pub texts: Vec<(String, String)>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Note {
    pub id: i64,
    pub comm: String,
    pub comm_name: String,
    pub kind: String,
    pub title: String,
    pub r#ref: String,
    pub fmt: String,
    pub body: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ParseWord {
    pub i: i64,
    pub w: String,
    pub code: String,
    pub lemma: String,
    pub tr: String,
    pub parse: String,
    pub gloss: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct LexEntry {
    pub dict: String,
    pub code: String,
    pub head: String,
    pub html: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Article {
    pub id: i64,
    pub src_name: String,
    pub section: String,
    pub title: String,
    pub kind: String,
    pub chars: i64,
}

pub struct Reader {
    pub sid: String,
    home: Home,
    schema: BTreeMap<String, i64>,
}

impl Reader {
    pub fn open(home: &Home, sid: &str) -> Result<Reader> {
        let st = source::load_state(home, sid)?;
        let schema = st.decl.files.iter().map(|f| (f.id.clone(), f.schema)).collect();
        Ok(Reader { sid: sid.into(), home: home.clone(), schema })
    }

    pub fn has(&self, file: &str) -> bool {
        self.home.db_path(&self.sid, file).exists()
    }

    fn db(&self, file: &str) -> Result<Connection> {
        match self.schema.get(file) {
            Some(1) | None => {}
            Some(s) => bail!("{file}: 지원하지 않는 schema {s}"),
        }
        let p = self.home.db_path(&self.sid, file);
        if !p.exists() {
            bail!("'{file}' 자료를 받지 않았습니다");
        }
        open_ro(&p)
    }

    pub fn books(&self) -> Result<Vec<Book>> {
        let c = self.db("bible")?;
        let mut s = c.prepare("SELECT n,name,abbr,en,ch,alias FROM book ORDER BY n")?;
        let r = s.query_map([], |r| {
            let alias: String = r.get::<_, Option<String>>(5)?.unwrap_or_default();
            Ok(Book {
                n: r.get(0)?,
                name: r.get(1)?,
                abbr: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                en: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                ch: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                alias: serde_json::from_str(&alias).unwrap_or_default(),
            })
        })?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    pub fn versions(&self) -> Result<Vec<Version>> {
        let c = self.db("bible")?;
        let mut s = c.prepare("SELECT id,name,coalesce(grp,''),coalesce(ord,0),coalesce(desc,''),coalesce(kind,'text') FROM version ORDER BY grp,ord")?;
        let r = s.query_map([], |r| Ok(Version { id: r.get(0)?, name: r.get(1)?, grp: r.get(2)?, ord: r.get(3)?, desc: r.get(4)?, kind: r.get(5)? }))?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    /// 책 이름·약칭·별칭·영문 이름 또는 번호로 책 번호를 찾는다.
    pub fn resolve_book(&self, s: &str) -> Result<i64> {
        let books = self.books()?;
        let t = s.trim().trim_end_matches('.').to_lowercase();
        if let Ok(n) = t.parse::<i64>() {
            if books.iter().any(|b| b.n == n) {
                return Ok(n);
            }
        }
        for b in &books {
            if keys(b).iter().any(|k| *k == t) {
                return Ok(b.n);
            }
        }
        bail!("책을 찾을 수 없습니다: {s}")
    }

    /// "행 24:10", "사도행전 24", "Acts 24:10-12" 같은 표기. (책, 장, 절?)
    pub fn parse_ref(&self, input: &str) -> Option<(i64, i64, Option<i64>)> {
        let books = self.books().ok()?;
        let low = input.trim().to_lowercase();
        let mut best: Option<(usize, i64)> = None;
        for b in &books {
            for k in keys(b) {
                if k.is_empty() || !low.starts_with(&k) {
                    continue;
                }
                let rest = low[k.len()..].trim_start_matches(['.', ' ']);
                if rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && best.map(|(l, _)| k.len() > l).unwrap_or(true) {
                    best = Some((k.len(), b.n));
                }
            }
        }
        let (len, bk) = best?;
        let rest = low[len..].trim_start_matches(['.', ' ']);
        let (chs, vs) = match rest.split_once([':', '.']) {
            Some((a, b)) => (a, Some(b)),
            None => (rest, None),
        };
        let ch: i64 = chs.trim().parse().ok()?;
        let v = vs.and_then(|x| {
            let d: String = x.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
            d.parse().ok()
        });
        Some((bk, ch, v))
    }

    pub fn chapter(&self, bk: i64, ch: i64, vers: &[String]) -> Result<Vec<VerseRow>> {
        let c = self.db("bible")?;
        let mut rows: BTreeMap<i64, BTreeMap<String, String>> = BTreeMap::new();
        let mut s = c.prepare("SELECT v,t FROM verse WHERE ver=? AND bk=? AND ch=? ORDER BY v")?;
        for ver in vers {
            let it = s.query_map((ver, bk, ch), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            for x in it {
                let (v, t) = x?;
                rows.entry(v).or_default().insert(ver.clone(), t);
            }
        }
        Ok(rows
            .into_iter()
            .map(|(v, m)| VerseRow { v, texts: vers.iter().filter_map(|k| m.get(k).map(|t| (k.clone(), t.clone()))).collect() })
            .collect())
    }

    pub fn comm_names(&self) -> Result<Vec<(String, String)>> {
        let c = self.db("comm")?;
        let mut s = c.prepare("SELECT id,name FROM comm ORDER BY ord")?;
        let r = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    /// 구절(v가 None이면 장 전체)에 걸린 주석. 주석서 순서, 본문 순서대로.
    pub fn comm_for(&self, bk: i64, ch: i64, v: Option<i64>) -> Result<Vec<Note>> {
        let c = self.db("comm")?;
        let (lo, hi) = match v {
            Some(v) => (ch * 1000 + v, ch * 1000 + v),
            None => (ch * 1000, ch * 1000 + 999),
        };
        let mut s = c.prepare(
            "SELECT n.id,n.comm,coalesce(m.name,n.comm),coalesce(n.kind,''),coalesce(n.title,''),coalesce(n.ref,''),coalesce(n.fmt,'text'),coalesce(n.body,'')
             FROM note n LEFT JOIN comm m ON m.id=n.comm
             WHERE n.bk=?1 AND n.start_key<=?3 AND n.end_key>=?2 ORDER BY coalesce(m.ord,99),n.seq",
        )?;
        let r = s.query_map((bk, lo, hi), |r| {
            Ok(Note { id: r.get(0)?, comm: r.get(1)?, comm_name: r.get(2)?, kind: r.get(3)?, title: r.get(4)?, r#ref: r.get(5)?, fmt: r.get(6)?, body: r.get(7)? })
        })?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    pub fn parse(&self, bk: i64, ch: i64, v: i64) -> Result<Vec<ParseWord>> {
        let c = self.db("orig")?;
        let mut s = c.prepare("SELECT i,coalesce(w,''),coalesce(code,''),coalesce(lemma,''),coalesce(tr,''),coalesce(parse,''),coalesce(gloss,'') FROM parse WHERE bk=? AND ch=? AND v=? ORDER BY i")?;
        let r = s.query_map((bk, ch, v), |r| {
            Ok(ParseWord { i: r.get(0)?, w: r.get(1)?, code: r.get(2)?, lemma: r.get(3)?, tr: r.get(4)?, parse: r.get(5)?, gloss: r.get(6)? })
        })?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    /// 원어 번호("G3972", "h430", "3972")로 사전 항목을 찾는다.
    pub fn lex(&self, code: &str) -> Result<Vec<LexEntry>> {
        let c = self.db("orig")?;
        let t = code.trim().to_uppercase();
        let norm = if t.chars().all(|c| c.is_ascii_digit()) { format!("G{t}") } else { t };
        let mut s = c.prepare("SELECT dict,code,coalesce(head,''),coalesce(html,'') FROM lex WHERE code=? ORDER BY dict")?;
        let r = s.query_map([&norm], |r| Ok(LexEntry { dict: r.get(0)?, code: r.get(1)?, head: r.get(2)?, html: r.get(3)? }))?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    pub fn articles(&self) -> Result<Vec<Article>> {
        let c = self.db("comm")?;
        let mut s = c.prepare("SELECT id,coalesce(src_name,''),coalesce(section,''),coalesce(title,''),coalesce(kind,''),coalesce(chars,0) FROM article ORDER BY ord,id")?;
        let r = s.query_map([], |r| Ok(Article { id: r.get(0)?, src_name: r.get(1)?, section: r.get(2)?, title: r.get(3)?, kind: r.get(4)?, chars: r.get(5)? }))?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    pub fn stats(&self) -> Result<BTreeMap<String, i64>> {
        let mut m = BTreeMap::new();
        let q = |c: &Connection, t: &str| -> i64 { c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap_or(-1) };
        if let Ok(c) = self.db("bible") {
            m.insert("verse".into(), q(&c, "verse"));
            m.insert("version".into(), q(&c, "version"));
        }
        if let Ok(c) = self.db("orig") {
            m.insert("parse".into(), q(&c, "parse"));
            m.insert("lex".into(), q(&c, "lex"));
        }
        if let Ok(c) = self.db("comm") {
            m.insert("comm".into(), q(&c, "comm"));
            m.insert("note".into(), q(&c, "note"));
            m.insert("article".into(), q(&c, "article"));
        }
        Ok(m)
    }
}

fn keys(b: &Book) -> Vec<String> {
    let mut k = vec![b.name.to_lowercase(), b.abbr.to_lowercase(), b.en.to_lowercase()];
    k.extend(b.alias.iter().map(|a| a.to_lowercase()));
    k
}

/// 원어 번호 본문(kind=code)에서 (낱말 조각, 원어 번호) 목록을 뽑는다.
/// 표기: `총독이<a class="sc" data-c="G2232">G2232</a> ...` — 번호는 앞 낱말에 붙는다.
pub fn code_tokens(t: &str) -> Vec<(String, Option<String>)> {
    let mut out = vec![];
    let mut rest = t;
    while let Some(i) = rest.find("<a ") {
        let text = strip_tags(&rest[..i]);
        let after = &rest[i..];
        let end = after.find("</a>").map(|e| e + 4).unwrap_or(after.len());
        let tag = &after[..end];
        let code = tag.split("data-c=\"").nth(1).and_then(|x| x.split('"').next()).map(|s| s.to_string());
        out.push((text, code));
        rest = &after[end..];
    }
    let tail = strip_tags(rest);
    if !tail.trim().is_empty() {
        out.push((tail, None));
    }
    out
}

pub fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for ch in s.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let t = tag.to_lowercase();
                if t.starts_with("br") || t.starts_with("/p") || t.starts_with("/div") {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(ch),
            _ => out.push(ch),
        }
    }
    out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}
