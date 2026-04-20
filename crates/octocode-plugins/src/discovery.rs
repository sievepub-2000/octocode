use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Plugin discovery configuration
#[derive(Debug, Clone)]
pub struct PluginConfig {
    pub id: String,
    pub summary: String,
    pub enabled: bool,
    pub entry_point: Option<String>,
}

/// Plugin discovery service
pub struct PluginDiscovery {
    plugins_dir: PathBuf,
    enabled_plugins: Mutex<HashMap<String, bool>>,
}

impl PluginDiscovery {
    pub fn new(plugins_dir: PathBuf) -> Self {
        Self {
            plugins_dir,
            enabled_plugins: Mutex::new(HashMap::new()),
        }
    }

    /// Discover all plugins in the plugins directory
    pub fn discover(&self) -> Result<Vec<PluginConfig>, String> {
        if !self.plugins_dir.exists() {
            return Ok(Vec::new());
        }

        let mut configs = Vec::new();

        // Scan for plugin manifests (plugin.yaml, plugin.json, plugin.toml)
        for entry in fs::read_dir(&self.plugins_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();

            if path.is_dir() {
                // Check for manifest files in subdirectory
                if let Ok(config) = self.load_plugin_config(&path) {
                    configs.push(config);
                }
            }
        }

        Ok(configs)
    }

    fn load_plugin_config(&self, plugin_dir: &Path) -> Result<PluginConfig, String> {
        // Try loading plugin.yaml first
        let yaml_path = plugin_dir.join("plugin.yaml");
        if yaml_path.exists() {
            return self.parse_yaml_config(&yaml_path);
        }

        // Try loading plugin.json
        let json_path = plugin_dir.join("plugin.json");
        if json_path.exists() {
            return self.parse_json_config(&json_path);
        }

        // Try loading plugin.toml
        let toml_path = plugin_dir.join("plugin.toml");
        if toml_path.exists() {
            return self.parse_toml_config(&toml_path);
        }

        Err(format!(
            "No plugin manifest found in {}",
            plugin_dir.display()
        ))
    }

    fn parse_yaml_config(&self, path: &Path) -> Result<PluginConfig, String> {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        
        // Simple YAML-like parsing (manual since we avoid serde_yaml for dependencies)
        let mut id = String::new();
        let mut summary = String::new();
        let mut enabled = true;
        let mut entry_point = None;

        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("id:") {
                id = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            } else if let Some(rest) = trimmed.strip_prefix("summary:") {
                summary = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            } else if let Some(rest) = trimmed.strip_prefix("enabled:") {
                enabled = rest.trim().parse().unwrap_or(true);
            } else if let Some(rest) = trimmed.strip_prefix("entry_point:") {
                entry_point = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }

        if id.is_empty() {
            return Err("Plugin ID is required".to_string());
        }

        let mut enabled_plugins = self.enabled_plugins.lock().unwrap();
        enabled_plugins.insert(id.clone(), enabled);

        Ok(PluginConfig {
            id,
            summary: if summary.is_empty() {
                "User plugin".to_string()
            } else {
                summary
            },
            enabled,
            entry_point,
        })
    }

    fn parse_json_config(&self, path: &Path) -> Result<PluginConfig, String> {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        
        // Simple JSON-like parsing (manual since we minimize dependencies)
        let mut id = String::new();
        let mut summary = String::new();
        let mut enabled = true;
        let mut entry_point = None;

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.contains("\"id\"") {
                if let Some(start) = trimmed.find(':') {
                    let value = trimmed[start + 1..].trim();
                    let value = value.trim_matches(',').trim();
                    id = value.trim_matches('"').to_string();
                }
            } else if trimmed.contains("\"summary\"") {
                if let Some(start) = trimmed.find(':') {
                    let value = trimmed[start + 1..].trim();
                    let value = value.trim_matches(',').trim();
                    summary = value.trim_matches('"').to_string();
                }
            } else if trimmed.contains("\"enabled\"") {
                if let Some(start) = trimmed.find(':') {
                    let value = trimmed[start + 1..].trim();
                    let value = value.trim_matches(',').trim();
                    enabled = value.parse().unwrap_or(true);
                }
            } else if trimmed.contains("\"entry_point\"") {
                if let Some(start) = trimmed.find(':') {
                    let value = trimmed[start + 1..].trim();
                    let value = value.trim_matches(',').trim();
                    entry_point = Some(value.trim_matches('"').to_string());
                }
            }
        }

        if id.is_empty() {
            return Err("Plugin ID is required".to_string());
        }

        let mut enabled_plugins = self.enabled_plugins.lock().unwrap();
        enabled_plugins.insert(id.clone(), enabled);

        Ok(PluginConfig {
            id,
            summary: if summary.is_empty() {
                "User plugin".to_string()
            } else {
                summary
            },
            enabled,
            entry_point,
        })
    }

    fn parse_toml_config(&self, path: &Path) -> Result<PluginConfig, String> {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        
        let mut id = String::new();
        let mut summary = String::new();
        let mut enabled = true;
        let mut entry_point = None;

        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("id") {
                if let Some(value) = rest.split('=').nth(1) {
                    id = value.trim().trim_matches('"').to_string();
                }
            } else if let Some(rest) = trimmed.strip_prefix("summary") {
                if let Some(value) = rest.split('=').nth(1) {
                    summary = value.trim().trim_matches('"').to_string();
                }
            } else if let Some(rest) = trimmed.strip_prefix("enabled") {
                if let Some(value) = rest.split('=').nth(1) {
                    enabled = value.trim().parse().unwrap_or(true);
                }
            } else if let Some(rest) = trimmed.strip_prefix("entry_point") {
                if let Some(value) = rest.split('=').nth(1) {
                    entry_point = Some(value.trim().trim_matches('"').to_string());
                }
            }
        }

        if id.is_empty() {
            return Err("Plugin ID is required".to_string());
        }

        let mut enabled_plugins = self.enabled_plugins.lock().unwrap();
        enabled_plugins.insert(id.clone(), enabled);

        Ok(PluginConfig {
            id,
            summary: if summary.is_empty() {
                "User plugin".to_string()
            } else {
                summary
            },
            enabled,
            entry_point,
        })
    }

    /// Enable a plugin
    pub fn enable_plugin(&self, id: &str) {
        let mut enabled = self.enabled_plugins.lock().unwrap();
        enabled.insert(id.to_string(), true);
    }

    /// Disable a plugin
    pub fn disable_plugin(&self, id: &str) {
        let mut enabled = self.enabled_plugins.lock().unwrap();
        enabled.insert(id.to_string(), false);
    }

    /// Get plugin enabled status
    pub fn is_plugin_enabled(&self, id: &str) -> bool {
        let enabled = self.enabled_plugins.lock().unwrap();
        enabled.get(id).copied().unwrap_or(true)
    }

    /// Save plugin state to configuration file
    pub fn save_plugin_state(&self, config_file: &Path) -> Result<(), String> {
        let enabled = self.enabled_plugins.lock().unwrap();
        let mut content = String::new();
        content.push_str("[plugins]\n");

        for (id, enabled_flag) in enabled.iter() {
            content.push_str(&format!("\"{}\" = {}\n", id, enabled_flag));
        }

        fs::write(config_file, content).map_err(|e| e.to_string())
    }

    /// Load plugin state from configuration file
    pub fn load_plugin_state(&self, config_file: &Path) -> Result<(), String> {
        if !config_file.exists() {
            return Ok(());
        }

        let content = fs::read_to_string(config_file).map_err(|e| e.to_string())?;
        let mut enabled = self.enabled_plugins.lock().unwrap();

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('"') && trimmed.contains('=') {
                if let Some(eq_pos) = trimmed.find('=') {
                    let id = trimmed[1..eq_pos - 1].to_string();
                    let enabled_flag = trimmed[eq_pos + 1..]
                        .trim()
                        .parse::<bool>()
                        .unwrap_or(true);
                    enabled.insert(id, enabled_flag);
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_manages_plugin_state() {
        let discovery = PluginDiscovery::new(PathBuf::from("./nonexistent"));

        discovery.enable_plugin("plugin-a");
        assert!(discovery.is_plugin_enabled("plugin-a"));

        discovery.disable_plugin("plugin-a");
        assert!(!discovery.is_plugin_enabled("plugin-a"));
    }

    #[test]
    fn discovery_empty_dir() {
        let discovery = PluginDiscovery::new(PathBuf::from("./nonexistent_dir_12345"));
        let result = discovery.discover().unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn discovery_unknown_plugin_enabled_by_default() {
        let discovery = PluginDiscovery::new(PathBuf::from("./nonexistent"));
        assert!(discovery.is_plugin_enabled("unknown-plugin"));
    }
}
