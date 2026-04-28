#![allow(clippy::too_many_arguments)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use octocode_core::OctoError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const USER_SCOPE: &str = "user";
const WORKSPACE_SCOPE: &str = "workspace";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub display_name: String,
    pub provider_id: String,
    pub provider_base_url: Option<String>,
    pub default_model: Option<String>,
    /// Explicit "free" marker. When `Some(true)` the WebUI manage panel
    /// pins a `free` badge on the card. When `None` the legacy heuristic
    /// (id starts with `fcc-`, name contains "free", etc.) still applies
    /// for backward compatibility with existing user profiles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_free: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookCatalogItem {
    pub scope: String,
    pub tool: Option<String>,
    pub index: usize,
    pub command: String,
    pub timing: String,
    pub blocking: bool,
    pub timeout_ms: u64,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolConfig {
    pub scope: String,
    pub name: String,
    pub summary: String,
    pub command_template: String,
    pub minimum_permission: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCommandConfig {
    pub scope: String,
    pub name: String,
    pub summary: String,
    pub template: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCatalog {
    pub tools: Vec<ExternalToolConfig>,
    pub commands: Vec<ExternalCommandConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderProfilesDocument {
    #[serde(default)]
    profiles: Vec<ProviderProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HookFileDef {
    command: String,
    timing: String,
    blocking: bool,
    timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ExternalActionsDocument {
    #[serde(default)]
    tools: Vec<ExternalToolFileDef>,
    #[serde(default)]
    commands: Vec<ExternalCommandFileDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExternalToolFileDef {
    name: String,
    summary: String,
    command_template: String,
    minimum_permission: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExternalCommandFileDef {
    name: String,
    summary: String,
    template: String,
}

pub fn provider_profiles_path(config_home: &Path) -> PathBuf {
    config_home.join("provider-profiles.json")
}

pub fn external_actions_path(scope: &str, workspace_root: &Path, config_home: &Path) -> Result<PathBuf, OctoError> {
    match normalize_scope(scope)?.as_str() {
        WORKSPACE_SCOPE => Ok(workspace_root.join(".octocode").join("external-actions.json")),
        USER_SCOPE => Ok(config_home.join("external-actions.json")),
        _ => unreachable!(),
    }
}

pub fn hooks_file_path(scope: &str, workspace_root: &Path, config_home: &Path) -> Result<PathBuf, OctoError> {
    match normalize_scope(scope)?.as_str() {
        WORKSPACE_SCOPE => Ok(workspace_root.join(".octocode").join("hooks.json")),
        USER_SCOPE => Ok(config_home.join("hooks.json")),
        _ => unreachable!(),
    }
}

pub fn mcp_manifest_path(
    scope: &str,
    id: &str,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<PathBuf, OctoError> {
    let scope = normalize_scope(scope)?;
    let id = normalize_id(id, "mcp id")?;
    let root = match scope.as_str() {
        WORKSPACE_SCOPE => workspace_root.join(".octocode").join("mcp"),
        USER_SCOPE => config_home.join("mcp"),
        _ => unreachable!(),
    };
    Ok(root.join(format!("{id}.conf")))
}

pub fn skill_file_path(
    scope: &str,
    id: &str,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<PathBuf, OctoError> {
    let scope = normalize_scope(scope)?;
    let id = normalize_id(id, "skill id")?;
    let root = match scope.as_str() {
        WORKSPACE_SCOPE => workspace_root.join("skills"),
        USER_SCOPE => config_home.join("skills"),
        _ => unreachable!(),
    };
    Ok(root.join(id).join("SKILL.md"))
}

pub fn load_provider_profiles(config_home: &Path) -> Result<Vec<ProviderProfile>, OctoError> {
    let path = provider_profiles_path(config_home);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = read_text_no_bom(&path)?;
    let mut document: ProviderProfilesDocument = serde_json::from_str(&raw)
        .map_err(|error| OctoError::Runtime(format!("failed to parse {}: {error}", path.display())))?;
    document.profiles.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(document.profiles)
}

pub fn upsert_provider_profile(
    config_home: &Path,
    original_id: Option<&str>,
    mut profile: ProviderProfile,
) -> Result<(), OctoError> {
    profile.id = normalize_id(&profile.id, "provider profile id")?;
    profile.provider_id = normalize_id(&profile.provider_id, "provider id")?;
    profile.display_name = normalize_non_empty(&profile.display_name, "display name")?;
    profile.provider_base_url = normalize_optional(profile.provider_base_url);
    profile.default_model = normalize_optional(profile.default_model);

    let mut profiles = load_provider_profiles(config_home)?;
    if let Some(original_id) = original_id.filter(|value| !value.trim().is_empty()) {
        let original_id = normalize_id(original_id, "provider profile id")?;
        profiles.retain(|item| item.id != original_id);
    }
    profiles.retain(|item| item.id != profile.id);
    profiles.push(profile);
    profiles.sort_by(|left, right| left.id.cmp(&right.id));
    save_provider_profiles(config_home, &profiles)
}

pub fn delete_provider_profile(config_home: &Path, id: &str) -> Result<(), OctoError> {
    let id = normalize_id(id, "provider profile id")?;
    let mut profiles = load_provider_profiles(config_home)?;
    profiles.retain(|item| item.id != id);
    save_provider_profiles(config_home, &profiles)
}

pub fn load_external_catalog(workspace_root: &Path, config_home: &Path) -> Result<ExternalCatalog, OctoError> {
    let mut catalog = ExternalCatalog::default();
    for scope in [WORKSPACE_SCOPE, USER_SCOPE] {
        let path = external_actions_path(scope, workspace_root, config_home)?;
        let document = load_external_actions_document(&path)?;
        catalog.tools.extend(document.tools.into_iter().map(|tool| ExternalToolConfig {
            scope: String::from(scope),
            name: tool.name,
            summary: tool.summary,
            command_template: tool.command_template,
            minimum_permission: normalize_permission(&tool.minimum_permission),
            source_path: path.display().to_string(),
        }));
        catalog.commands.extend(document.commands.into_iter().map(|command| ExternalCommandConfig {
            scope: String::from(scope),
            name: command.name,
            summary: command.summary,
            template: command.template,
            source_path: path.display().to_string(),
        }));
    }
    catalog.tools.sort_by(|left, right| left.name.cmp(&right.name).then(left.scope.cmp(&right.scope)));
    catalog.commands.sort_by(|left, right| left.name.cmp(&right.name).then(left.scope.cmp(&right.scope)));
    Ok(catalog)
}

pub fn upsert_external_tool(
    scope: &str,
    original_name: Option<&str>,
    tool: ExternalToolConfig,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let path = external_actions_path(scope, workspace_root, config_home)?;
    let mut document = load_external_actions_document(&path)?;
    let name = normalize_id(&tool.name, "tool name")?;
    if let Some(original_name) = original_name.filter(|value| !value.trim().is_empty()) {
        let original_name = normalize_id(original_name, "tool name")?;
        document.tools.retain(|entry| entry.name != original_name);
    }
    document.tools.retain(|entry| entry.name != name);
    document.tools.push(ExternalToolFileDef {
        name,
        summary: normalize_non_empty(&tool.summary, "tool summary")?,
        command_template: normalize_non_empty(&tool.command_template, "tool command template")?,
        minimum_permission: normalize_permission(&tool.minimum_permission),
    });
    document.tools.sort_by(|left, right| left.name.cmp(&right.name));
    save_external_actions_document(&path, &document)
}

pub fn delete_external_tool(
    scope: &str,
    name: &str,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let path = external_actions_path(scope, workspace_root, config_home)?;
    let mut document = load_external_actions_document(&path)?;
    let name = normalize_id(name, "tool name")?;
    document.tools.retain(|entry| entry.name != name);
    save_external_actions_document(&path, &document)
}

pub fn upsert_external_command(
    scope: &str,
    original_name: Option<&str>,
    command: ExternalCommandConfig,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let path = external_actions_path(scope, workspace_root, config_home)?;
    let mut document = load_external_actions_document(&path)?;
    let name = normalize_id(&command.name, "command name")?;
    if let Some(original_name) = original_name.filter(|value| !value.trim().is_empty()) {
        let original_name = normalize_id(original_name, "command name")?;
        document.commands.retain(|entry| entry.name != original_name);
    }
    document.commands.retain(|entry| entry.name != name);
    document.commands.push(ExternalCommandFileDef {
        name,
        summary: normalize_non_empty(&command.summary, "command summary")?,
        template: normalize_non_empty(&command.template, "command template")?,
    });
    document.commands.sort_by(|left, right| left.name.cmp(&right.name));
    save_external_actions_document(&path, &document)
}

pub fn delete_external_command(
    scope: &str,
    name: &str,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let path = external_actions_path(scope, workspace_root, config_home)?;
    let mut document = load_external_actions_document(&path)?;
    let name = normalize_id(name, "command name")?;
    document.commands.retain(|entry| entry.name != name);
    save_external_actions_document(&path, &document)
}

pub fn upsert_mcp_manifest(
    scope: &str,
    original_id: Option<&str>,
    original_path: Option<&str>,
    id: &str,
    transport: &str,
    command: Option<String>,
    endpoint: Option<String>,
    description: Option<String>,
    trusted: bool,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let id = normalize_id(id, "mcp id")?;
    let transport = normalize_transport(transport)?;
    let command = normalize_optional(command);
    let endpoint = normalize_optional(endpoint);
    let description = normalize_optional(description);
    if command.is_none() && endpoint.is_none() {
        return Err(OctoError::Runtime(String::from("mcp manifest must define command or endpoint")));
    }
    let allowed_roots = mcp_allowed_roots(workspace_root, config_home);
    let target_dir = if let Some(path) = original_path.filter(|value| !value.trim().is_empty()) {
        resolve_existing_path(path, &allowed_roots, "mcp manifest")?
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| OctoError::Runtime(String::from("invalid mcp manifest path")))?
    } else {
        mcp_manifest_path(scope, &id, workspace_root, config_home)?
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| OctoError::Runtime(String::from("invalid mcp manifest path")))?
    };
    fs::create_dir_all(&target_dir)
        .map_err(|error| OctoError::Runtime(format!("failed to create {}: {error}", target_dir.display())))?;
    let target = target_dir.join(format!("{id}.conf"));
    let mut lines = vec![format!("id={id}"), format!("transport={transport}")];
    if let Some(command) = command {
        lines.push(format!("command={command}"));
    }
    if let Some(endpoint) = endpoint {
        lines.push(format!("endpoint={endpoint}"));
    }
    lines.push(format!("trusted={trusted}"));
    if let Some(description) = description {
        lines.push(format!("description={description}"));
    }
    fs::write(&target, format!("{}\n", lines.join("\n")))
        .map_err(|error| OctoError::Runtime(format!("failed to write {}: {error}", target.display())))?;

    if let Some(path) = original_path.filter(|value| !value.trim().is_empty()) {
        let existing_path = resolve_existing_path(path, &allowed_roots, "mcp manifest")?;
        if existing_path != target && existing_path.is_file() {
            let _ = fs::remove_file(existing_path);
        }
    } else if let Some(original_id) = original_id.filter(|value| !value.trim().is_empty()) {
        let original_id = normalize_id(original_id, "mcp id")?;
        if original_id != id {
            let original_path = mcp_manifest_path(scope, &original_id, workspace_root, config_home)?;
            if original_path.is_file() {
                let _ = fs::remove_file(original_path);
            }
        }
    }
    Ok(())
}

pub fn delete_mcp_manifest(
    scope: &str,
    id: &str,
    original_path: Option<&str>,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let path = if let Some(path) = original_path.filter(|value| !value.trim().is_empty()) {
        resolve_existing_path(path, &mcp_allowed_roots(workspace_root, config_home), "mcp manifest")?
    } else {
        mcp_manifest_path(scope, id, workspace_root, config_home)?
    };
    if path.is_file() {
        fs::remove_file(&path)
            .map_err(|error| OctoError::Runtime(format!("failed to delete {}: {error}", path.display())))?;
    }
    Ok(())
}

pub fn upsert_skill(
    scope: &str,
    original_id: Option<&str>,
    original_path: Option<&str>,
    id: &str,
    summary: Option<String>,
    content: Option<String>,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let id = normalize_id(id, "skill id")?;
    let allowed_roots = skill_allowed_roots(workspace_root, config_home);
    let target_dir = if let Some(path) = original_path.filter(|value| !value.trim().is_empty()) {
        resolve_existing_path(path, &allowed_roots, "skill file")?
            .parent()
            .and_then(Path::parent)
            .map(PathBuf::from)
            .ok_or_else(|| OctoError::Runtime(String::from("invalid skill path")))?
    } else {
        skill_file_path(scope, &id, workspace_root, config_home)?
            .parent()
            .and_then(Path::parent)
            .map(PathBuf::from)
            .ok_or_else(|| OctoError::Runtime(String::from("invalid skill path")))?
    };
    let target = target_dir.join(&id).join("SKILL.md");
    let summary = normalize_optional(summary).unwrap_or_else(|| String::from("local skill"));
    let body = normalize_optional(content).unwrap_or_else(|| {
        format!("---\nname: {id}\ndescription: {summary}\n---\n")
    });
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| OctoError::Runtime(format!("failed to create {}: {error}", parent.display())))?;
    }
    fs::write(&target, body)
        .map_err(|error| OctoError::Runtime(format!("failed to write {}: {error}", target.display())))?;
    if let Some(path) = original_path.filter(|value| !value.trim().is_empty()) {
        let existing_path = resolve_existing_path(path, &allowed_roots, "skill file")?;
        let existing_dir = existing_path.parent().and_then(Path::parent).map(PathBuf::from);
        let target_skill_dir = target.parent().map(PathBuf::from);
        if existing_dir != target_skill_dir {
            if let Some(dir) = existing_dir {
                if dir.is_dir() {
                    let _ = fs::remove_dir_all(dir);
                }
            }
        }
    } else if let Some(original_id) = original_id.filter(|value| !value.trim().is_empty()) {
        let original_id = normalize_id(original_id, "skill id")?;
        if original_id != id {
            let original_path = skill_file_path(scope, &original_id, workspace_root, config_home)?;
            if let Some(parent) = original_path.parent() {
                if parent.is_dir() {
                    let _ = fs::remove_dir_all(parent);
                }
            }
        }
    }
    Ok(())
}

pub fn delete_skill(
    scope: &str,
    id: &str,
    original_path: Option<&str>,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let path = if let Some(path) = original_path.filter(|value| !value.trim().is_empty()) {
        resolve_existing_path(path, &skill_allowed_roots(workspace_root, config_home), "skill file")?
    } else {
        skill_file_path(scope, id, workspace_root, config_home)?
    };
    if let Some(parent) = path.parent() {
        if parent.is_dir() {
            fs::remove_dir_all(parent)
                .map_err(|error| OctoError::Runtime(format!("failed to delete {}: {error}", parent.display())))?;
        }
    }
    Ok(())
}

pub fn list_hook_items(workspace_root: &Path, config_home: &Path) -> Result<Vec<HookCatalogItem>, OctoError> {
    let mut items = Vec::new();
    for scope in [WORKSPACE_SCOPE, USER_SCOPE] {
        let path = hooks_file_path(scope, workspace_root, config_home)?;
        let hooks_map = load_hook_document(&path)?;
        for (tool, defs) in hooks_map {
            let tool_name = if tool == "global" { None } else { Some(tool.clone()) };
            for (index, hook) in defs.into_iter().enumerate() {
                items.push(HookCatalogItem {
                    scope: String::from(scope),
                    tool: tool_name.clone(),
                    index,
                    command: hook.command,
                    timing: normalize_hook_timing(&hook.timing),
                    blocking: hook.blocking,
                    timeout_ms: hook.timeout_ms,
                    source_path: path.display().to_string(),
                });
            }
        }
    }
    Ok(items)
}

pub fn upsert_hook(
    scope: &str,
    tool: Option<String>,
    command: String,
    timing: String,
    blocking: bool,
    timeout_ms: u64,
    original_tool: Option<String>,
    original_index: Option<usize>,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let path = hooks_file_path(scope, workspace_root, config_home)?;
    let mut hooks_map = load_hook_document(&path)?;
    if let Some(index) = original_index {
        let bucket = normalize_hook_bucket(original_tool.as_deref());
        let defs = hooks_map
            .get_mut(&bucket)
            .ok_or_else(|| OctoError::Runtime(format!("hook target not found: {bucket}")))?;
        if index >= defs.len() {
            return Err(OctoError::Runtime(format!("hook index out of range: {index}")));
        }
        defs.remove(index);
        if defs.is_empty() {
            hooks_map.remove(&bucket);
        }
    }

    let bucket = normalize_hook_bucket(tool.as_deref());
    hooks_map.entry(bucket).or_default().push(HookFileDef {
        command: normalize_non_empty(&command, "hook command")?,
        timing: normalize_hook_timing(&timing),
        blocking,
        timeout_ms: timeout_ms.max(1000),
    });

    save_hook_document(&path, &hooks_map)
}

pub fn delete_hook(
    scope: &str,
    tool: Option<String>,
    index: usize,
    workspace_root: &Path,
    config_home: &Path,
) -> Result<(), OctoError> {
    let path = hooks_file_path(scope, workspace_root, config_home)?;
    let mut hooks_map = load_hook_document(&path)?;
    let bucket = normalize_hook_bucket(tool.as_deref());
    let defs = hooks_map
        .get_mut(&bucket)
        .ok_or_else(|| OctoError::Runtime(format!("hook target not found: {bucket}")))?;
    if index >= defs.len() {
        return Err(OctoError::Runtime(format!("hook index out of range: {index}")));
    }
    defs.remove(index);
    if defs.is_empty() {
        hooks_map.remove(&bucket);
    }
    save_hook_document(&path, &hooks_map)
}

fn save_provider_profiles(config_home: &Path, profiles: &[ProviderProfile]) -> Result<(), OctoError> {
    let path = provider_profiles_path(config_home);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| OctoError::Runtime(format!("failed to create {}: {error}", parent.display())))?;
    }
    let body = serde_json::to_string_pretty(&ProviderProfilesDocument {
        profiles: profiles.to_vec(),
    })
    .map_err(|error| OctoError::Runtime(format!("failed to serialize {}: {error}", path.display())))?;
    fs::write(&path, format!("{body}\n"))
        .map_err(|error| OctoError::Runtime(format!("failed to write {}: {error}", path.display())))
}

fn load_external_actions_document(path: &Path) -> Result<ExternalActionsDocument, OctoError> {
    if !path.is_file() {
        return Ok(ExternalActionsDocument::default());
    }
    let raw = read_text_no_bom(path)?;
    serde_json::from_str(&raw)
        .map_err(|error| OctoError::Runtime(format!("failed to parse {}: {error}", path.display())))
}

/// Read a UTF-8 text file and transparently strip a leading byte-order mark.
/// Several Octocode config files (provider-profiles.json, hooks.json, etc.)
/// can be authored or saved by Windows tooling that prepends a UTF-8 BOM,
/// which serde_json refuses to parse. Returning the BOM-stripped content here
/// means every JSON loader in this module is tolerant of that case.
fn read_text_no_bom(path: &Path) -> Result<String, OctoError> {
    let raw = fs::read_to_string(path)
        .map_err(|error| OctoError::Runtime(format!("failed to read {}: {error}", path.display())))?;
    Ok(raw.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(raw))
}

fn save_external_actions_document(path: &Path, document: &ExternalActionsDocument) -> Result<(), OctoError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| OctoError::Runtime(format!("failed to create {}: {error}", parent.display())))?;
    }
    let body = serde_json::to_string_pretty(document)
        .map_err(|error| OctoError::Runtime(format!("failed to serialize {}: {error}", path.display())))?;
    fs::write(path, format!("{body}\n"))
        .map_err(|error| OctoError::Runtime(format!("failed to write {}: {error}", path.display())))
}

fn load_hook_document(path: &Path) -> Result<BTreeMap<String, Vec<HookFileDef>>, OctoError> {
    if !path.is_file() {
        return Ok(BTreeMap::new());
    }
    let raw = read_text_no_bom(path)?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| OctoError::Runtime(format!("failed to parse {}: {error}", path.display())))?;
    let hooks = value
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut out = BTreeMap::new();
    for (key, defs) in hooks {
        let defs_array = defs.as_array().ok_or_else(|| {
            OctoError::Runtime(format!("invalid hooks array for key '{}' in {}", key, path.display()))
        })?;
        let parsed = defs_array
            .iter()
            .map(|entry| serde_json::from_value::<HookFileDef>(entry.clone()).map_err(|error| {
                OctoError::Runtime(format!("invalid hook entry for key '{}' in {}: {error}", key, path.display()))
            }))
            .collect::<Result<Vec<_>, _>>()?;
        out.insert(key, parsed);
    }
    Ok(out)
}

fn save_hook_document(path: &Path, hooks_map: &BTreeMap<String, Vec<HookFileDef>>) -> Result<(), OctoError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| OctoError::Runtime(format!("failed to create {}: {error}", parent.display())))?;
    }
    let mut hooks = Map::new();
    for (key, defs) in hooks_map {
        let value = serde_json::to_value(defs)
            .map_err(|error| OctoError::Runtime(format!("failed to serialize {}: {error}", path.display())))?;
        hooks.insert(key.clone(), value);
    }
    let body = serde_json::to_string_pretty(&serde_json::json!({ "hooks": hooks }))
        .map_err(|error| OctoError::Runtime(format!("failed to serialize {}: {error}", path.display())))?;
    fs::write(path, format!("{body}\n"))
        .map_err(|error| OctoError::Runtime(format!("failed to write {}: {error}", path.display())))
}

fn normalize_scope(scope: &str) -> Result<String, OctoError> {
    match scope.trim().to_ascii_lowercase().as_str() {
        WORKSPACE_SCOPE => Ok(String::from(WORKSPACE_SCOPE)),
        USER_SCOPE | "" => Ok(String::from(USER_SCOPE)),
        other => Err(OctoError::Runtime(format!("unsupported scope: {other}"))),
    }
}

fn normalize_id(raw: &str, label: &str) -> Result<String, OctoError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(OctoError::Runtime(format!("missing {label}")));
    }
    if value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')) {
        return Ok(String::from(value));
    }
    Err(OctoError::Runtime(format!("invalid {label}: {value}")))
}

fn normalize_non_empty(raw: &str, label: &str) -> Result<String, OctoError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(OctoError::Runtime(format!("missing {label}")));
    }
    Ok(String::from(value))
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(String::from(trimmed))
        }
    })
}

fn normalize_transport(raw: &str) -> Result<String, OctoError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "stdio" | "" => Ok(String::from("stdio")),
        "websocket" => Ok(String::from("websocket")),
        other => Err(OctoError::Runtime(format!("unsupported mcp transport: {other}"))),
    }
}

pub fn normalize_permission(raw: &str) -> String {
    match raw.trim() {
        "read-only" => String::from("read-only"),
        "danger-full-access" => String::from("danger-full-access"),
        _ => String::from("workspace-write"),
    }
}

fn normalize_hook_timing(raw: &str) -> String {
    if raw.trim().eq_ignore_ascii_case("after") {
        String::from("after")
    } else {
        String::from("before")
    }
}

fn normalize_hook_bucket(tool: Option<&str>) -> String {
    tool.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
        .unwrap_or_else(|| String::from("global"))
}

fn mcp_allowed_roots(workspace_root: &Path, config_home: &Path) -> Vec<PathBuf> {
    vec![
        workspace_root.join(".octocode").join("mcp"),
        workspace_root.join("mcp"),
        config_home.join("mcp"),
    ]
}

fn skill_allowed_roots(workspace_root: &Path, config_home: &Path) -> Vec<PathBuf> {
    vec![
        workspace_root.join("skills"),
        workspace_root.join(".claude").join("skills"),
        config_home.join("skills"),
    ]
}

fn resolve_existing_path(raw_path: &str, allowed_roots: &[PathBuf], label: &str) -> Result<PathBuf, OctoError> {
    let path = PathBuf::from(raw_path.trim());
    if allowed_roots.iter().any(|root| path.starts_with(root)) {
        return Ok(path);
    }
    Err(OctoError::Runtime(format!("{label} path is outside allowed roots: {}", path.display())))
}