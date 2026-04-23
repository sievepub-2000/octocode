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
