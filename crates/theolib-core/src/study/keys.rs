//! AI API 키 보관. 보안 저장소 서비스 `theolib-ai`, 계정 = 회사 id.
//! THEOLIB_KEYSTORE=file 이면 <root>/study/keys.json(시험용).
use crate::Home;
use anyhow::{Context, Result, bail};
use std::collections::BTreeMap;

pub const SERVICE: &str = "theolib-ai";

fn use_file() -> bool {
    std::env::var("THEOLIB_KEYSTORE").map(|v| v == "file").unwrap_or(false)
}

fn file_path(home: &Home) -> std::path::PathBuf {
    crate::study::study_dir(home).join("keys.json")
}

fn read_map(home: &Home) -> BTreeMap<String, serde_json::Value> {
    std::fs::read(file_path(home))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_map(home: &Home, m: &BTreeMap<String, serde_json::Value>) -> Result<()> {
    let d = crate::study::study_dir(home);
    std::fs::create_dir_all(&d)?;
    std::fs::write(file_path(home), serde_json::to_vec(m)?)?;
    Ok(())
}

/// 회사 id에 저장된 키(값 그대로). 없으면 None.
pub fn load(home: &Home, provider: &str) -> Option<String> {
    if use_file() {
        return read_map(home)
            .get(provider)
            .and_then(|v| v.get("key"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }
    keyring::Entry::new(SERVICE, provider)
        .ok()
        .and_then(|e| e.get_password().ok())
}

/// 저장된 키와 마지막 4자리 힌트.
pub fn saved(home: &Home) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if use_file() {
        for (p, v) in read_map(home) {
            if let Some(k) = v.get("key").and_then(|x| x.as_str()) {
                out.insert(p, hint(k));
            }
        }
        return out;
    }
    // keyring 은 목록을 주지 않으므로 알려진 회사 id 만 훑는다.
    for p in &["deepseek", "gemini", "openai", "anthropic"] {
        if let Some(k) = load(home, p) {
            out.insert((*p).to_string(), hint(&k));
        }
    }
    out
}

/// 끝 4자리 힌트("…1a2b").
pub fn hint(key: &str) -> String {
    let t = key.trim();
    if t.len() >= 4 {
        format!("…{}", &t[t.len() - 4..])
    } else {
        "…".to_string()
    }
}

/// 키 형식 검사. `[A-Za-z0-9_\-.:]{20,300}` 이 아니면 오류.
pub fn clean_key(key: &str) -> Option<String> {
    let k = key.trim();
    if !k.is_empty() && k.len() >= 20 && k.len() <= 300 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == ':') {
        Some(k.to_string())
    } else {
        None
    }
}

pub fn save(home: &Home, provider: &str, key: &str, model: &str, url: Option<&str>) -> Result<()> {
    if use_file() {
        let mut m = read_map(home);
        let mut rec = serde_json::Map::new();
        rec.insert("key".into(), serde_json::json!(key));
        rec.insert("model".into(), serde_json::json!(model));
        if let Some(u) = url {
            if !u.is_empty() {
                rec.insert("url".into(), serde_json::json!(u));
            }
        }
        m.insert(provider.into(), serde_json::Value::Object(rec));
        return write_map(home, &m);
    }
    // 보안 저장소에는 키 값만 둔다(모델·주소는 settings 쪽이 담당).
    let e = keyring::Entry::new(SERVICE, provider).context("보안 저장소에 접근하지 못했습니다")?;
    e.set_password(key).context("보안 저장소에 키를 저장하지 못했습니다")
}

pub fn delete(home: &Home, provider: &str) -> Result<()> {
    if use_file() {
        let mut m = read_map(home);
        m.remove(provider);
        return write_map(home, &m);
    }
    if let Ok(e) = keyring::Entry::new(SERVICE, provider) {
        let _ = e.delete_credential();
    }
    Ok(())
}

/// 모델·주소(키 없이)를 저장한다. 파일 모드에서만 의미 있다(보안 저장소는 키만).
pub fn save_meta(home: &Home, provider: &str, model: &str, url: Option<&str>) -> Result<()> {
    if !use_file() {
        return Ok(());
    }
    let mut m = read_map(home);
    let mut rec = read_map(home)
        .get(provider)
        .cloned()
        .unwrap_or(serde_json::json!({}));
    if let Some(obj) = rec.as_object_mut() {
        obj.insert("model".into(), serde_json::json!(model));
        if let Some(u) = url.filter(|u| !u.is_empty()) {
            obj.insert("url".into(), serde_json::json!(u));
        } else {
            obj.remove("url");
        }
    }
    m.insert(provider.into(), rec);
    write_map(home, &m)
}

/// 저장된 모델(없으면 None).
pub fn saved_model(home: &Home, provider: &str) -> Option<String> {
    if !use_file() {
        return None;
    }
    read_map(home)
        .get(provider)
        .and_then(|v| v.get("model"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 저장된 주소(custom 용, 없으면 None).
pub fn saved_url(home: &Home, provider: &str) -> Option<String> {
    if !use_file() {
        return None;
    }
    read_map(home)
        .get(provider)
        .and_then(|v| v.get("url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 키가 비었거나 형식이 틀리면 오류.
pub fn require_key(provider_name: &str, key: Option<&str>) -> Result<String> {
    match key.and_then(clean_key) {
        Some(k) => Ok(k),
        None => bail!("{provider_name} API 키를 넣어 주세요"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_and_hint() {
        assert_eq!(clean_key("ab"), None);
        assert!(clean_key("sk-abcdefghijklmnopqrstuvwxyz1234567890").is_some());
        assert_eq!(clean_key("sk-abcd!@#$"), None);
        assert_eq!(hint("sk-1234567890abcdef"), "…cdef");
        assert_eq!(hint("ab"), "…");
    }
}
