use std::fs;
use std::path::PathBuf;

use octocode_core::{ConfigPaths, OctoError, PermissionMode, RuntimeConfig};

pub(crate) const DEFAULT_PROVIDER_ID: &str = "local-openai";
pub(crate) const DEFAULT_PROVIDER_BASE_URL: &str = "http://192.168.110.2:8000/v1";
pub(crate) const DEFAULT_MODEL: &str = "gemma-4-31b-it-q8-prod";
pub(crate) const DEFAULT_HISTORY_LIMIT: usize = 24;

pub(crate) fn parse_permission_mode(value: &str) -> PermissionMode {
    match value {
        "read-only" => PermissionMode::ReadOnly,
        "danger-full-access" => PermissionMode::DangerFullAccess,
        _ => PermissionMode::WorkspaceWrite,
    }
}

pub(crate) fn permission_mode_label(mode: &PermissionMode) -> &'static str {
    match mode {
        PermissionMode::ReadOnly => "read-only",
        PermissionMode::WorkspaceWrite => "workspace-write",
        PermissionMode::DangerFullAccess => "danger-full-access",
    }
}

/// Return the default config home directory path.
pub(crate) fn default_config_home() -> PathBuf {
    if let Ok(home) = std::env::var("OCTOCODE_CONFIG_HOME") {
        return PathBuf::from(home);
    }
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("octocode");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("octocode");
    }
    PathBuf::from(".octocode")
}

#[derive(Debug, Clone)]
pub struct ConfigLoader {
    paths: ConfigPaths,
}

impl ConfigLoader {
    pub fn new(paths: ConfigPaths) -> Self {
        Self { paths }
    }

    pub fn load(&self) -> Result<RuntimeConfig, OctoError> {
        let path = self.config_file_path();
        if !path.is_file() {
            return Ok(Self::default_config());
        }

        let raw = fs::read_to_string(&path).map_err(|error| {
            OctoError::Runtime(format!("failed to read config {}: {error}", path.display()))
        })?;

        let mut config = Self::default_config();

        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some((key, value)) = trimmed.split_once('=') else {
                continue;
            };
            match key.trim() {
                "provider_id" => {
                    let value = value.trim();
                    if !value.is_empty() {
                        config.provider_id = Some(String::from(value));
                    }
                }
                "provider_base_url" => {
                    let value = value.trim();
                    config.provider_base_url = optional_config_value(value);
                }
                "default_model" => {
                    let value = value.trim();
                    config.default_model = optional_config_value(value);
                }
                "permission_mode" => {
                    config.permission_mode = parse_permission_mode(value.trim());
                }
                "history_limit" => {
                    config.history_limit = value.trim().parse::<usize>().unwrap_or(DEFAULT_HISTORY_LIMIT);
                }
                "denied_tools" => {
                    config.denied_tools = value
                        .trim()
                        .split(',')
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty())
                        .collect();
                }
                "request_timeout_secs" => {
                    config.request_timeout_secs = value.trim().parse::<u64>().unwrap_or(90);
                }
                "agent_max_iterations" => {
                    config.agent_max_iterations =
                        value.trim().parse::<usize>().unwrap_or(0);
                }
                "config_version" => {
                    config.config_version =
                        value.trim().parse::<u32>().unwrap_or(0);
                }
                _ => {}
            }
        }

        Ok(config)
    }

    pub fn save(&self, config: &RuntimeConfig) -> Result<PathBuf, OctoError> {
        let path = self.config_file_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                OctoError::Runtime(format!(
                    "failed to create config dir {}: {error}",
                    parent.display()
                ))
            })?;
        }

        let body = format!(
            concat!(
                "# Octocode config\n",
                "config_version={}\n",
                "provider_id={}\n",
                "provider_base_url={}\n",
                "default_model={}\n",
                "permission_mode={}\n",
                "history_limit={}\n",
                "denied_tools={}\n",
                "request_timeout_secs={}\n",
                "agent_max_iterations={}\n"
            ),
            if config.config_version == 0 { octocode_core::CONFIG_SCHEMA_VERSION } else { config.config_version },
            config.provider_id.as_deref().unwrap_or(DEFAULT_PROVIDER_ID),
            config.provider_base_url.as_deref().unwrap_or(""),
            config.default_model.as_deref().unwrap_or(""),
            permission_mode_label(&config.permission_mode),
            config.history_limit.max(1),
            config.denied_tools.join(","),
            config.request_timeout_secs,
            config.agent_max_iterations,
        );

        fs::write(&path, body).map_err(|error| {
            OctoError::Runtime(format!("failed to write config {}: {error}", path.display()))
        })?;
        Ok(path)
    }

    pub fn ensure_default_file(&self) -> Result<PathBuf, OctoError> {
        let path = self.config_file_path();
        if !path.is_file() {
            self.save(&Self::default_config())?;
        }
        Ok(path)
    }

    pub fn config_file_path(&self) -> PathBuf {
        PathBuf::from(&self.paths.config_home).join("octocode.conf")
    }

    /// Path to the credentials file.
    pub fn credentials_file_path(&self) -> PathBuf {
        PathBuf::from(&self.paths.config_home).join("credentials.conf")
    }

    /// Load an API token.  Resolution order:
    /// 1. `OCTOCODE_API_TOKEN` / `OCTOCODE_LOCAL_API_TOKEN` env var
    /// 2. `api_token=<value>` line in `credentials.conf`
    pub fn load_api_token(&self) -> Option<String> {
        if let Ok(v) = std::env::var("OCTOCODE_LOCAL_API_TOKEN") {
            if !v.is_empty() {
                return Some(v);
            }
        }
        if let Ok(v) = std::env::var("OCTOCODE_API_TOKEN") {
            if !v.is_empty() {
                return Some(v);
            }
        }
        let path = self.credentials_file_path();
        if let Ok(raw) = fs::read_to_string(&path) {
            for line in raw.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('#') || trimmed.is_empty() {
                    continue;
                }
                if let Some((key, value)) = trimmed.split_once('=') {
                    if key.trim() == "api_token" {
                        let token = value.trim().to_string();
                        if !token.is_empty() {
                            return Some(token);
                        }
                    }
                }
            }
        }
        None
    }

    /// Save an API token to the credentials file.
    pub fn save_api_token(&self, token: &str) -> Result<PathBuf, OctoError> {
        let path = self.credentials_file_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                OctoError::Runtime(format!(
                    "failed to create config dir {}: {error}",
                    parent.display()
                ))
            })?;
        }
        let body = format!(
            "# Octocode API credentials — do NOT commit this file\napi_token={token}\n"
        );
        fs::write(&path, &body).map_err(|error| {
            OctoError::Runtime(format!(
                "failed to write credentials {}: {error}",
                path.display()
            ))
        })?;
        Ok(path)
    }

    pub fn default_config() -> RuntimeConfig {
        RuntimeConfig {
            config_version: octocode_core::CONFIG_SCHEMA_VERSION,
            provider_id: Some(String::from(DEFAULT_PROVIDER_ID)),
            provider_base_url: Some(String::from(DEFAULT_PROVIDER_BASE_URL)),
            default_model: Some(String::from(DEFAULT_MODEL)),
            permission_mode: PermissionMode::WorkspaceWrite,
            history_limit: DEFAULT_HISTORY_LIMIT,
            denied_tools: Vec::new(),
            request_timeout_secs: 90,
            agent_max_iterations: 0,
        }
    }
}

fn optional_config_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(String::from(trimmed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config(name: &str) -> ConfigLoader {
        let dir = std::env::temp_dir().join(format!(
            "octocode_config_test_{}_{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let dir_str = dir.to_string_lossy().to_string();
        ConfigLoader::new(ConfigPaths {
            config_home: dir_str.clone(),
            cache_home: dir_str.clone(),
            data_home: dir_str,
        })
    }

    #[test]
    fn default_config_values() {
        let config = ConfigLoader::default_config();
        assert_eq!(config.provider_id.as_deref(), Some(DEFAULT_PROVIDER_ID));
        assert_eq!(config.history_limit, DEFAULT_HISTORY_LIMIT);
        assert!(config.denied_tools.is_empty());
        assert_eq!(config.request_timeout_secs, 90);
    }

    #[test]
    fn load_missing_file_returns_default() {
        let loader = temp_config("missing");
        let config = loader.load().unwrap();
        assert_eq!(config.provider_id.as_deref(), Some(DEFAULT_PROVIDER_ID));
    }

    #[test]
    fn save_and_load_roundtrip() {
        let loader = temp_config("roundtrip");
        let mut config = ConfigLoader::default_config();
        config.provider_id = Some(String::from("test-provider"));
        config.history_limit = 42;
        config.denied_tools = vec![String::from("shell"), String::from("write")];
        config.request_timeout_secs = 120;
        loader.save(&config).unwrap();

        let loaded = loader.load().unwrap();
        assert_eq!(loaded.provider_id.as_deref(), Some("test-provider"));
        assert_eq!(loaded.history_limit, 42);
        assert_eq!(loaded.denied_tools, vec!["shell", "write"]);
        assert_eq!(loaded.request_timeout_secs, 120);
    }

    #[test]
    fn save_and_load_preserves_cleared_provider_fields() {
        let loader = temp_config("cleared_provider_fields");
        let mut config = ConfigLoader::default_config();
        config.provider_base_url = None;
        config.default_model = None;

        loader.save(&config).unwrap();

        let raw = std::fs::read_to_string(loader.config_file_path()).unwrap();
        assert!(raw.contains("provider_base_url=\n"));
        assert!(raw.contains("default_model=\n"));

        let loaded = loader.load().unwrap();
        assert_eq!(loaded.provider_base_url, None);
        assert_eq!(loaded.default_model, None);
    }

    #[test]
    fn parse_permission_modes() {
        assert_eq!(parse_permission_mode("read-only"), PermissionMode::ReadOnly);
        assert_eq!(parse_permission_mode("workspace-write"), PermissionMode::WorkspaceWrite);
        assert_eq!(parse_permission_mode("danger-full-access"), PermissionMode::DangerFullAccess);
        assert_eq!(parse_permission_mode("unknown"), PermissionMode::WorkspaceWrite);
    }

    #[test]
    fn save_and_load_api_token() {
        let loader = temp_config("api_token");
        loader.save_api_token("test-secret-123").unwrap();
        let token = loader.load_api_token();
        assert_eq!(token.as_deref(), Some("test-secret-123"));
    }

    #[test]
    fn config_ignores_comments_and_blank_lines() {
        let loader = temp_config("comments");
        let path = loader.config_file_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(
            &path,
            "# comment\n\nprovider_id=my-provider\n# another comment\nhistory_limit=10\n",
        )
        .unwrap();
        let config = loader.load().unwrap();
        assert_eq!(config.provider_id.as_deref(), Some("my-provider"));
        assert_eq!(config.history_limit, 10);
    }

    #[test]
    fn ensure_default_file_creates_if_missing() {
        let loader = temp_config("ensure_default");
        assert!(!loader.config_file_path().is_file());
        loader.ensure_default_file().unwrap();
        assert!(loader.config_file_path().is_file());
    }
}
