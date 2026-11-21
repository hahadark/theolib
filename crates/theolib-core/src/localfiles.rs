//! 자료 파일(.bdb .sdb .dct .cdb)을 읽어 로컬 통합 DB("내 파일" 출처)에 넣는다.
//! 원본은 읽기 전용으로만 연다. 형식별 읽기는 `read_*` 함수에 모여 있다(새 형식은 여기에 추가).
use crate::source::{self, ItemRec, SID, SrcInfo, ensure_pack_db, item_pack, push_unique, save_state};
use crate::Home;
use anyhow::{Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const LOCAL_KEY: &str = "local";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalItem {
    pub path: String,
    /// 항목 id: bible:<이름> | code:<이름> | lex:<이름> | comm:<이름>
    pub id: String,
    pub kind: String,
    pub name: String,
    pub grp: String,
    pub bytes: u64,
    pub rows: i64,
    pub desc: String,
    /// 비어 있지 않으면 가져올 수 없는 파일이고 이유가 들어 있다
    pub skip: String,
}

fn open_ro(p: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY)?)
}

fn has_cols(c: &Connection, table: &str, cols: &[&str]) -> bool {
    let Ok(mut s) = c.prepare(&format!("PRAGMA table_info(\"{table}\")")) else { return false };
    let have: Vec<String> = s.query_map([], |r| r.get::<_, String>(1)).map(|i| i.flatten().map(|x| x.to_lowercase()).collect()).unwrap_or_default();
    cols.iter().all(|c| have.contains(&c.to_string()))
}

/// 번역본파일목록.txt: `◆ 이름 : 설명`
fn read_descs(dirs: &[PathBuf]) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    for d in dirs {
        let Ok(t) = std::fs::read_to_string(d.join("번역본파일목록.txt")) else { continue };
        for l in t.lines() {
            if let Some(r) = l.trim().strip_prefix('◆') {
                if let Some((n, desc)) = r.split_once(':') {
                    m.insert(n.trim().nfc().collect::<String>(), desc.trim().to_string());
                }
            }
        }
    }
    m
}

fn has_hangul(s: &str) -> bool {
    s.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c))
}

/// 이름으로 분류 추정: 한글 이름은 한국어(○○어로 끝나거나 나라·언어 이름이면 외국어), BHS·LXX 는 원어, 그 밖 로마자는 영어.
pub fn guess_grp(name: &str) -> &'static str {
    let up = name.to_uppercase();
    if up.starts_with("BHS") || up.starts_with("LXX") {
        return "원어";
    }
    if has_hangul(name) {
        const FOREIGN: [&str; 12] = ["중국", "일본", "러시아", "독일", "프랑스", "스페인", "베트남", "태국", "몽골", "인도", "아랍", "필리핀"];
        if name.ends_with('어') || FOREIGN.iter().any(|f| name.contains(f)) {
            return "외국어";
        }
        return "한국어";
    }
    "영어"
}

/// 파일·폴더 목록에서 가져올 수 있는 자료를 찾는다(폴더는 안의 파일까지, 한 단계 더 안쪽 폴더도 본다).
pub fn scan(paths: &[PathBuf]) -> Vec<LocalItem> {
    let mut files: Vec<PathBuf> = vec![];
    let mut dirs: Vec<PathBuf> = vec![];
    fn walk(p: &Path, depth: u8, files: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) {
        if p.is_dir() {
            dirs.push(p.to_path_buf());
            if depth > 0 {
                if let Ok(rd) = std::fs::read_dir(p) {
                    let mut v: Vec<_> = rd.flatten().map(|e| e.path()).collect();
                    v.sort();
                    for c in v {
                        walk(&c, depth - 1, files, dirs);
                    }
                }
            }
        } else {
            files.push(p.to_path_buf());
        }
    }
    for p in paths {
        walk(p, 2, &mut files, &mut dirs);
    }
    for f in &files {
        if let Some(d) = f.parent() {
            if !dirs.iter().any(|x| x == d) {
                dirs.push(d.to_path_buf());
            }
        }
    }
    let descs = read_descs(&dirs);
    let mut out = vec![];
    for f in files {
        let fname = f.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if fname.starts_with('.') {
            continue;
        }
        let ext = f.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        let name: String = f.file_stem().and_then(|s| s.to_str()).unwrap_or("").nfc().collect();
        let kind = match ext.as_str() {
            "bdb" => "bible",
            "sdb" => "code",
            "dct" => "lex",
            "cdb" => "comm",
            "hdb" | "cmp" => "skip",
            _ => continue,
        };
        let bytes = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
        let mut it = LocalItem { path: f.to_string_lossy().into(), id: format!("{kind}:{name}"), kind: kind.into(), name: name.clone(), grp: String::new(), bytes, rows: 0, desc: descs.get(&name).cloned().unwrap_or_default(), skip: String::new() };
        if kind == "skip" {
            it.id = format!("skip:{name}");
            it.skip = if ext == "hdb" { "찬송가는 아직 지원하지 않습니다".into() } else { "악보 묶음(.cmp)은 아직 지원하지 않습니다".into() };
            out.push(it);
            continue;
        }
        match check(&f, kind) {
            Ok(n) => it.rows = n,
            Err(e) => it.skip = e.to_string(),
        }
        it.grp = match kind {
            "bible" => guess_grp(&name).into(),
            "code" => "원어 번호 본문".into(),
            "lex" => "사전".into(),
            _ => "주석".into(),
        };
        out.push(it);
    }
    out
}

fn check(p: &Path, kind: &str) -> Result<i64> {
    let c = open_ro(p).map_err(|_| anyhow::anyhow!("SQLite 파일이 아니거나 열 수 없습니다"))?;
    let (table, cols): (&str, &[&str]) = if kind == "lex" { ("Lexicon", &["id", "scode", "dtext"]) } else { ("Bible", &["id", "book", "chapter", "verse", "btext"]) };
    if !has_cols(&c, table, cols) {
        bail!("표 구조가 다릅니다({table} 표 또는 칸 없음)");
    }
    Ok(c.query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |r| r.get(0)).map_err(|_| anyhow::anyhow!("표를 읽지 못했습니다"))?)
}

fn file_sha(p: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut b = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(source::hex(&h.finalize()))
}

/// 고른 항목을 통합 DB에 넣는다. 같은 id 가 이미 있으면 `replace`일 때만 바꾸고, 아니면 건너뛴다.
/// 돌려주는 값: (가져온 id, 건너뛴 id)
pub fn import(home: &Home, items: &[LocalItem], replace: bool, prog: &mut dyn FnMut(&str, u64, u64)) -> Result<(Vec<String>, Vec<String>)> {
    let mut st = source::load_state(home, SID).unwrap_or(source::State {
        decl: source::Declaration { format: source::FORMAT.into(), layout: String::new(), title: String::new(), updated: String::new(), note: String::new(), files: vec![] },
        installed: vec![],
        origin: String::new(),
        sources: vec![],
        hidden: vec![],
        pruned: vec![],
        items: vec![],
    });
    let (mut done, mut skipped) = (vec![], vec![]);
    for it in items {
        if !it.skip.is_empty() {
            skipped.push(it.id.clone());
            continue;
        }
        if st.items.iter().any(|r| r.id == it.id) && !replace {
            skipped.push(it.id.clone());
            continue;
        }
        let pack = item_pack(&it.kind).ok_or_else(|| anyhow::anyhow!("{}: 알 수 없는 종류", it.id))?;
        let src_path = PathBuf::from(&it.path);
        let src = open_ro(&src_path)?;
        let label = format!("{} 가져오는 중", it.name);
        ensure_pack_db(home, pack)?;
        let c = Connection::open(home.db_path(SID, pack))?;
        c.execute_batch("BEGIN")?;
        let r: Result<()> = (|| {
            source::delete_rows(&c, &it.kind, &it.name)?;
            let total = it.rows.max(1) as u64;
            let mut n = 0u64;
            match it.kind.as_str() {
                "bible" | "code" => {
                    let ord: i64 = if it.kind == "bible" { c.query_row("SELECT coalesce(max(ord),-1)+1 FROM version", [], |r| r.get(0))? } else { c.query_row("SELECT coalesce(max(ord),-1)+1 FROM code_version", [], |r| r.get(0))? };
                    if it.kind == "bible" {
                        c.execute("INSERT INTO version(id,name,grp,ord,descr) VALUES(?,?,?,?,?)", (&it.name, &it.name, &it.grp, ord, &it.desc))?;
                    } else {
                        c.execute("INSERT INTO code_version(id,name,ord) VALUES(?,?,?)", (&it.name, &it.name, ord))?;
                    }
                    let mut ins = c.prepare(if it.kind == "bible" { "INSERT INTO verse(version,book,chapter,verse,text) VALUES(?,?,?,?,?)" } else { "INSERT INTO code_verse(version,book,chapter,verse,text) VALUES(?,?,?,?,?)" })?;
                    let mut s = src.prepare("SELECT book,chapter,verse,btext FROM Bible ORDER BY id")?;
                    let mut rows = s.query([])?;
                    while let Some(r) = rows.next()? {
                        let mut t: String = r.get::<_, Option<String>>(3)?.unwrap_or_default();
                        if it.kind == "code" && it.name == "원전분해" {
                            t = t.replace("\r\n", "\n").replace('\r', "\n");
                        }
                        ins.execute((&it.name, r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, t))?;
                        n += 1;
                        if n % 5000 == 0 {
                            prog(&label, n, total);
                        }
                    }
                }
                "lex" => {
                    let mut ins = c.prepare("INSERT INTO lex(dict,code,text) VALUES(?,?,?)")?;
                    let mut s = src.prepare("SELECT scode,dtext FROM Lexicon ORDER BY id")?;
                    let mut rows = s.query([])?;
                    while let Some(r) = rows.next()? {
                        ins.execute((&it.name, r.get::<_, Option<String>>(0)?.unwrap_or_default().trim(), r.get::<_, Option<String>>(1)?.unwrap_or_default()))?;
                        n += 1;
                        if n % 5000 == 0 {
                            prog(&label, n, total);
                        }
                    }
                }
                _ => {
                    let ord: i64 = c.query_row("SELECT coalesce(max(ord),99)+1 FROM series", [], |r| r.get(0))?;
                    c.execute("INSERT INTO series(id,name,kind,unit,types,ord,coverage,note) VALUES(?,?,'cdb','절별','[]',?,'{}',?)", (&it.name, &it.name, ord, &it.desc))?;
                    let mut ins = c.prepare("INSERT INTO comm_verse(comm,book,chapter,verse,html) VALUES(?,?,?,?,?)")?;
                    let mut s = src.prepare("SELECT book,chapter,verse,btext FROM Bible ORDER BY id")?;
                    let mut rows = s.query([])?;
                    while let Some(r) = rows.next()? {
                        ins.execute((&it.name, r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?.unwrap_or_default()))?;
                        n += 1;
                        if n % 5000 == 0 {
                            prog(&label, n, total);
                        }
                    }
                }
            }
            prog(&label, total, total);
            Ok(())
        })();
        if let Err(e) = r {
            let _ = c.execute_batch("ROLLBACK");
            bail!("{}: {e}", it.name);
        }
        c.execute_batch("COMMIT")?;
        st.items.retain(|x| x.id != it.id);
        st.items.push(ItemRec { id: it.id.clone(), kind: it.kind.clone(), name: it.name.clone(), grp: it.grp.clone(), sha256: file_sha(&src_path)?, bytes: it.bytes, db_bytes: it.bytes, license: String::new(), source: LOCAL_KEY.into() });
        push_unique(&mut st.installed, pack);
        if !st.sources.iter().any(|s| s.key == LOCAL_KEY) {
            st.sources.push(SrcInfo { key: LOCAL_KEY.into(), origin: "내 파일".into(), title: "내 파일".into(), files: vec![] });
        }
        let si = st.sources.iter_mut().find(|s| s.key == LOCAL_KEY).unwrap();
        push_unique(&mut si.files, &it.id);
        save_state(home, &st)?;
        done.push(it.id.clone());
    }
    save_state(home, &st)?;
    Ok((done, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grp() {
        assert_eq!(guess_grp("개역개정"), "한국어");
        assert_eq!(guess_grp("일본어"), "외국어");
        assert_eq!(guess_grp("BHSSBL"), "원어");
        assert_eq!(guess_grp("KJV1769"), "영어");
    }
}
