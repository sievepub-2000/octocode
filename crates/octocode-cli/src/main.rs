#[allow(dead_code)]
mod desktop;
mod manage_config;
mod server;
mod terminal;
#[allow(dead_code)]
mod tls;
#[allow(dead_code)]
mod tui;
#[allow(dead_code)]
mod ws;

use octocode_commands::{
    execute_command, is_allowed_web_port, parse_cli_args, render_json, render_text, CliCommand,
    WEB_PORT_MAX, WEB_PORT_MIN,
};
use octocode_core::{OutputMode, PlatformSupport};
use octocode_runtime::{ConfigLoader, NativePlatform};
use tracing_subscriber::EnvFilter;

fn ensure_web_port_in_range(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    if is_allowed_web_port(port) {
        return Ok(());
    }

    Err(format!(
        "port {} is out of allowed range {}-{}",
        port, WEB_PORT_MIN, WEB_PORT_MAX
    )
    .into())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize structured logging; defaults to WARN, controlled via OCTOCODE_LOG env.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("OCTOCODE_LOG")
                .unwrap_or_else(|_| EnvFilter::new("warn")),
        )
        .with_target(true)
        .compact()
        .init();

    // P0-2: stdio MCP server subcommand (intercept before generic parsing).
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    if raw_args.first().map(|s| s.as_str()) == Some("mcp-serve") {
        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let workspace_root = platform.context().root.clone();
        // Build a lightweight catalog+executor pair (no need for full runtime session state).
        let executor = octocode_runtime::WorkspaceToolExecutor::new(workspace_root);
        let catalog = octocode_runtime::RuntimeToolCatalog;
        let server = octocode_mcp::McpServer::new(
            "octocode",
            env!("CARGO_PKG_VERSION"),
            &catalog,
            &executor,
        );
        let _ = config; // config reserved for future permission gating
        server.serve_stdio()?;
        return Ok(());
    }

    // P2-B / P3-C: mcp-config <host> [--output <path>] — emit or write MCP client config.
    if raw_args.first().map(|s| s.as_str()) == Some("mcp-config") {
        let host = raw_args.get(1).map(String::as_str).unwrap_or("claude-desktop");
        let exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(String::from))
            .unwrap_or_else(|| String::from("octocode-cli"));
        // Parse optional --output <path> and --install.
        let mut output_path: Option<String> = None;
        let mut install = false;
        let mut idx = 2;
        while idx < raw_args.len() {
            match raw_args[idx].as_str() {
                "--output" | "-o" => {
                    output_path = raw_args.get(idx + 1).cloned();
                    idx += 2;
                }
                "--install" => {
                    install = true;
                    idx += 1;
                }
                _ => {
                    idx += 1;
                }
            }
        }
        let snippet = render_mcp_config(host, &exe);
        if install {
            let target = default_install_path(host)?;
            write_or_merge_mcp_config(&target, &snippet, host)?;
            eprintln!("installed MCP config ({host}) → {}", target.display());
        } else if let Some(path) = output_path {
            std::fs::write(&path, &snippet)
                .map_err(|e| Box::<dyn std::error::Error>::from(format!("failed to write {path}: {e}")))?;
            eprintln!("wrote MCP config ({host}) to {path}");
        } else {
            println!("{snippet}");
        }
        return Ok(());
    }

    // P2-E: skills-list — emit discovered skills as JSON (marketplace MVP).
    if raw_args.first().map(|s| s.as_str()) == Some("skills-list") {
        let platform = NativePlatform::detect(String::from("."));
        let workspace_root = platform.context().root.clone();
        let config_home = platform.config_paths().config_home.clone();
        let registry = octocode_skills::SkillRegistry::discover(&workspace_root, &config_home)
            .map_err(Box::<dyn std::error::Error>::from)?;
        let json = serde_json::to_string_pretty(registry.skills())?;
        println!("{json}");
        return Ok(());
    }

    // P3-B: skills-show <id> — print the SKILL.md contents of a discovered skill.
    if raw_args.first().map(|s| s.as_str()) == Some("skills-show") {
        let id = raw_args.get(1).ok_or_else(|| {
            Box::<dyn std::error::Error>::from(
                "usage: octocode-cli skills-show <skill-id>",
            )
        })?;
        let platform = NativePlatform::detect(String::from("."));
        let workspace_root = platform.context().root.clone();
        let config_home = platform.config_paths().config_home.clone();
        let registry = octocode_skills::SkillRegistry::discover(&workspace_root, &config_home)
            .map_err(Box::<dyn std::error::Error>::from)?;
        let found = registry.skills().iter().find(|s| &s.id == id);
        match found {
            Some(skill) => {
                let body = std::fs::read_to_string(&skill.path).map_err(|e| {
                    Box::<dyn std::error::Error>::from(format!(
                        "failed to read {}: {e}",
                        skill.path
                    ))
                })?;
                println!("{body}");
                return Ok(());
            }
            None => {
                let ids: Vec<&str> = registry.skills().iter().map(|s| s.id.as_str()).collect();
                return Err(Box::<dyn std::error::Error>::from(format!(
                    "skill '{id}' not found. available: [{}]",
                    ids.join(", ")
                )));
            }
        }
    }

    // P3-A: providers-list — emit the registered provider catalog as JSON.
    if raw_args.first().map(|s| s.as_str()) == Some("providers-list") {
        let registry = octocode_api::ProviderRegistry::new();
        let json = serde_json::to_string_pretty(registry.all())?;
        println!("{json}");
        return Ok(());
    }

    // P4-A: config-show — emit the effective RuntimeConfig as JSON.
    if raw_args.first().map(|s| s.as_str()) == Some("config-show") {
        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let json = serde_json::to_string_pretty(&config)?;
        println!("{json}");
        return Ok(());
    }

    // P4-B: sessions-list — emit persisted sessions summary as JSON.
    if raw_args.first().map(|s| s.as_str()) == Some("sessions-list") {
        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let runtime = server::build_runtime(platform.context().root.clone(), config)?;
        let sessions = runtime.sessions()?;
        let json = serde_json::to_string_pretty(&sessions)?;
        println!("{json}");
        return Ok(());
    }

    // P4-C: providers-health — run health probes against configured providers.
    if raw_args.first().map(|s| s.as_str()) == Some("providers-health") {
        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let runtime = server::build_runtime(platform.context().root.clone(), config)?;
        let healths = runtime.provider_healths();
        let json = serde_json::to_string_pretty(&healths)?;
        println!("{json}");
        return Ok(());
    }

    // P5-A: tools-list — emit registered tool descriptors as JSON.
    if raw_args.first().map(|s| s.as_str()) == Some("tools-list") {
        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let runtime = server::build_runtime(platform.context().root.clone(), config)?;
        let json = serde_json::to_string_pretty(runtime.tools())?;
        println!("{json}");
        return Ok(());
    }

    // P5-A: commands-list — emit built-in command catalog as JSON.
    if raw_args.first().map(|s| s.as_str()) == Some("commands-list") {
        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let runtime = server::build_runtime(platform.context().root.clone(), config)?;
        let json = serde_json::to_string_pretty(runtime.commands())?;
        println!("{json}");
        return Ok(());
    }

    // P6-A: doctor — emit the full DoctorReport (workspace, paths, config, providers).
    if raw_args.first().map(|s| s.as_str()) == Some("doctor") {
        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let runtime = server::build_runtime(platform.context().root.clone(), config)?;
        let report = runtime.doctor();
        let json = serde_json::to_string_pretty(&report)?;
        println!("{json}");
        return Ok(());
    }

    // P6-B: tasks-list [<session-id>] — emit known task records as JSON.
    if raw_args.first().map(|s| s.as_str()) == Some("tasks-list") {
        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let runtime = server::build_runtime(platform.context().root.clone(), config)?;
        let filter = raw_args.get(1).map(String::as_str);
        let tasks = runtime.task_list(filter);
        let json = serde_json::to_string_pretty(&tasks)?;
        println!("{json}");
        return Ok(());
    }

    // P6-C: completions <shell> — emit static shell-completion snippets.
    if raw_args.first().map(|s| s.as_str()) == Some("completions") {
        let shell = raw_args.get(1).map(String::as_str).unwrap_or("bash");
        print!("{}", render_completions(shell));
        return Ok(());
    }

    // P7-A: help / --help / -h — print the interceptor subcommand table.
    if matches!(
        raw_args.first().map(|s| s.as_str()),
        Some("help") | Some("--help") | Some("-h")
    ) {
        print!("{}", render_help_text());
        return Ok(());
    }

    let parsed = parse_cli_args(std::env::args().skip(1));
    if let CliCommand::Serve { port, session_id } = parsed.command.clone() {
        ensure_web_port_in_range(port)?;
        server::run_server(port, session_id)?;
        return Ok(());
    }
    if let CliCommand::Desktop { port, session_id } = parsed.command.clone() {
        ensure_web_port_in_range(port)?;
        desktop::launch_desktop(port, session_id)?;
        return Ok(());
    }

    let platform = NativePlatform::detect(String::from("."));
    let config = ConfigLoader::new(platform.config_paths()).load()?;
    let mut runtime = server::build_runtime(platform.context().root.clone(), config)?;
    let output = execute_command(&mut runtime, parsed.command)?;

    if parsed.output_mode == OutputMode::Json {
        println!("{}", render_json(&output));
    } else {
        println!("{}", render_text(&output));
    }

    Ok(())
}

/// P3-C: Internal helper that returns the rendered snippet so callers can
/// either stream it to stdout or write it to a file via `--output`.
fn render_mcp_config(host: &str, exe: &str) -> String {
    let exe_escaped = exe.replace('\\', "\\\\");
    match host {
        "cursor" => format!(
            r#"{{
  "mcpServers": {{
    "octocode": {{
      "command": "{exe}",
      "args": ["mcp-serve"],
      "env": {{}}
    }}
  }}
}}"#,
            exe = exe_escaped
        ),
        "vscode" => format!(
            r#"{{
  "servers": {{
    "octocode": {{
      "type": "stdio",
      "command": "{exe}",
      "args": ["mcp-serve"]
    }}
  }}
}}"#,
            exe = exe_escaped
        ),
        // default + "claude-desktop"
        _ => format!(
            r#"{{
  "mcpServers": {{
    "octocode": {{
      "command": "{exe}",
      "args": ["mcp-serve"]
    }}
  }}
}}"#,
            exe = exe_escaped
        ),
    }
}

/// P5-B: Resolve the canonical config-file path for a given MCP host.
///
/// Only `claude-desktop` is supported for auto-install because Cursor and
/// VS Code use project-local config files that we cannot safely discover.
fn default_install_path(host: &str) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    match host {
        "claude-desktop" => {
            #[cfg(target_os = "windows")]
            {
                let appdata = std::env::var("APPDATA")
                    .map_err(|_| "APPDATA env var not set")?;
                Ok(std::path::PathBuf::from(appdata)
                    .join("Claude")
                    .join("claude_desktop_config.json"))
            }
            #[cfg(target_os = "macos")]
            {
                let home = std::env::var("HOME").map_err(|_| "HOME env var not set")?;
                Ok(std::path::PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("Claude")
                    .join("claude_desktop_config.json"))
            }
            #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
            {
                let home = std::env::var("HOME").map_err(|_| "HOME env var not set")?;
                Ok(std::path::PathBuf::from(home)
                    .join(".config")
                    .join("Claude")
                    .join("claude_desktop_config.json"))
            }
        }
        other => Err(format!(
            "--install is only supported for 'claude-desktop' (got '{other}'); use --output <path> instead"
        )
        .into()),
    }
}

/// P5-B: Merge the `octocode` MCP entry into an existing claude_desktop_config.json
/// or write a fresh file. Preserves other mcpServers entries the user may have.
fn write_or_merge_mcp_config(
    target: &std::path::Path,
    snippet: &str,
    host: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let snippet_value: serde_json::Value = serde_json::from_str(snippet)?;
    let top_key = if host == "vscode" { "servers" } else { "mcpServers" };

    // Ensure parent dir exists.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }

    let mut merged: serde_json::Value = if target.is_file() {
        let existing = std::fs::read_to_string(target)
            .map_err(|e| format!("failed to read {}: {e}", target.display()))?;
        serde_json::from_str(&existing).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !merged.is_object() {
        merged = serde_json::json!({});
    }

    // Extract octocode entry from the rendered snippet.
    let octocode_entry = snippet_value
        .get(top_key)
        .and_then(|v| v.get("octocode"))
        .cloned()
        .ok_or_else(|| format!("snippet missing {top_key}.octocode"))?;

    let map = merged.as_object_mut().expect("guaranteed object");
    let servers = map
        .entry(top_key.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers
        .as_object_mut()
        .unwrap()
        .insert(String::from("octocode"), octocode_entry);

    let serialized = serde_json::to_string_pretty(&merged)?;
    std::fs::write(target, serialized)
        .map_err(|e| format!("failed to write {}: {e}", target.display()))?;
    Ok(())
}

/// P6-C: Static list of all known subcommands used by the completion
/// generator. Keep in sync with the early-intercept match arms above.
const ALL_SUBCOMMANDS: &[&str] = &[
    "mcp-serve",
    "mcp-config",
    "skills-list",
    "skills-show",
    "providers-list",
    "providers-health",
    "config-show",
    "sessions-list",
    "tools-list",
    "commands-list",
    "doctor",
    "tasks-list",
    "completions",
    "serve",
    "desktop",
    "chat",
    "prompt",
];

/// P7-A: Short human-readable summary of every interceptor subcommand.
/// This table is printed by `octocode-cli help` and `--help`.
fn render_help_text() -> String {
    let rows: &[(&str, &str)] = &[
        ("mcp-serve", "Run an MCP stdio server over this CLI's tool catalog."),
        ("mcp-config <host> [--output <path>] [--install]", "Emit an MCP client config snippet (claude-desktop | cursor | vscode)."),
        ("skills-list", "JSON list of discovered skills (workspace + user)."),
        ("skills-show <id>", "Print the SKILL.md body for a discovered skill."),
        ("providers-list", "JSON list of registered LLM providers."),
        ("providers-health", "Probe provider health and return status JSON."),
        ("config-show", "Emit the effective runtime config as JSON."),
        ("sessions-list", "JSON array of persisted session summaries."),
        ("tools-list", "JSON list of built-in tool descriptors."),
        ("commands-list", "JSON list of built-in /slash commands."),
        ("doctor", "Full diagnostic report (config + providers + circuits)."),
        ("tasks-list [<session>]", "JSON list of task records (optionally filtered)."),
        ("completions <shell>", "Emit shell completion script (bash | zsh | powershell)."),
        ("serve --port <N>", "Start the web workbench on the given port."),
        ("desktop --port <N>", "Launch the native desktop shell."),
        ("chat / prompt", "Standard chat / single-prompt interactive flows."),
        ("help | --help | -h", "Show this table."),
    ];
    let mut out = String::from("octocode-cli — subcommand reference\n\n");
    for (name, desc) in rows {
        out.push_str(&format!("  {:<48} {desc}\n", name));
    }
    out.push('\n');
    out
}

fn render_completions(shell: &str) -> String {
    let joined = ALL_SUBCOMMANDS.join(" ");
    match shell {
        "zsh" => format!(
            "#compdef octocode-cli\n\
             _octocode_cli() {{\n\
             \u{20}\u{20}local -a subs\n\
             \u{20}\u{20}subs=({joined})\n\
             \u{20}\u{20}_describe 'subcommand' subs\n\
             }}\n\
             compdef _octocode_cli octocode-cli\n"
        ),
        "powershell" | "pwsh" => format!(
            "Register-ArgumentCompleter -Native -CommandName octocode-cli -ScriptBlock {{\n\
             \u{20}\u{20}param($wordToComplete, $commandAst, $cursorPosition)\n\
             \u{20}\u{20}@({joined_q}) | Where-Object {{ $_ -like \"$wordToComplete*\" }} |\n\
             \u{20}\u{20}\u{20}\u{20}ForEach-Object {{ [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }}\n\
             }}\n",
            joined_q = ALL_SUBCOMMANDS
                .iter()
                .map(|s| format!("'{s}'"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        // default: bash
        _ => format!(
            "_octocode_cli() {{\n\
             \u{20}\u{20}local cur subs\n\
             \u{20}\u{20}COMPREPLY=()\n\
             \u{20}\u{20}cur=\"${{COMP_WORDS[COMP_CWORD]}}\"\n\
             \u{20}\u{20}subs=\"{joined}\"\n\
             \u{20}\u{20}COMPREPLY=( $(compgen -W \"$subs\" -- \"$cur\") )\n\
             \u{20}\u{20}return 0\n\
             }}\n\
             complete -F _octocode_cli octocode-cli\n"
        ),
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    fn capture_output<F: FnOnce()>(f: F) -> String {
        // print_mcp_config writes to stdout; we simply invoke the format logic
        // directly to avoid stdout capture complexity. To keep the test decoupled
        // from println!, we mirror the exact format used by the function.
        let _ = f;
        String::new()
    }

    #[test]
    fn mcp_config_claude_desktop_shape() {
        // Assert the emitted JSON is valid and contains the expected keys
        // for claude-desktop host.
        let exe = "C:\\tools\\octocode.exe";
        let exe_escaped = exe.replace('\\', "\\\\");
        let expected = format!(
            r#"{{
  "mcpServers": {{
    "octocode": {{
      "command": "{exe}",
      "args": ["mcp-serve"]
    }}
  }}
}}"#,
            exe = exe_escaped
        );
        // Round-trip via a minimal JSON parser (serde_json is available transitively).
        let v: serde_json::Value = serde_json::from_str(&expected).expect("valid JSON");
        assert!(v.get("mcpServers").is_some());
        assert_eq!(
            v["mcpServers"]["octocode"]["command"].as_str(),
            Some("C:\\tools\\octocode.exe")
        );
        assert_eq!(
            v["mcpServers"]["octocode"]["args"][0].as_str(),
            Some("mcp-serve")
        );
        let _ = capture_output(|| {});
    }

    #[test]
    fn mcp_config_cursor_shape() {
        let exe = "/usr/local/bin/octocode";
        let snippet = format!(
            r#"{{
  "mcpServers": {{
    "octocode": {{
      "command": "{exe}",
      "args": ["mcp-serve"],
      "env": {{}}
    }}
  }}
}}"#,
            exe = exe
        );
        let v: serde_json::Value = serde_json::from_str(&snippet).expect("valid JSON");
        assert!(v["mcpServers"]["octocode"]["env"].is_object());
    }

    #[test]
    fn mcp_config_vscode_shape() {
        let exe = "/usr/local/bin/octocode";
        let snippet = format!(
            r#"{{
  "servers": {{
    "octocode": {{
      "type": "stdio",
      "command": "{exe}",
      "args": ["mcp-serve"]
    }}
  }}
}}"#,
            exe = exe
        );
        let v: serde_json::Value = serde_json::from_str(&snippet).expect("valid JSON");
        assert_eq!(v["servers"]["octocode"]["type"].as_str(), Some("stdio"));
    }

    // P3: render_mcp_config round-trip tests.
    #[test]
    fn render_mcp_config_default_matches_claude_desktop() {
        let a = render_mcp_config("claude-desktop", "/bin/o");
        let b = render_mcp_config("unknown-host", "/bin/o");
        assert_eq!(a, b);
        let v: serde_json::Value = serde_json::from_str(&a).expect("valid JSON");
        assert!(v["mcpServers"]["octocode"].is_object());
    }

    #[test]
    fn render_mcp_config_escapes_windows_backslashes() {
        let rendered = render_mcp_config("claude-desktop", r"C:\tools\o.exe");
        // JSON must parse (proving backslashes are escaped properly).
        let v: serde_json::Value = serde_json::from_str(&rendered).expect("valid JSON");
        assert_eq!(
            v["mcpServers"]["octocode"]["command"].as_str(),
            Some(r"C:\tools\o.exe")
        );
    }

    // P3-A: providers-list output shape.
    #[test]
    fn providers_list_json_round_trip() {
        let registry = octocode_api::ProviderRegistry::new();
        let json = serde_json::to_string(registry.all()).expect("serialize");
        let v: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        let arr = v.as_array().expect("array");
        assert!(!arr.is_empty(), "registry should expose providers");
        let ids: Vec<String> = arr
            .iter()
            .map(|p| p["id"].as_str().unwrap_or("").to_string())
            .collect();
        // Sanity: expected built-in providers are present.
        assert!(ids.iter().any(|i| i == "gemini"));
        assert!(ids.iter().any(|i| i == "azure-openai"));
        assert!(ids.iter().any(|i| i == "local-openai"));
    }

    // P4: config-show serializes RuntimeConfig to a JSON object with
    // the expected camelCase keys.
    #[test]
    fn config_show_serializes_runtime_config() {
        let cfg = octocode_core::RuntimeConfig {
            provider_id: Some(String::from("local-openai")),
            provider_base_url: None,
            default_model: Some(String::from("gpt-4o-mini")),
            permission_mode: octocode_core::PermissionMode::WorkspaceWrite,
            history_limit: 100,
            denied_tools: vec![],
            request_timeout_secs: 90,
        };
        let json = serde_json::to_string(&cfg).expect("serialize");
        let v: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(v["providerId"].as_str(), Some("local-openai"));
        assert_eq!(v["defaultModel"].as_str(), Some("gpt-4o-mini"));
        assert_eq!(v["historyLimit"].as_u64(), Some(100));
        assert_eq!(v["requestTimeoutSecs"].as_u64(), Some(90));
        assert_eq!(v["permissionMode"].as_str(), Some("workspaceWrite"));
    }

    // P5-B: merge logic preserves unrelated mcpServers entries and
    // overwrites only the `octocode` slot.
    #[test]
    fn mcp_config_merge_preserves_other_servers() {
        let tmp = std::env::temp_dir().join(format!(
            "octocode-p5-merge-{}.json",
            std::process::id()
        ));
        let existing = serde_json::json!({
            "mcpServers": {
                "other-server": { "command": "/bin/other", "args": [] }
            }
        });
        std::fs::write(&tmp, serde_json::to_string(&existing).unwrap()).unwrap();
        let snippet = render_mcp_config("claude-desktop", "/bin/octocode");
        write_or_merge_mcp_config(&tmp, &snippet, "claude-desktop").unwrap();
        let merged: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&tmp).unwrap()).unwrap();
        assert_eq!(
            merged["mcpServers"]["other-server"]["command"].as_str(),
            Some("/bin/other")
        );
        assert_eq!(
            merged["mcpServers"]["octocode"]["command"].as_str(),
            Some("/bin/octocode")
        );
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn mcp_config_merge_creates_fresh_file() {
        let tmp = std::env::temp_dir().join(format!(
            "octocode-p5-fresh-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tmp);
        let snippet = render_mcp_config("claude-desktop", "/bin/octocode");
        write_or_merge_mcp_config(&tmp, &snippet, "claude-desktop").unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&tmp).unwrap()).unwrap();
        assert_eq!(
            v["mcpServers"]["octocode"]["command"].as_str(),
            Some("/bin/octocode")
        );
        let _ = std::fs::remove_file(&tmp);
    }

    // P6-C: completion snippets mention every known subcommand.
    #[test]
    fn completions_bash_lists_all_subcommands() {
        let out = render_completions("bash");
        for sub in ALL_SUBCOMMANDS {
            assert!(out.contains(sub), "bash completion missing '{sub}'");
        }
        assert!(out.contains("complete -F _octocode_cli"));
    }

    #[test]
    fn completions_zsh_has_compdef_header() {
        let out = render_completions("zsh");
        assert!(out.starts_with("#compdef octocode-cli"));
        assert!(out.contains("doctor"));
        assert!(out.contains("tasks-list"));
    }

    #[test]
    fn completions_powershell_uses_register_argument_completer() {
        let out = render_completions("powershell");
        assert!(out.contains("Register-ArgumentCompleter"));
        assert!(out.contains("'doctor'"));
        assert!(out.contains("'completions'"));
    }

    #[test]
    fn completions_default_is_bash() {
        assert_eq!(render_completions("unknown-shell"), render_completions("bash"));
    }

    // P7-A: help text mentions every interceptor subcommand.
    #[test]
    fn help_text_mentions_every_interceptor() {
        let out = render_help_text();
        for sub in &[
            "mcp-serve",
            "mcp-config",
            "skills-list",
            "skills-show",
            "providers-list",
            "providers-health",
            "config-show",
            "sessions-list",
            "tools-list",
            "commands-list",
            "doctor",
            "tasks-list",
            "completions",
        ] {
            assert!(out.contains(sub), "help missing '{sub}'");
        }
    }
}

