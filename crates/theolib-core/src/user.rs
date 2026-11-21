//! 사용자 DB(책갈피, 메모, 하이라이트). 내려받은 DB와 별도 파일(user.db), 기기별 저장.
use crate::Home;
use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Bookmark { pub id: i64, pub bk: i64, pub ch: i64, pub v: i64, pub label: String, pub created: String }
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Memo { pub id: i64, pub bk: i64, pub ch: i64, pub v: i64, pub body: String, pub updated: String }
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Highlight { pub id: i64, pub bk: i64, pub ch: i64, pub v: i64, pub color: String }

pub fn open(home: &Home) -> Result<Connection> {
    std::fs::create_dir_all(&home.root)?;
    let c = Connection::open(home.user_db_path())?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS bookmark(id INTEGER PRIMARY KEY, bk INTEGER, ch INTEGER, v INTEGER, label TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
         CREATE TABLE IF NOT EXISTS memo(id INTEGER PRIMARY KEY, bk INTEGER, ch INTEGER, v INTEGER, body TEXT, updated TEXT DEFAULT CURRENT_TIMESTAMP);
         CREATE TABLE IF NOT EXISTS highlight(id INTEGER PRIMARY KEY, bk INTEGER, ch INTEGER, v INTEGER, color TEXT, UNIQUE(bk,ch,v));
         CREATE INDEX IF NOT EXISTS memo_pos ON memo(bk,ch,v);",
    )?;
    Ok(c)
}

pub fn add_bookmark(c: &Connection, bk: i64, ch: i64, v: i64, label: &str) -> Result<i64> {
    c.execute("INSERT INTO bookmark(bk,ch,v,label) VALUES(?,?,?,?)", (bk, ch, v, label))?;
    Ok(c.last_insert_rowid())
}
pub fn list_bookmarks(c: &Connection) -> Result<Vec<Bookmark>> {
    let mut s = c.prepare("SELECT id,bk,ch,v,COALESCE(label,''),COALESCE(created,'') FROM bookmark ORDER BY bk,ch,v,id")?;
    let r = s.query_map([], |r| Ok(Bookmark { id: r.get(0)?, bk: r.get(1)?, ch: r.get(2)?, v: r.get(3)?, label: r.get(4)?, created: r.get(5)? }))?;
    Ok(r.collect::<rusqlite::Result<_>>()?)
}
pub fn delete_bookmark(c: &Connection, id: i64) -> Result<bool> {
    Ok(c.execute("DELETE FROM bookmark WHERE id=?", [id])? > 0)
}

pub fn add_memo(c: &Connection, bk: i64, ch: i64, v: i64, body: &str) -> Result<i64> {
    c.execute("INSERT INTO memo(bk,ch,v,body) VALUES(?,?,?,?)", (bk, ch, v, body))?;
    Ok(c.last_insert_rowid())
}
pub fn update_memo(c: &Connection, id: i64, body: &str) -> Result<bool> {
    Ok(c.execute("UPDATE memo SET body=?, updated=CURRENT_TIMESTAMP WHERE id=?", (body, id))? > 0)
}
pub fn delete_memo(c: &Connection, id: i64) -> Result<bool> {
    Ok(c.execute("DELETE FROM memo WHERE id=?", [id])? > 0)
}
/// ch 가 0 이면 책 전체, v 가 0 이면 그 장 전체.
pub fn list_memos(c: &Connection, bk: i64, ch: i64) -> Result<Vec<Memo>> {
    let mut s = c.prepare("SELECT id,bk,ch,v,COALESCE(body,''),COALESCE(updated,'') FROM memo WHERE bk=? AND (?=0 OR ch=?) ORDER BY ch,v,id")?;
    let r = s.query_map((bk, ch, ch), |r| Ok(Memo { id: r.get(0)?, bk: r.get(1)?, ch: r.get(2)?, v: r.get(3)?, body: r.get(4)?, updated: r.get(5)? }))?;
    Ok(r.collect::<rusqlite::Result<_>>()?)
}

/// 같은 절의 하이라이트는 색만 바꾼다. 빈 색이면 지운다.
pub fn set_highlight(c: &Connection, bk: i64, ch: i64, v: i64, color: &str) -> Result<()> {
    if color.is_empty() {
        c.execute("DELETE FROM highlight WHERE bk=? AND ch=? AND v=?", (bk, ch, v))?;
    } else {
        c.execute("INSERT INTO highlight(bk,ch,v,color) VALUES(?,?,?,?) ON CONFLICT(bk,ch,v) DO UPDATE SET color=excluded.color", (bk, ch, v, color))?;
    }
    Ok(())
}
pub fn list_highlights(c: &Connection, bk: i64, ch: i64) -> Result<Vec<Highlight>> {
    let mut s = c.prepare("SELECT id,bk,ch,v,color FROM highlight WHERE bk=? AND ch=? ORDER BY v")?;
    let r = s.query_map((bk, ch), |r| Ok(Highlight { id: r.get(0)?, bk: r.get(1)?, ch: r.get(2)?, v: r.get(3)?, color: r.get(4)? }))?;
    Ok(r.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_data_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let h = Home { root: d.path().to_path_buf() };
        let c = open(&h).unwrap();
        let b = add_bookmark(&c, 44, 24, 10, "총독").unwrap();
        add_bookmark(&c, 43, 1, 1, "").unwrap();
        let l = list_bookmarks(&c).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].bk, 43);
        assert!(delete_bookmark(&c, b).unwrap());
        assert!(!delete_bookmark(&c, b).unwrap());
        let m = add_memo(&c, 44, 24, 10, "a").unwrap();
        add_memo(&c, 44, 25, 1, "b").unwrap();
        assert_eq!(list_memos(&c, 44, 24).unwrap().len(), 1);
        assert_eq!(list_memos(&c, 44, 0).unwrap().len(), 2);
        assert!(update_memo(&c, m, "수정").unwrap());
        assert_eq!(list_memos(&c, 44, 24).unwrap()[0].body, "수정");
        assert!(delete_memo(&c, m).unwrap());
        set_highlight(&c, 44, 24, 10, "yellow").unwrap();
        set_highlight(&c, 44, 24, 10, "green").unwrap();
        set_highlight(&c, 44, 24, 11, "blue").unwrap();
        let hl = list_highlights(&c, 44, 24).unwrap();
        assert_eq!(hl.len(), 2);
        assert_eq!(hl[0].color, "green");
        set_highlight(&c, 44, 24, 10, "").unwrap();
        assert_eq!(list_highlights(&c, 44, 24).unwrap().len(), 1);
        drop(c);
        // 다시 열어도 유지, 내려받은 DB 폴더와 분리된 user.db
        let c2 = open(&h).unwrap();
        assert_eq!(list_highlights(&c2, 44, 24).unwrap().len(), 1);
        assert!(h.user_db_path().exists());
    }
}
