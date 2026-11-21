//! 주소(개인키 포함)를 OS 보안 저장소에 둔다. 로그·상태 파일에는 남기지 않는다.
//! THEOLIB_KEYSTORE=file 이면 시험용으로 데이터 폴더의 secrets.json(0600)을 쓴다.
use crate::Home;
use anyhow::{Context, Result};
use std::collections::BTreeMap;

const SERVICE: &str = "theolib-source";

fn use_file() -> bool {
    std::env::var("THEOLIB_KEYSTORE").map(|v| v == "file").unwrap_or(false)
}

fn read_map(home: &Home) -> BTreeMap<String, String> {
    std::fs::read(home.secrets_file())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_map(home: &Home, m: &BTreeMap<String, String>) -> Result<()> {
    std::fs::create_dir_all(&home.root)?;
    let p = home.secrets_file();
    std::fs::write(&p, serde_json::to_vec(m)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn store(home: &Home, sid: &str, url: &str) -> Result<()> {
    if use_file() {
        let mut m = read_map(home);
        m.insert(sid.into(), url.into());
        return write_map(home, &m);
    }
    keyring::Entry::new(SERVICE, sid)?.set_password(url).context("보안 저장소에 저장하지 못했습니다")
}

pub fn load(home: &Home, sid: &str) -> Result<String> {
    if use_file() {
        return read_map(home).get(sid).cloned().ok_or_else(|| anyhow::anyhow!("저장된 주소가 없습니다"));
    }
    Ok(keyring::Entry::new(SERVICE, sid)?.get_password().context("보안 저장소에서 주소를 읽지 못했습니다")?)
}

pub fn delete(home: &Home, sid: &str) -> Result<()> {
    if use_file() {
        let mut m = read_map(home);
        m.remove(sid);
        return write_map(home, &m);
    }
    let _ = keyring::Entry::new(SERVICE, sid)?.delete_credential();
    Ok(())
}
