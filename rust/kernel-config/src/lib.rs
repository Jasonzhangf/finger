use std::env;

use thiserror::Error;

pub const DEFAULT_PROVIDER_ID: &str = "crsb";
pub const DEFAULT_PROVIDER_NAME: &str = "crsb";
pub const DEFAULT_BASE_URL: &str = "https://codex.funai.vip/openai";
pub const DEFAULT_WIRE_API: &str = "responses";
pub const DEFAULT_ENV_KEY: &str = "CRS_OAI_KEY2";
pub const DEFAULT_MODEL: &str = "gpt-5.3-codex";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalModelConfig {
    pub provider_id: String,
    pub provider_name: String,
    pub base_url: String,
    pub wire_api: String,
    pub env_key: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LocalModelOverrides {
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub env_key: Option<String>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("environment variable '{0}' is not set")]
    MissingEnvVar(String),
}

pub fn load_crsb_config() -> Result<LocalModelConfig, ConfigError> {
    load_crsb_config_with(LocalModelOverrides::default())
}

pub fn load_crsb_config_with(overrides: LocalModelOverrides) -> Result<LocalModelConfig, ConfigError> {
    let env_key = overrides
        .env_key
        .unwrap_or_else(|| DEFAULT_ENV_KEY.to_string());
    let api_key = env::var(&env_key).map_err(|_| ConfigError::MissingEnvVar(env_key.clone()))?;

    Ok(LocalModelConfig {
        provider_id: DEFAULT_PROVIDER_ID.to_string(),
        provider_name: DEFAULT_PROVIDER_NAME.to_string(),
        base_url: overrides
            .base_url
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
        wire_api: DEFAULT_WIRE_API.to_string(),
        env_key,
        api_key,
        model: overrides.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_crsb_with_overrides() {
        let key = "KERNEL_CONFIG_TEST_KEY";
        // SAFETY: test process owns this env var namespace.
        unsafe { env::set_var(key, "test-key"); }

        let cfg = load_crsb_config_with(LocalModelOverrides {
            base_url: Some("https://example.com/openai".to_string()),
            model: Some("gpt-test".to_string()),
            env_key: Some(key.to_string()),
        })
        .expect("load config");

        assert_eq!(cfg.provider_id, "crsb");
        assert_eq!(cfg.base_url, "https://example.com/openai");
        assert_eq!(cfg.model, "gpt-test");
        assert_eq!(cfg.api_key, "test-key");

        // SAFETY: test process owns this env var namespace.
        unsafe { env::remove_var(key); }
    }
}
