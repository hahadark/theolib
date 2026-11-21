//! 사용자 DB(책갈피, 메모). 내려받은 DB와 별도 파일.
use crate::Home;
use anyhow::Result;
use rusqlite::Connection;

pub fn open(home: &Home) -> Result<Connection> {
    std::fs::create_dir_all(&home.root)?;
    let c = Connection::open(home.user_db_path())?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS bookmark(id INTEGER PRIMARY KEY, bk INTEGER, ch INTEGER, v INTEGER, label TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
         CREATE TABLE IF NOT EXISTS memo(id INTEGER PRIMARY KEY, bk INTEGER, ch INTEGER, v INTEGER, body TEXT, updated TEXT DEFAULT CURRENT_TIMESTAMP);",
    )?;
    Ok(c)
}

pub fn add_bookmark(c: &Connection, bk: i64, ch: i64, v: i64, label: &str) -> Result<i64> {
    c.execute("INSERT INTO bookmark(bk,ch,v,label) VALUES(?,?,?,?)", (bk, ch, v, label))?;
    Ok(c.last_insert_rowid())
}

pub fn add_memo(c: &Connection, bk: i64, ch: i64, v: i64, body: &str) -> Result<i64> {
    c.execute("INSERT INTO memo(bk,ch,v,body) VALUES(?,?,?,?)", (bk, ch, v, body))?;
    Ok(c.last_insert_rowid())
}
