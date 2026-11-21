//! 내려받은 DB를 읽는 유일한 모듈. 실제 표 구조(bible-*: version/verse, orig: code_version/code_verse/lex,
//! comm: series/note/article/comm_verse)를 읽는다. 선언의 schema 가 다른 형태면 여기서 분기한다.
use crate::books;
pub use crate::books::Book;
use crate::source::{self, SID, open_ro};
use crate::Home;
use anyhow::{Result, bail};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize, Clone, Debug)]
pub struct Version {
    pub id: String,
    pub name: String,
    pub grp: String,
    pub ord: i64,
    pub desc: String,
    /// text | code(원어 번호 본문) | parse(원전 분해)
    pub kind: String,
    /// 이 번역본이 들어 있는 묶음 id
    pub file: String,
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
    /// 제목 앞 `[주해]` 같은 갈래 꼬리표
    pub kind: String,
    pub title: String,
    pub r#ref: String,
    /// text | html
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
    pub series: String,
    pub src_name: String,
    pub section: String,
    pub title: String,
    pub kind: String,
    pub chars: i64,
}

pub struct Reader {
    home: Home,
    ids: Vec<String>,
}

pub fn bible_files(home: &Home) -> Vec<String> {
    let mut v: Vec<String> = source::list_sources(home)
        .into_iter()
        .flat_map(|s| s.installed)
        .filter(|i| i.starts_with("bible-") && home.db_path(SID, i).exists())
        .collect();
    v.sort();
    v
}

impl Reader {
    pub fn open(home: &Home) -> Result<Reader> {
        let st = source::load_state(home, SID)?;
        Ok(Reader { home: home.clone(), ids: st.installed })
    }

    pub fn has(&self, file: &str) -> bool {
        self.ids.iter().any(|i| i == file) && self.home.db_path(SID, file).exists()
    }

    pub fn installed(&self) -> Vec<String> {
        self.ids.iter().filter(|i| self.home.db_path(SID, i).exists()).cloned().collect()
    }

    fn db(&self, file: &str) -> Result<Connection> {
        let p = self.home.db_path(SID, file);
        if !p.exists() {
            bail!("'{file}' 자료를 받지 않았습니다");
        }
        open_ro(&p)
    }

    pub fn books(&self) -> Vec<Book> {
        books::books()
    }

    /// 설치된 bible-* 와 orig(원어 번호 본문·원전 분해)의 번역본을 합친 목록.
    pub fn versions(&self) -> Result<Vec<Version>> {
        let mut out = vec![];
        let mut files = bible_files(&self.home);
        files.sort_by_key(|f| match f.as_str() {
            "bible-ko" => 0,
            "bible-en" => 1,
            _ => 2,
        });
        for f in files {
            let c = self.db(&f)?;
            let mut s = c.prepare("SELECT id,coalesce(name,id),coalesce(grp,''),coalesce(ord,0),coalesce(descr,'') FROM version ORDER BY ord")?;
            let r = s.query_map([], |r| Ok(Version { id: r.get(0)?, name: r.get(1)?, grp: r.get(2)?, ord: r.get(3)?, desc: r.get(4)?, kind: "text".into(), file: f.clone() }))?;
            for x in r {
                out.push(x?);
            }
        }
        if self.has("orig") {
            let c = self.db("orig")?;
            let mut s = c.prepare("SELECT id,coalesce(name,id),coalesce(ord,0) FROM code_version ORDER BY ord")?;
            let r = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?;
            for x in r {
                let (id, name, ord) = x?;
                let kind = if id == "원전분해" { "parse" } else { "code" };
                out.push(Version { id, name, grp: "원어".into(), ord, desc: String::new(), kind: kind.into(), file: "orig".into() });
            }
        }
        Ok(out)
    }

    pub fn resolve_book(&self, s: &str) -> Result<i64> {
        books::resolve_book(s).ok_or_else(|| anyhow::anyhow!("책을 찾을 수 없습니다: {s}"))
    }

    pub fn parse_ref(&self, input: &str) -> Option<(i64, i64, Option<i64>)> {
        books::parse_ref(input)
    }

    pub fn chapter(&self, bk: i64, ch: i64, vers: &[String]) -> Result<Vec<VerseRow>> {
        let all = self.versions()?;
        let mut rows: BTreeMap<i64, BTreeMap<String, String>> = BTreeMap::new();
        let mut conns: BTreeMap<String, Connection> = BTreeMap::new();
        for ver in vers {
            let Some(vi) = all.iter().find(|x| &x.id == ver) else { continue };
            if !conns.contains_key(&vi.file) {
                conns.insert(vi.file.clone(), self.db(&vi.file)?);
            }
            let c = &conns[&vi.file];
            let sql = if vi.file == "orig" { "SELECT verse,text FROM code_verse WHERE version=? AND book=? AND chapter=? ORDER BY verse" } else { "SELECT verse,text FROM verse WHERE version=? AND book=? AND chapter=? ORDER BY verse" };
            let mut s = c.prepare_cached(sql)?;
            let it = s.query_map((ver, bk, ch), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))?;
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

    /// 주석서(시리즈) 목록: (id, 이름)
    pub fn comm_names(&self) -> Result<Vec<(String, String)>> {
        let c = self.db("comm")?;
        let mut s = c.prepare("SELECT id,coalesce(name,id) FROM series ORDER BY ord")?;
        let r = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    /// 구절(v가 None이면 장 전체)에 걸린 주석. 시리즈 순서, 본문 순서대로. 매튜헨리는 comm_verse 에서.
    pub fn comm_for(&self, bk: i64, ch: i64, v: Option<i64>) -> Result<Vec<Note>> {
        let c = self.db("comm")?;
        let (lo, hi) = match v {
            Some(v) => (ch * 1000 + v, ch * 1000 + v),
            None => (ch * 1000, ch * 1000 + 999),
        };
        // 서론·개론(ch1=0, 키 0)은 1장을 열 때 맨 위에 보인다.
        let intro = if v.is_none() && ch == 1 { 1 } else { 0 };
        let mut s = c.prepare(
            "SELECT n.id,n.series,coalesce(m.name,n.series),coalesce(n.title,''),coalesce(n.ref,''),coalesce(n.text,'')
             FROM note n LEFT JOIN series m ON m.id=n.series
             WHERE n.bk=?1 AND ((n.start_key<=?3 AND n.end_key>=?2) OR (?4=1 AND n.start_key=0 AND n.end_key=0))
             ORDER BY coalesce(m.ord,99),n.seq",
        )?;
        let r = s.query_map((bk, lo, hi, intro), |r| {
            let title: String = r.get(3)?;
            let (kind, title) = split_kind(&title);
            Ok(Note { id: r.get(0)?, comm: r.get(1)?, comm_name: r.get(2)?, kind, title, r#ref: r.get(4)?, fmt: "text".into(), body: r.get(5)? })
        })?;
        let mut out: Vec<Note> = r.collect::<rusqlite::Result<_>>()?;
        // 매튜헨리(comm_verse)
        let mut s = c.prepare("SELECT comm,verse,html FROM comm_verse WHERE book=?1 AND chapter=?2 AND (?3=0 OR verse=?3) AND coalesce(html,'')<>'' ORDER BY comm,verse")?;
        let r = s.query_map((bk, ch, v.unwrap_or(0)), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?;
        let mut last: (String, String) = Default::default();
        let mut idn = -1i64;
        for x in r {
            let (comm, vv, html) = x?;
            if v.is_none() && last.0 == comm && last.1 == html {
                continue; // 해설이 없는 절은 앞 절 것을 이어 쓴 것이므로 장 보기에서는 한 번만
            }
            last = (comm.clone(), html.clone());
            let name = c.query_row("SELECT coalesce(name,id) FROM series WHERE id=?", [&comm], |r| r.get::<_, String>(0)).unwrap_or(comm.clone());
            out.push(Note { id: idn, comm, comm_name: name, kind: String::new(), title: format!("{ch}:{vv}"), r#ref: format!("{ch}:{vv}"), fmt: "html".into(), body: html });
            idn -= 1;
        }
        Ok(out)
    }

    /// 원전 분해('원전분해' 본문)를 줄 단위로 파싱한다.
    pub fn parse(&self, bk: i64, ch: i64, v: i64) -> Result<Vec<ParseWord>> {
        let c = self.db("orig")?;
        let t: Option<String> = c.query_row("SELECT text FROM code_verse WHERE version='원전분해' AND book=? AND chapter=? AND verse=?", (bk, ch, v), |r| r.get(0)).ok();
        Ok(t.map(|t| parse_lines(&t)).unwrap_or_default())
    }

    /// 원어 번호("G3972", "h430", "3972")로 두 사전(HebGrkKo, HebGrkEn)의 항목을 찾는다.
    pub fn lex(&self, code: &str) -> Result<Vec<LexEntry>> {
        let c = self.db("orig")?;
        let t = code.trim().to_uppercase();
        let t = if t.chars().all(|c| c.is_ascii_digit()) { format!("G{t}") } else { t };
        let (pre, rest) = t.split_at(t.chars().next().map(|c| c.len_utf8()).unwrap_or(0));
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let suffix = &rest[digits.len()..];
        let nz = digits.trim_start_matches('0');
        let mut cands = vec![format!("{pre}{nz}{}", suffix.to_lowercase())];
        if !suffix.is_empty() {
            cands.push(format!("{pre}{nz}"));
        }
        for cand in cands {
            let mut s = c.prepare("SELECT dict,code,coalesce(text,'') FROM lex WHERE code=? ORDER BY CASE dict WHEN 'HebGrkKo' THEN 0 WHEN 'HebGrkEn' THEN 1 ELSE 2 END")?;
            let r = s.query_map([&cand], |r| {
                let text: String = r.get(2)?;
                let (head, html) = match text.split_once('^') {
                    Some((h, b)) => (strip_tags(h).trim().to_string(), b.to_string()),
                    None => (String::new(), text),
                };
                Ok(LexEntry { dict: r.get(0)?, code: r.get(1)?, head, html })
            })?;
            let v: Vec<LexEntry> = r.collect::<rusqlite::Result<_>>()?;
            if !v.is_empty() {
                return Ok(v);
            }
        }
        Ok(vec![])
    }

    pub fn articles(&self) -> Result<Vec<Article>> {
        let c = self.db("comm")?;
        let mut s = c.prepare("SELECT a.id,a.series,coalesce(m.name,a.series),coalesce(a.section,''),coalesce(a.title,''),coalesce(a.kind,''),length(coalesce(a.text,'')) FROM article a LEFT JOIN series m ON m.id=a.series ORDER BY coalesce(m.ord,99),a.ord,a.id")?;
        let r = s.query_map([], |r| Ok(Article { id: r.get(0)?, series: r.get(1)?, src_name: r.get(2)?, section: r.get(3)?, title: r.get(4)?, kind: r.get(5)?, chars: r.get(6)? }))?;
        Ok(r.collect::<rusqlite::Result<_>>()?)
    }

    pub fn article_body(&self, id: i64) -> Result<String> {
        let c = self.db("comm")?;
        Ok(c.query_row("SELECT coalesce(text,'') FROM article WHERE id=?", [id], |r| r.get(0))?)
    }

    pub fn stats(&self) -> Result<BTreeMap<String, i64>> {
        let mut m = BTreeMap::new();
        let q = |c: &Connection, t: &str| -> i64 { c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap_or(-1) };
        for f in bible_files(&self.home) {
            let c = self.db(&f)?;
            m.insert(format!("{f}:verse"), q(&c, "verse"));
            m.insert(format!("{f}:version"), q(&c, "version"));
        }
        if let Ok(c) = self.db("orig") {
            m.insert("orig:code_verse".into(), q(&c, "code_verse"));
            m.insert("orig:lex".into(), q(&c, "lex"));
        }
        if let Ok(c) = self.db("comm") {
            m.insert("comm:series".into(), q(&c, "series"));
            m.insert("comm:note".into(), q(&c, "note"));
            m.insert("comm:article".into(), q(&c, "article"));
            m.insert("comm:comm_verse".into(), q(&c, "comm_verse"));
        }
        Ok(m)
    }
}

/// "[주해] 머리로 표시하여" → ("주해", "머리로 표시하여")
fn split_kind(t: &str) -> (String, String) {
    if let Some(r) = t.strip_prefix('[') {
        if let Some((k, rest)) = r.split_once(']') {
            if k.chars().count() <= 20 {
                return (k.to_string(), rest.trim().to_string());
            }
        }
    }
    (String::new(), t.to_string())
}

/// 원전분해 줄: `[원어] (기본 <WG611> [원형] 음역)@품사 # 뜻*`
pub fn parse_lines(t: &str) -> Vec<ParseWord> {
    let mut out = vec![];
    for line in t.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        let i = out.len() as i64 + 1;
        let fallback = || ParseWord { i, w: String::new(), code: String::new(), lemma: String::new(), tr: String::new(), parse: String::new(), gloss: line.to_string() };
        let Some(rest) = line.strip_prefix('[') else {
            out.push(fallback());
            continue;
        };
        let Some((w, rest)) = rest.split_once(']') else {
            out.push(fallback());
            continue;
        };
        let (head, tail) = match rest.split_once(")@") {
            Some(x) => x,
            None => (rest, ""),
        };
        let code = head.split("<W").nth(1).and_then(|x| x.split('>').next()).map(|c| c.to_string()).unwrap_or_default();
        let (lemma, tr) = match head.split_once('[').and_then(|(_, r)| r.split_once(']')) {
            Some((l, tr)) => (l.to_string(), tr.trim().to_string()),
            None => (String::new(), String::new()),
        };
        let (parse, gloss) = match tail.split_once(" # ") {
            Some((p, g)) => (p.trim().to_string(), g.trim().trim_end_matches('*').trim().to_string()),
            None => (tail.trim().to_string(), String::new()),
        };
        out.push(ParseWord { i, w: w.to_string(), code, lemma, tr, parse, gloss });
    }
    out
}

/// 원어 번호 본문에서 (낱말 조각, 원어 번호) 목록을 뽑는다. 표기: `총독이<WG2232> 바울에게<WG846>` — 번호는 앞 낱말에 붙는다.
/// 번호 0(WG0)은 번호 없음.
pub fn code_tokens(t: &str) -> Vec<(String, Option<String>)> {
    let mut out = vec![];
    let mut rest = t;
    while let Some(i) = rest.find("<W") {
        let after = &rest[i + 2..];
        let Some(end) = after.find('>') else { break };
        let code = &after[..end];
        let ok = code.len() > 1 && matches!(code.as_bytes()[0], b'G' | b'H') && code[1..].chars().all(|c| c.is_ascii_alphanumeric());
        if !ok {
            out.push((strip_tags(&rest[..i + 2]), None));
            rest = after;
            continue;
        }
        let word = strip_tags(&rest[..i]);
        let digits: String = code[1..].chars().take_while(|c| c.is_ascii_digit()).collect();
        let none = digits.trim_start_matches('0').is_empty();
        out.push((word, if none { None } else { Some(code.to_string()) }));
        rest = &after[end + 1..];
    }
    let tail = strip_tags(rest);
    if !tail.is_empty() {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokens() {
        let t = code_tokens("총독이<WG2232> 바울에게<WG846> 하니<WG0> 끝");
        assert_eq!(t[0], ("총독이".into(), Some("G2232".into())));
        assert_eq!(t[1], (" 바울에게".into(), Some("G846".into())));
        assert_eq!(t[2].1, None);
        assert_eq!(t[3], (" 끝".into(), None));
    }
    #[test]
    fn lines() {
        let p = parse_lines("\n[Ἀπεκρίθη] (기본 <WG611> [ἀποκρίνομαι] 아포크리노)@동직설 과거 수동디포 3인 단수 # 대답하되*\n");
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].w.as_str(), p[0].code.as_str(), p[0].lemma.as_str(), p[0].tr.as_str(), p[0].gloss.as_str()), ("Ἀπεκρίθη", "G611", "ἀποκρίνομαι", "아포크리노", "대답하되"));
        assert!(p[0].parse.starts_with("동직설"));
    }
}
