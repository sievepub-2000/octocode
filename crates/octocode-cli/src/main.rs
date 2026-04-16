use octocode_api::{ProviderRegistry, StubProvider};
use octocode_commands::{parse_cli_args, CliCommand};
use octocode_core::{
    OutputMode, PermissionMode, PlatformSupport, PromptRequest, SessionSummary, ToolCall,
};
use octocode_runtime::{FileSessionStore, NativePlatform, OctocodeRuntime, WorkspaceToolExecutor};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let platform = NativePlatform::detect(String::from("."));
    let store = FileSessionStore::new(&platform.config_paths())?;
    let mut runtime = OctocodeRuntime::new(
        StubProvider,
        store,
        WorkspaceToolExecutor::new(platform.context().root.clone()),
        platform.context().clone(),
    );

    let parsed = parse_cli_args(std::env::args().skip(1));
    let json_mode = parsed.output_mode == OutputMode::Json;

    match parsed.command {
        CliCommand::Prompt { text } => {
            let response = runtime.prompt(PromptRequest {
                text: if text.is_empty() {
                    String::from("hello octocode")
                } else {
                    text
                },
                model: None,
            })?;
            if json_mode {
                println!("{{\"kind\":\"prompt\",\"output\":\"{}\"}}", json_escape(&response.output));
            } else {
                println!("{}", response.output);
            }
        }
        CliCommand::Sessions => {
            let sessions = runtime.sessions()?;
            if json_mode {
                let items = sessions
                    .iter()
                    .map(|session| {
                        format!(
                            "{{\"id\":\"{}\",\"title\":\"{}\",\"model\":\"{}\"}}",
                            json_escape(&session.id),
                            json_escape(&session.title),
                            json_escape(session.model.as_deref().unwrap_or(""))
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                println!("{{\"kind\":\"sessions\",\"items\":[{}]}}", items);
            } else {
                for session in sessions {
                    println!("session {} {}", session.id, session.title);
                }
            }
        }
        CliCommand::SessionAdd { id, title } => {
            runtime.save_session(SessionSummary {
                id,
                title: if title.is_empty() {
                    String::from("Octocode Session")
                } else {
                    title
                },
                model: Some(String::from("stub")),
            })?;
            if json_mode {
                println!("{{\"kind\":\"session-add\",\"saved\":true}}")
            } else {
                println!("session saved");
            }
        }
        CliCommand::SessionExport { path } => {
            let exported = runtime.export_sessions(path)?;
            if json_mode {
                println!("{{\"kind\":\"session-export\",\"path\":\"{}\"}}", json_escape(&exported.display().to_string()));
            } else {
                println!("{}", exported.display());
            }
        }
        CliCommand::Tool { name, input } => {
            let result = runtime.run_tool(ToolCall {
                name,
                input,
                permission: PermissionMode::WorkspaceWrite,
            })?;
            if json_mode {
                println!("{{\"kind\":\"tool\",\"output\":\"{}\"}}", json_escape(&result.output));
            } else {
                println!("{}", result.output);
            }
        }
        CliCommand::Workspace => {
            let workspace = runtime.workspace();
            if json_mode {
                println!(
                    "{{\"kind\":\"workspace\",\"root\":\"{}\",\"platform\":\"{:?}\",\"shell\":\"{:?}\"}}",
                    json_escape(&workspace.root), workspace.platform, workspace.preferred_shell
                );
            } else {
                println!("root={} platform={:?} shell={:?}", workspace.root, workspace.platform, workspace.preferred_shell);
            }
        }
        CliCommand::Providers => {
            let registry = ProviderRegistry::new();
            if json_mode {
                let items = registry
                    .all()
                    .iter()
                    .map(|provider| {
                        format!(
                            "{{\"id\":\"{}\",\"kind\":\"{:?}\",\"supportsTools\":{},\"supportsStreaming\":{}}}",
                            json_escape(&provider.id),
                            provider.kind,
                            provider.supports_tools,
                            provider.supports_streaming
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                println!("{{\"kind\":\"providers\",\"items\":[{}]}}", items);
            } else {
                for provider in registry.all() {
                    println!(
                        "{} kind={:?} tools={} streaming={}",
                        provider.id, provider.kind, provider.supports_tools, provider.supports_streaming
                    );
                }
            }
        }
        CliCommand::Doctor => {
            let workspace = runtime.workspace();
            let paths = runtime.config_paths();
            let config = runtime.config();
            if json_mode {
                println!(
                    "{{\"kind\":\"doctor\",\"workspaceRoot\":\"{}\",\"platform\":\"{:?}\",\"shell\":\"{:?}\",\"configHome\":\"{}\",\"cacheHome\":\"{}\",\"dataHome\":\"{}\",\"defaultModel\":\"{}\",\"permissionMode\":\"{:?}\"}}",
                    json_escape(&workspace.root),
                    workspace.platform,
                    workspace.preferred_shell,
                    json_escape(&paths.config_home),
                    json_escape(&paths.cache_home),
                    json_escape(&paths.data_home),
                    json_escape(config.default_model.as_deref().unwrap_or("")),
                    config.permission_mode
                );
            } else {
                println!("Octocode Doctor");
                println!("workspace.root={}", workspace.root);
                println!("workspace.platform={:?}", workspace.platform);
                println!("workspace.shell={:?}", workspace.preferred_shell);
                println!("config.home={}", paths.config_home);
                println!("cache.home={}", paths.cache_home);
                println!("data.home={}", paths.data_home);
                println!("default.model={}", config.default_model.as_deref().unwrap_or("<none>"));
                println!("permission.mode={:?}", config.permission_mode);
            }
        }
        CliCommand::Status => {
            let status = runtime.status()?;
            if json_mode {
                println!(
                    "{{\"kind\":\"status\",\"providerId\":\"{}\",\"providerKind\":\"{:?}\",\"platform\":\"{:?}\",\"permissionMode\":\"{:?}\",\"sessionCount\":{}}}",
                    json_escape(&status.provider_id),
                    status.provider_kind,
                    status.platform,
                    status.permission_mode,
                    status.session_count
                );
            } else {
                println!("Octocode Status");
                println!("provider.id={}", status.provider_id);
                println!("provider.kind={:?}", status.provider_kind);
                println!("workspace.platform={:?}", status.platform);
                println!("permission.mode={:?}", status.permission_mode);
                println!("sessions.count={}", status.session_count);
            }
        }
        CliCommand::Permissions { mode } => {
            if let Some(mode) = mode {
                let parsed = match mode.as_str() {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => PermissionMode::DangerFullAccess,
                    _ => PermissionMode::WorkspaceWrite,
                };
                runtime.set_permission_mode(parsed);
            }
            if json_mode {
                println!("{{\"kind\":\"permissions\",\"mode\":\"{:?}\"}}", runtime.config().permission_mode);
            } else {
                println!("{:?}", runtime.config().permission_mode);
            }
        }
        CliCommand::ConfigInit => {
            let path = runtime.init_config()?;
            if json_mode {
                println!("{{\"kind\":\"config-init\",\"path\":\"{}\"}}", json_escape(&path.display().to_string()));
            } else {
                println!("{}", path.display());
            }
        }
        CliCommand::ConfigShow => {
            let path = runtime.config_file_path();
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            if json_mode {
                println!("{{\"kind\":\"config-show\",\"path\":\"{}\",\"content\":\"{}\"}}", json_escape(&path.display().to_string()), json_escape(&raw));
            } else {
                println!("{}", path.display());
                print!("{}", raw);
            }
        }
        CliCommand::Commands => {
            if json_mode {
                let items = runtime
                    .commands()
                    .iter()
                    .map(|command| {
                        format!(
                            "{{\"name\":\"{}\",\"summary\":\"{}\"}}",
                            json_escape(command.name),
                            json_escape(command.summary)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                println!("{{\"kind\":\"commands\",\"items\":[{}]}}", items);
            } else {
                for command in runtime.commands() {
                    println!("{} - {}", command.name, command.summary);
                }
            }
        }
        CliCommand::Help => {
            if json_mode {
                println!("{{\"kind\":\"help\",\"usage\":\"octocode-cli [--json] <command>\"}}");
            } else {
                println!("octocode-cli commands:");
                for command in runtime.commands() {
                    println!("  {}", command.name);
                }
            }
        }
    }

    Ok(())
}

fn json_escape(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}
