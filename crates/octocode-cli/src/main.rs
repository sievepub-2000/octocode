use octocode_api::{ProviderRegistry, StubProvider};
use octocode_core::{
    PermissionMode, PlatformSupport, PromptRequest, SessionSummary, ToolCall,
};
use octocode_runtime::{FileSessionStore, NativePlatform, OctocodeRuntime, WorkspaceToolExecutor};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let platform = NativePlatform::detect(String::from("."));
    let store = FileSessionStore::new(&platform.config_paths())?;
    let runtime = OctocodeRuntime::new(
        StubProvider,
        store,
        WorkspaceToolExecutor::new(platform.context().root.clone()),
        platform.context().clone(),
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
        Some("session-add") => {
            let id = args.next().unwrap_or_else(|| String::from("session"));
            let title = args.collect::<Vec<_>>().join(" ");
            runtime.save_session(SessionSummary {
                id,
                title: if title.is_empty() {
                    String::from("Octocode Session")
                } else {
                    title
                },
                model: Some(String::from("stub")),
            })?;
            println!("session saved");
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
        Some("providers") => {
            let registry = ProviderRegistry::new();
            for provider in registry.all() {
                println!(
                    "{} kind={:?} tools={} streaming={}",
                    provider.id, provider.kind, provider.supports_tools, provider.supports_streaming
                );
            }
        }
        Some("doctor") => {
            let workspace = runtime.workspace();
            let paths = runtime.config_paths();
            println!("Octocode Doctor");
            println!("workspace.root={}", workspace.root);
            println!("workspace.platform={:?}", workspace.platform);
            println!("workspace.shell={:?}", workspace.preferred_shell);
            println!("config.home={}", paths.config_home);
            println!("cache.home={}", paths.cache_home);
            println!("data.home={}", paths.data_home);
        }
        _ => {
            println!("octocode-cli commands:");
            println!("  prompt [text]");
            println!("  sessions");
            println!("  session-add [id] [title]");
            println!("  tool [name] [input]");
            println!("  workspace");
            println!("  providers");
            println!("  doctor");
        }
    }

    Ok(())
}
