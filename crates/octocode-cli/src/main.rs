use octocode_api::StubProvider;
use octocode_core::{
    PermissionMode, PlatformKind, PromptRequest, ShellKind, ToolCall, WorkspaceContext,
};
use octocode_runtime::{EchoToolExecutor, MemorySessionStore, OctocodeRuntime};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = OctocodeRuntime::new(
        StubProvider,
        MemorySessionStore::new(),
        EchoToolExecutor,
        WorkspaceContext {
            root: String::from("."),
            platform: detect_platform(),
            preferred_shell: detect_shell(),
        },
    );

    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("prompt") => {
            let text = args.collect::<Vec<_>>().join(" ");
            let response = runtime.prompt(PromptRequest {
                text: if text.is_empty() {
                    String::from("hello octocode")
                } else {
                    text
                },
                model: None,
            })?;
            println!("{}", response.output);
        }
        Some("sessions") => {
            for session in runtime.sessions()? {
                println!("session {} {}", session.id, session.title);
            }
        }
        Some("tool") => {
            let name = args.next().unwrap_or_else(|| String::from("echo"));
            let input = args.collect::<Vec<_>>().join(" ");
            let result = runtime.run_tool(ToolCall {
                name,
                input,
                permission: PermissionMode::WorkspaceWrite,
            })?;
            println!("{}", result.output);
        }
        Some("workspace") => {
            let workspace = runtime.workspace();
            println!("root={} platform={:?} shell={:?}", workspace.root, workspace.platform, workspace.preferred_shell);
        }
        _ => {
            println!("octocode-cli commands:");
            println!("  prompt [text]");
            println!("  sessions");
            println!("  tool [name] [input]");
            println!("  workspace");
        }
    }

    Ok(())
}

fn detect_platform() -> PlatformKind {
    if cfg!(target_os = "windows") {
        PlatformKind::Windows
    } else if cfg!(target_os = "macos") {
        PlatformKind::MacOs
    } else {
        PlatformKind::Linux
    }
}

fn detect_shell() -> ShellKind {
    if cfg!(target_os = "windows") {
        ShellKind::PowerShell
    } else {
        ShellKind::Zsh
    }
}