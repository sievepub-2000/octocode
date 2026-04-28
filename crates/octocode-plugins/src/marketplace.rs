//! Plugin marketplace and registry — dynamic discovery, versioning, and
//! installation of third-party plugins from remote or local sources.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Semantic version triple.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PluginVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl PluginVersion {
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.trim().split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        Some(Self {
            major: parts[0].parse().ok()?,
            minor: parts[1].parse().ok()?,
            patch: parts[2].parse().ok()?,
        })
    }
}

impl fmt::Display for PluginVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Metadata for a plugin in the registry.
#[derive(Debug, Clone)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub version: PluginVersion,
    pub author: String,
    pub source_url: Option<String>,
    pub checksum_sha256: Option<String>,
    pub tags: Vec<String>,
    pub published_at_ms: u128,
}

/// Current installation state of a plugin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallStatus {
    Available,
    Installed,
    UpdateAvailable { installed: PluginVersion, latest: PluginVersion },
    Disabled,
}

/// A plugin listing combining registry data with local status.
#[derive(Debug, Clone)]
pub struct MarketplaceListing {
    pub entry: RegistryEntry,
    pub status: InstallStatus,
}

/// The plugin marketplace / registry center.
pub struct PluginMarketplace {
    registry: Mutex<Vec<RegistryEntry>>,
    installed: Mutex<HashMap<String, PluginVersion>>,
    plugins_dir: PathBuf,
}

impl PluginMarketplace {
    pub fn new(plugins_dir: PathBuf) -> Self {
        Self {
            registry: Mutex::new(Vec::new()),
            installed: Mutex::new(HashMap::new()),
            plugins_dir,
        }
    }

    /// Load the registry from a local manifest file (JSON lines format).
    pub fn load_registry_from_file(&self, path: &Path) -> Result<usize, String> {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some(entry) = Self::parse_registry_line(trimmed) {
                entries.push(entry);
            }
        }

        let count = entries.len();
        *self.registry.lock().unwrap() = entries;
        Ok(count)
    }

    /// Register a plugin entry programmatically.
    pub fn register(&self, entry: RegistryEntry) {
        self.registry.lock().unwrap().push(entry);
    }

    /// Mark a plugin as installed with a given version.
    pub fn mark_installed(&self, plugin_id: &str, version: PluginVersion) {
        self.installed
            .lock()
            .unwrap()
            .insert(plugin_id.to_string(), version);
    }

    /// Uninstall a plugin (remove from installed map and delete directory).
    pub fn uninstall(&self, plugin_id: &str) -> Result<(), String> {
        self.installed.lock().unwrap().remove(plugin_id);
        let plugin_dir = self.plugins_dir.join(plugin_id);
        if plugin_dir.exists() {
            fs::remove_dir_all(&plugin_dir)
                .map_err(|e| format!("failed to remove plugin dir: {e}"))?;
        }
        Ok(())
    }

    /// List all plugins with their marketplace status.
    pub fn list(&self) -> Vec<MarketplaceListing> {
        let registry = self.registry.lock().unwrap();
        let installed = self.installed.lock().unwrap();

        registry
            .iter()
            .map(|entry| {
                let status = match installed.get(&entry.id) {
                    Some(installed_ver) => {
                        if *installed_ver < entry.version {
                            InstallStatus::UpdateAvailable {
                                installed: installed_ver.clone(),
                                latest: entry.version.clone(),
                            }
                        } else {
                            InstallStatus::Installed
                        }
                    }
                    None => InstallStatus::Available,
                };
                MarketplaceListing {
                    entry: entry.clone(),
                    status,
                }
            })
            .collect()
    }

    /// Search registry by keyword (matches id, name, summary, tags).
    pub fn search(&self, query: &str) -> Vec<MarketplaceListing> {
        let query_lower = query.to_lowercase();
        self.list()
            .into_iter()
            .filter(|listing| {
                let e = &listing.entry;
                e.id.to_lowercase().contains(&query_lower)
                    || e.name.to_lowercase().contains(&query_lower)
                    || e.summary.to_lowercase().contains(&query_lower)
                    || e.tags.iter().any(|t| t.to_lowercase().contains(&query_lower))
            })
            .collect()
    }

    /// Get a specific entry by ID.
    pub fn get(&self, plugin_id: &str) -> Option<MarketplaceListing> {
        self.list().into_iter().find(|l| l.entry.id == plugin_id)
    }

    /// Simulate installing a plugin (creates directory + manifest).
    pub fn install(&self, plugin_id: &str) -> Result<(), String> {
        let entry = {
            let registry = self.registry.lock().unwrap();
            registry
                .iter()
                .find(|e| e.id == plugin_id)
                .cloned()
                .ok_or_else(|| format!("plugin '{}' not found in registry", plugin_id))?
        };

        let plugin_dir = self.plugins_dir.join(plugin_id);
        fs::create_dir_all(&plugin_dir)
            .map_err(|e| format!("failed to create plugin dir: {e}"))?;

        // Write a plugin.json manifest
        let manifest = format!(
            "{{\n  \"id\": \"{}\",\n  \"name\": \"{}\",\n  \"version\": \"{}\",\n  \"summary\": \"{}\",\n  \"author\": \"{}\"\n}}\n",
            entry.id, entry.name, entry.version, entry.summary, entry.author
        );
        fs::write(plugin_dir.join("plugin.json"), manifest)
            .map_err(|e| format!("failed to write manifest: {e}"))?;

        self.mark_installed(plugin_id, entry.version);
        Ok(())
    }

    /// Download and install a plugin from its remote `source_url`.
    ///
    /// Fetches the archive, optionally verifies its SHA-256 checksum,
    /// and writes the content to the plugin directory.
    pub fn install_remote(&self, plugin_id: &str) -> Result<(), String> {
        let entry = {
            let registry = self.registry.lock().unwrap();
            registry
                .iter()
                .find(|e| e.id == plugin_id)
                .cloned()
                .ok_or_else(|| format!("plugin '{}' not found in registry", plugin_id))?
        };

        let source_url = entry
            .source_url
            .as_deref()
            .ok_or_else(|| format!("plugin '{}' has no source_url", plugin_id))?;

        // Validate URL scheme
        if !source_url.starts_with("https://") && !source_url.starts_with("http://") {
            return Err(format!("invalid source_url scheme for '{}'", plugin_id));
        }

        // Download
        let response = ureq::get(source_url)
            .timeout(Duration::from_secs(30))
            .call()
            .map_err(|e| format!("download failed for '{}': {}", plugin_id, e))?;

        if response.status() != 200 {
            return Err(format!(
                "download returned HTTP {} for '{}'",
                response.status(),
                plugin_id
            ));
        }

        // Read body with a 50 MB limit
        let mut body = Vec::new();
        response
            .into_reader()
            .take(50 * 1024 * 1024)
            .read_to_end(&mut body)
            .map_err(|e| format!("failed to read download body: {e}"))?;

        // Verify checksum if provided
        if let Some(expected_hash) = &entry.checksum_sha256 {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&body);
            let actual = format!("{:x}", hasher.finalize());
            if actual != *expected_hash {
                return Err(format!(
                    "checksum mismatch for '{}': expected {} got {}",
                    plugin_id, expected_hash, actual
                ));
            }
        }

        // Write to plugin directory
        let plugin_dir = self.plugins_dir.join(plugin_id);
        fs::create_dir_all(&plugin_dir)
            .map_err(|e| format!("failed to create plugin dir: {e}"))?;

        fs::write(plugin_dir.join("plugin.tar.gz"), &body)
            .map_err(|e| format!("failed to write plugin archive: {e}"))?;

        // Write manifest
        let manifest = format!(
            "{{\n  \"id\": \"{}\",\n  \"name\": \"{}\",\n  \"version\": \"{}\",\n  \"summary\": \"{}\",\n  \"author\": \"{}\",\n  \"source\": \"remote\"\n}}\n",
            entry.id, entry.name, entry.version, entry.summary, entry.author
        );
        fs::write(plugin_dir.join("plugin.json"), manifest)
            .map_err(|e| format!("failed to write manifest: {e}"))?;

        self.mark_installed(plugin_id, entry.version);
        Ok(())
    }

    /// Check for available updates.
    pub fn check_updates(&self) -> Vec<MarketplaceListing> {
        self.list()
            .into_iter()
            .filter(|l| matches!(l.status, InstallStatus::UpdateAvailable { .. }))
            .collect()
    }

    /// Number of registered plugins.
    pub fn registry_count(&self) -> usize {
        self.registry.lock().unwrap().len()
    }

    /// Number of installed plugins.
    pub fn installed_count(&self) -> usize {
        self.installed.lock().unwrap().len()
    }

    // ─── Parsing ────────────────────────────────────────────────────────

    fn parse_registry_line(line: &str) -> Option<RegistryEntry> {
        // Format: id|name|version|summary|author|source_url|tags(comma-sep)
        let parts: Vec<&str> = line.splitn(7, '|').collect();
        if parts.len() < 5 {
            return None;
        }

        let version = PluginVersion::parse(parts[2])?;
        let source_url = parts.get(5).and_then(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        });
        let tags = parts
            .get(6)
            .map(|s| s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect())
            .unwrap_or_default();

        Some(RegistryEntry {
            id: parts[0].trim().to_string(),
            name: parts[1].trim().to_string(),
            summary: parts[3].trim().to_string(),
            version,
            author: parts[4].trim().to_string(),
            source_url,
            checksum_sha256: None,
            tags,
            published_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_plugins_dir() -> PathBuf {
        let dir = env::temp_dir().join(format!("octo_marketplace_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn plugin_version_parse_and_display() {
        let v = PluginVersion::parse("1.2.3").unwrap();
        assert_eq!(v, PluginVersion::new(1, 2, 3));
        assert_eq!(v.to_string(), "1.2.3");
    }

    #[test]
    fn plugin_version_ordering() {
        let v1 = PluginVersion::new(1, 0, 0);
        let v2 = PluginVersion::new(1, 1, 0);
        let v3 = PluginVersion::new(2, 0, 0);
        assert!(v1 < v2);
        assert!(v2 < v3);
    }

    #[test]
    fn marketplace_register_and_list() {
        let mp = PluginMarketplace::new(temp_plugins_dir());
        mp.register(RegistryEntry {
            id: "test-plugin".into(),
            name: "Test Plugin".into(),
            summary: "A test plugin".into(),
            version: PluginVersion::new(1, 0, 0),
            author: "tester".into(),
            source_url: None,
            checksum_sha256: None,
            tags: vec!["test".into()],
            published_at_ms: 0,
        });

        let list = mp.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].entry.id, "test-plugin");
        assert_eq!(list[0].status, InstallStatus::Available);
    }

    #[test]
    fn marketplace_install_and_uninstall() {
        let dir = temp_plugins_dir();
        let mp = PluginMarketplace::new(dir.clone());
        mp.register(RegistryEntry {
            id: "my-plugin".into(),
            name: "My Plugin".into(),
            summary: "desc".into(),
            version: PluginVersion::new(0, 1, 0),
            author: "dev".into(),
            source_url: None,
            checksum_sha256: None,
            tags: vec![],
            published_at_ms: 0,
        });

        mp.install("my-plugin").unwrap();
        assert_eq!(mp.installed_count(), 1);
        assert!(dir.join("my-plugin").join("plugin.json").exists());

        mp.uninstall("my-plugin").unwrap();
        assert_eq!(mp.installed_count(), 0);
        assert!(!dir.join("my-plugin").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn marketplace_search() {
        let mp = PluginMarketplace::new(temp_plugins_dir());
        mp.register(RegistryEntry {
            id: "code-fmt".into(),
            name: "Code Formatter".into(),
            summary: "Format code".into(),
            version: PluginVersion::new(2, 0, 0),
            author: "a".into(),
            source_url: None,
            checksum_sha256: None,
            tags: vec!["formatter".into(), "lint".into()],
            published_at_ms: 0,
        });
        mp.register(RegistryEntry {
            id: "git-helper".into(),
            name: "Git Helper".into(),
            summary: "Git utilities".into(),
            version: PluginVersion::new(1, 0, 0),
            author: "b".into(),
            source_url: None,
            checksum_sha256: None,
            tags: vec!["git".into()],
            published_at_ms: 0,
        });

        let results = mp.search("format");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "code-fmt");

        let results = mp.search("git");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "git-helper");
    }

    #[test]
    fn marketplace_update_detection() {
        let mp = PluginMarketplace::new(temp_plugins_dir());
        mp.register(RegistryEntry {
            id: "updatable".into(),
            name: "Updatable".into(),
            summary: "A plugin with updates".into(),
            version: PluginVersion::new(2, 0, 0),
            author: "x".into(),
            source_url: None,
            checksum_sha256: None,
            tags: vec![],
            published_at_ms: 0,
        });

        mp.mark_installed("updatable", PluginVersion::new(1, 0, 0));
        let updates = mp.check_updates();
        assert_eq!(updates.len(), 1);
        assert!(matches!(
            updates[0].status,
            InstallStatus::UpdateAvailable { .. }
        ));
    }

    #[test]
    fn parse_registry_line_valid() {
        let line = "hello|Hello Plugin|1.2.3|A greeting plugin|author1|https://example.com|greet,util";
        let entry = PluginMarketplace::parse_registry_line(line).unwrap();
        assert_eq!(entry.id, "hello");
        assert_eq!(entry.name, "Hello Plugin");
        assert_eq!(entry.version, PluginVersion::new(1, 2, 3));
        assert_eq!(entry.tags, vec!["greet", "util"]);
    }

    #[test]
    fn install_remote_no_source_url() {
        let mp = PluginMarketplace::new(temp_plugins_dir());
        mp.register(RegistryEntry {
            id: "no-url".into(),
            name: "No URL".into(),
            summary: "Missing source".into(),
            version: PluginVersion::new(1, 0, 0),
            author: "dev".into(),
            source_url: None,
            checksum_sha256: None,
            tags: vec![],
            published_at_ms: 0,
        });
        let result = mp.install_remote("no-url");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no source_url"));
    }

    #[test]
    fn install_remote_invalid_scheme() {
        let mp = PluginMarketplace::new(temp_plugins_dir());
        mp.register(RegistryEntry {
            id: "bad-scheme".into(),
            name: "Bad Scheme".into(),
            summary: "ftp source".into(),
            version: PluginVersion::new(1, 0, 0),
            author: "dev".into(),
            source_url: Some("ftp://evil.example.com/plugin.tar.gz".into()),
            checksum_sha256: None,
            tags: vec![],
            published_at_ms: 0,
        });
        let result = mp.install_remote("bad-scheme");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid source_url scheme"));
    }

    #[test]
    fn install_remote_not_found_in_registry() {
        let mp = PluginMarketplace::new(temp_plugins_dir());
        let result = mp.install_remote("nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }
}
