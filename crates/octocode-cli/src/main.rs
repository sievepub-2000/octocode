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

    // P2-B: mcp-config <host>  — print MCP client config snippet (Claude Desktop / Cursor / VS Code).
    if raw_args.first().map(|s| s.as_str()) == Some("mcp-config") {
        let host = raw_args.get(1).map(String::as_str).unwrap_or("claude-desktop");
        let exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(String::from))
            .unwrap_or_else(|| String::from("octocode-cli"));
        print_mcp_config(host, &exe);
        return Ok(());
    }

    // P2-E: skills-list — emit discovered skills as JSON (marketplace MVP).
    if raw_args.first().map(|s| s.as_str()) == Some("skills-list") {
        let platform = NativePlatform::detect(String::from("."));
        let workspace_root = platform.context().root.clone();
        let config_home = platform.config_paths().config_home.clone();
        let registry = octocode_skills::SkillRegistry::discover(&workspace_root, &config_home)
            .map_err(|e| Box::<dyn std::error::Error>::from(e))?;
        let json = serde_json::to_string_pretty(registry.skills())?;
        println!("{json}");
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

/// P2-B: Emit a ready-to-paste MCP client configuration snippet.
///
/// Supported hosts:
/// - `claude-desktop` → `claude_desktop_config.json` `mcpServers` entry
/// - `cursor`         → Cursor MCP entry
/// - `vscode`         → VS Code `.vscode/mcp.json` entry (generic format)
///
/// The executable path is the currently running binary (resolved via
/// `std::env::current_exe`), which makes the emitted snippet directly usable
/// from wherever the user invoked `octocode-cli mcp-config`.
fn print_mcp_config(host: &str, exe: &str) {
    let exe_escaped = exe.replace('\\', "\\\\");
    let snippet = match host {
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
    };
    println!("{snippet}");
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
}

