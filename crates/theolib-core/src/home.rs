use anyhow::Result;
use std::path::PathBuf;

/// 앱 데이터 폴더. THEOLIB_HOME 환경변수가 있으면 그곳(시험용).
#[derive(Clone, Debug)]
pub struct Home {
    pub root: PathBuf,
}

/// 실행 파일 옆의 `data` 폴더 또는 `portable.txt` 파일이 있으면 그 `data` 폴더(포터블).
/// THEOLIB_HOME 이 있으면 포터블로 보지 않는다. 폴더는 만들지 않고 경로만 돌려준다.
fn portable_root() -> Option<PathBuf> {
    if std::env::var_os("THEOLIB_HOME").is_some() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if dir.join("data").is_dir() || dir.join("portable.txt").is_file() {
        return Some(dir.join("data"));
    }
    None
}

/// 포터블 모드인지(THEOLIB_HOME 이 없고 실행 파일 옆에 data 폴더 또는 portable.txt 가 있음).
pub fn is_portable() -> bool {
    portable_root().is_some()
}

impl Home {
    pub fn default_location() -> Result<Home> {
        let root = match std::env::var_os("THEOLIB_HOME") {
            Some(p) => PathBuf::from(p),
            None => match portable_root() {
                Some(p) => p,
                None => dirs::data_dir()
                    .ok_or_else(|| anyhow::anyhow!("데이터 폴더를 찾을 수 없습니다"))?
                    .join("theolib"),
            },
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
