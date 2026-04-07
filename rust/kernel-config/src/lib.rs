use std::env;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_PROVIDER_ID: &str = "crsb";
pub const DEFAULT_PROVIDER_NAME: &str = "crsb";
pub const DEFAULT_BASE_URL: &str = "https://codex.funai.vip/openai";
pub const DEFAULT_WIRE_API: &str = "responses";
pub const DEFAULT_ENV_KEY: &str = "CRS_OAI_KEY2";
pub const DEFAULT_MODEL: &str = "gpt-5.3-codex";
pub const DEFAULT_PROVIDER_ID_CRSA: &str = "crsa";
pub const DEFAULT_PROVIDER_NAME_CRSA: &str = "crsa";
pub const DEFAULT_ENV_KEY_CRSA: &str = "CRS_OAI_KEY1";
pub const KERNEL_PROVIDER_ENV: &str = "FINGER_KERNEL_PROVIDER";
pub const FINGER_CONFIG_PATH_ENV: &str = "FINGER_CONFIG_PATH";
pub const FINGER_TOOL_DAEMON_URL_ENV: &str = "FINGER_TOOL_DAEMON_URL";
pub const FINGER_TOOL_AGENT_ID_ENV: &str = "FINGER_TOOL_AGENT_ID";
pub const DEFAULT_TOOL_DAEMON_URL: &str = "http://127.0.0.1:9999";
pub const DEFAULT_TOOL_AGENT_ID: &str = "chat-codex";
const LOCAL_DEV_API_KEY: &str = "local-dev-key";

/// Wire API protocol type for kernel requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireApi {
    Responses,    // OpenAI Responses API (/v1/responses)
    Anthropic,    // Anthropic Messages API (/v1/messages)
    OpenAIChat,   // OpenAI Chat Completions API (/v1/chat/completions)
}

impl Default for WireApi {
    fn default() -> Self {
        WireApi::Responses
    }
}

impl WireApi {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "responses" => WireApi::Responses,
            "anthropic" | "anthropic-wire" => WireApi::Anthropic,
            "chat" | "openai-chat" => WireApi::OpenAIChat,
            _ => WireApi::Responses, // fallback
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalModelConfig {
    pub provider_id: String,
    pub provider_name: String,
    pub base_url: String,
    pub wire_api: WireApi,
    pub env_key: String,
    pub api_key: String,
    pub model: String,
    pub tool_daemon_url: String,
    pub tool_agent_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LocalModelOverrides {
    pub provider_id: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub env_key: Option<String>,
}

#[derive(Debug, Clone)]
struct ProviderDefaults {
    provider_id: String,
    provider_name: String,
    base_url: String,
    wire_api: WireApi,
    env_key: String,
    model: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct FingerUserConfig {
    #[serde(default)]
    kernel: KernelUserConfig,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct KernelUserConfig {
    provider: Option<String>,
    tool_daemon_url: Option<String>,
    tool_agent_id: Option<String>,
    #[serde(default)]
    providers: std::collections::HashMap<String, KernelProviderConfig>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct KernelProviderConfig {
    name: Option<String>,
    base_url: Option<String>,
    wire_api: Option<String>,
    env_key: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("environment variable '{0}' is not set")]
    MissingEnvVar(String),
    #[error("failed to parse config file '{path}': {error}")]
    ParseConfig { path: String, error: String },
}

pub fn load_crsb_config() -> Result<LocalModelConfig, ConfigError> {
    load_crsb_config_with(LocalModelOverrides::default())
}

pub fn load_crsb_config_with(
    overrides: LocalModelOverrides,
) -> Result<LocalModelConfig, ConfigError> {
    load_local_model_config_with(LocalModelOverrides {
        provider_id: Some(DEFAULT_PROVIDER_ID.to_string()),
        ..overrides
    })
}

pub fn load_local_model_config() -> Result<LocalModelConfig, ConfigError> {
    load_local_model_config_with(LocalModelOverrides::default())
}

pub fn load_local_model_config_with(
    overrides: LocalModelOverrides,
) -> Result<LocalModelConfig, ConfigError> {
    let file_config = load_finger_user_config()?;
    let provider_id = resolve_provider_id(&overrides, file_config.as_ref());
    let mut defaults = provider_defaults(&provider_id);
    apply_file_provider_overrides(&mut defaults, file_config.as_ref(), &provider_id);

    let resolved_base_url = overrides
        .base_url
        .clone()
        .unwrap_or_else(|| defaults.base_url.clone());
    let env_key = overrides.env_key.unwrap_or(defaults.env_key);
    let api_key = match env::var(&env_key) {
        Ok(value) => value,
        Err(_) => {
            if is_local_base_url(&resolved_base_url) {
                LOCAL_DEV_API_KEY.to_string()
            } else {
                return Err(ConfigError::MissingEnvVar(env_key.clone()));
            }
        }
    };

    let tool_daemon_url = resolve_tool_daemon_url(file_config.as_ref());
    let tool_agent_id = resolve_tool_agent_id(file_config.as_ref());

    Ok(LocalModelConfig {
        provider_id,
        provider_name: defaults.provider_name,
        base_url: resolved_base_url,
        wire_api: defaults.wire_api,
        env_key,
        api_key,
        model: overrides.model.unwrap_or(defaults.model),
        tool_daemon_url,
        tool_agent_id,
    })
}

fn provider_defaults(provider_id: &str) -> ProviderDefaults {
    match provider_id {
        "crsa" => ProviderDefaults {
            provider_id: DEFAULT_PROVIDER_ID_CRSA.to_string(),
            provider_name: DEFAULT_PROVIDER_NAME_CRSA.to_string(),
            base_url: DEFAULT_BASE_URL.to_string(),
            wire_api: WireApi::Responses,
            env_key: DEFAULT_ENV_KEY_CRSA.to_string(),
            model: DEFAULT_MODEL.to_string(),
        },
        _ => ProviderDefaults {
            provider_id: DEFAULT_PROVIDER_ID.to_string(),
            provider_name: DEFAULT_PROVIDER_NAME.to_string(),
            base_url: DEFAULT_BASE_URL.to_string(),
            wire_api: WireApi::Responses,
            env_key: DEFAULT_ENV_KEY.to_string(),
            model: DEFAULT_MODEL.to_string(),
        },
    }
}

fn resolve_provider_id(
    overrides: &LocalModelOverrides,
    file_config: Option<&FingerUserConfig>,
) -> String {
    if let Some(provider) = overrides
        .provider_id
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        return provider.to_string();
    }

    if let Ok(value) = env::var(KERNEL_PROVIDER_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Some(provider) = file_config
        .and_then(|cfg| cfg.kernel.provider.as_ref())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        return provider.to_string();
    }

    DEFAULT_PROVIDER_ID.to_string()
}

fn resolve_tool_daemon_url(file_config: Option<&FingerUserConfig>) -> String {
    if let Ok(value) = env::var(FINGER_TOOL_DAEMON_URL_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Some(value) = file_config
        .and_then(|cfg| cfg.kernel.tool_daemon_url.as_ref())
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        return value.to_string();
    }

    DEFAULT_TOOL_DAEMON_URL.to_string()
}

fn resolve_tool_agent_id(file_config: Option<&FingerUserConfig>) -> String {
    if let Ok(value) = env::var(FINGER_TOOL_AGENT_ID_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Some(value) = file_config
        .and_then(|cfg| cfg.kernel.tool_agent_id.as_ref())
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        return value.to_string();
    }

    DEFAULT_TOOL_AGENT_ID.to_string()
}

fn apply_file_provider_overrides(
    defaults: &mut ProviderDefaults,
    file_config: Option<&FingerUserConfig>,
    provider_id: &str,
) {
    let Some(provider_cfg) = file_config.and_then(|cfg| cfg.kernel.providers.get(provider_id))
    else {
        return;
    };

    if let Some(name) = provider_cfg
        .name
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        defaults.provider_name = name.to_string();
    }
    if let Some(base_url) = provider_cfg
        .base_url
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        defaults.base_url = base_url.to_string();
    }
    if let Some(wire_api) = provider_cfg
        .wire_api
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        defaults.wire_api = WireApi::from_str(wire_api);
    }
    if let Some(env_key) = provider_cfg
        .env_key
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        defaults.env_key = env_key.to_string();
    }
    if let Some(model) = provider_cfg
        .model
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        defaults.model = model.to_string();
    }
}

fn is_local_base_url(base_url: &str) -> bool {
    let normalized = base_url.trim().to_ascii_lowercase();
    normalized.starts_with("http://127.0.0.1")
        || normalized.starts_with("http://localhost")
}

fn load_finger_user_config() -> Result<Option<FingerUserConfig>, ConfigError> {
    let path = resolve_finger_config_path();
    if !path.exists() {
        return Ok(None);
    }

    let raw = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }

    serde_json::from_str::<FingerUserConfig>(&raw)
        .map(Some)
        .map_err(|error| ConfigError::ParseConfig {
            path: path.to_string_lossy().to_string(),
            error: error.to_string(),
        })
}

fn resolve_finger_config_path() -> PathBuf {
    if let Ok(path) = env::var(FINGER_CONFIG_PATH_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".finger").join("config.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_api_from_str_responses() {
        assert_eq!(WireApi::from_str("responses"), WireApi::Responses);
        assert_eq!(WireApi::from_str("RESPONSES"), WireApi::Responses);
        assert_eq!(WireApi::from_str(" responses "), WireApi::Responses);
    }

    #[test]
    fn wire_api_from_str_anthropic() {
        assert_eq!(WireApi::from_str("anthropic"), WireApi::Anthropic);
        assert_eq!(WireApi::from_str("anthropic-wire"), WireApi::Anthropic);
        assert_eq!(WireApi::from_str("ANTHROPIC"), WireApi::Anthropic);
    }

    #[test]
    fn wire_api_from_str_openai_chat() {
        assert_eq!(WireApi::from_str("chat"), WireApi::OpenAIChat);
        assert_eq!(WireApi::from_str("openai-chat"), WireApi::OpenAIChat);
    }

    #[test]
    fn wire_api_from_str_fallback() {
        assert_eq!(WireApi::from_str("unknown"), WireApi::Responses);
        assert_eq!(WireApi::from_str(""), WireApi::Responses);
    }

    #[test]
    fn loads_crsb_with_overrides() {
        let key = "KERNEL_CONFIG_TEST_KEY";
        // SAFETY: test process owns this env var namespace.
        unsafe {
            env::set_var(key, "test-key");
        }

        let cfg = load_local_model_config_with(LocalModelOverrides {
            provider_id: Some("crsb".to_string()),
            base_url: None,
            model: None,
            env_key: Some(key.to_string()),
        });

        unsafe {
            env::remove_var(key);
        }

        assert!(cfg.is_ok());
        let cfg = cfg.unwrap();
        assert_eq!(cfg.provider_id, "crsb");
        assert_eq!(cfg.api_key, "test-key");
        assert_eq!(cfg.wire_api, WireApi::Responses);
    }
}
