//! 연구 설정 settings.json. 모르는 칸은 보존한다.
use crate::Home;
use anyhow::Result;
use serde_json::{Value, json};

#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub engine: String,
    pub models: serde_json::Map<String, Value>,
    pub fallback: String,
    pub custom_url: String,
    pub web_base: String,
    pub purpose: String,
    pub depth: String,
    pub cats: Option<Vec<String>>,
    pub sermon_options: Value,
    pub cli_ok: Value,
}

pub fn settings_path(home: &Home) -> std::path::PathBuf {
    crate::study::study_dir(home).join("settings.json")
}

impl Settings {
    pub fn from_value(v: &Value) -> Settings {
        Settings {
            engine: v.get("engine").and_then(|x| x.as_str()).unwrap_or("deepseek").to_string(),
            models: v.get("models").and_then(|x| x.as_object()).cloned().unwrap_or_default(),
            fallback: v.get("fallback").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            custom_url: v.get("custom_url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            web_base: v.get("web_base").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            purpose: v.get("purpose").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            depth: v.get("depth").and_then(|x| x.as_str()).unwrap_or("normal").to_string(),
            cats: v.get("cats").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()),
            sermon_options: v.get("sermon_options").cloned().unwrap_or(Value::Null),
            cli_ok: v.get("cli_ok").cloned().unwrap_or(Value::Object(Default::default())),
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "engine": self.engine,
            "models": self.models,
            "fallback": self.fallback,
            "custom_url": self.custom_url,
            "web_base": self.web_base,
            "purpose": self.purpose,
            "depth": self.depth,
            "cats": self.cats.clone(),
            "sermon_options": self.sermon_options.clone(),
            "cli_ok": self.cli_ok.clone(),
        })
    }

    /// 엔진 id → 모델(설정. 없으면 내장 기본).
    pub fn model_for(&self, engine: &str, default: &str) -> String {
        self.models
            .get(engine)
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| default.to_string())
    }
}

/// settings.json 을 읽는다. 없으면 기본값.
pub fn load(home: &Home) -> Settings {
    let v: Value = std::fs::read(settings_path(home))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Object(Default::default()));
    Settings::from_value(&v)
}

/// 설정 통째로 저장(모르는 칸 보존). 들어온 객체에 없는 칸은 기존 값을 유지한다.
pub fn save(home: &Home, patch: &Value) -> Result<Settings> {
    let mut cur: Value = std::fs::read(settings_path(home))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Object(Default::default()));
    if let (Some(dst), Some(src)) = (cur.as_object_mut(), patch.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let d = crate::study::study_dir(home);
    std::fs::create_dir_all(&d)?;
    let tmp = settings_path(home).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&cur)?)?;
    std::fs::rename(&tmp, settings_path(home))?;
    Ok(Settings::from_value(&cur))
}
