use anyhow::Result;
use std::path::PathBuf;

/// 앱 데이터 폴더. THEOLIB_HOME 환경변수가 있으면 그곳(시험용).
#[derive(Clone, Debug)]
pub struct Home {
    pub root: PathBuf,
}

impl Home {
    pub fn default_location() -> Result<Home> {
        let root = match std::env::var_os("THEOLIB_HOME") {
            Some(p) => PathBuf::from(p),
            None => dirs::data_dir()
                .ok_or_else(|| anyhow::anyhow!("데이터 폴더를 찾을 수 없습니다"))?
                .join("theolib"),
        };
        Ok(Home { root })
    }
    pub fn at(root: PathBuf) -> Home {
        Home { root }
    }
    pub fn sources_dir(&self) -> PathBuf {
        self.root.join("sources")
    }
    pub fn source_dir(&self, sid: &str) -> PathBuf {
        self.sources_dir().join(sid)
    }
    pub fn db_path(&self, sid: &str, file: &str) -> PathBuf {
        self.source_dir(sid).join(format!("{file}.db"))
    }
    pub fn index_path(&self, sid: &str) -> PathBuf {
        self.source_dir(sid).join("index.db")
    }
    pub fn state_path(&self, sid: &str) -> PathBuf {
        self.source_dir(sid).join("state.json")
    }
    pub fn user_db_path(&self) -> PathBuf {
        self.root.join("user.db")
    }
    pub fn secrets_file(&self) -> PathBuf {
        self.root.join("secrets.json")
    }
}
