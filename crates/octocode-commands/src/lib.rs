use octocode_core::{
    CommandDescriptor, ConversationSession, ConversationStore, DoctorReport, ModelProvider,
    OctoError, OutputMode, PermissionMode, PromptResponse, ProviderDescriptor, RuntimeStatus,
    SessionSummary, ToolDescriptor, ToolExecutor, ToolResult, UiSnapshot, WorkspaceContext,
};
use octocode_runtime::OctocodeRuntime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliCommand {
    Prompt { text: String },
    Chat { session_id: String, text: String },
    Sessions,
    SessionShow { id: String },
    SessionAdd { id: String, title: String },
    SessionExport { path: String },
    Tool { name: String, input: String },
    Tools,
    Workspace,
    Providers,
    Doctor,
    Status,
    Permissions { mode: Option<String> },
    ConfigInit,
    ConfigShow,
    UiExport { path: String, session_id: Option<String> },
    Commands,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCli {
    pub output_mode: OutputMode,
    pub command: CliCommand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandResponse {
    Prompt(PromptResponse),
    Sessions(Vec<SessionSummary>),
    Session(ConversationSession),
    Tool(ToolResult),
    Tools(Vec<ToolDescriptor>),
    Workspace(WorkspaceContext),
    Providers(Vec<ProviderDescriptor>),
    Doctor(DoctorReport),
    Status(RuntimeStatus),
    Permission(PermissionMode),
    ConfigInit(String),
    ConfigShow { path: String, content: String },
    Commands(Vec<CommandDescriptor>),
    UiExport(String),
    Help(Vec<CommandDescriptor>),
    Acknowledged(String),
    Snapshot(UiSnapshot),
}

pub fn parse_cli_args<I>(args: I) -> ParsedCli
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter().collect::<Vec<_>>();
    let output_mode = if args.first().map(String::as_str) == Some("--json") {
        args.remove(0);
        OutputMode::Json
    } else {
        OutputMode::Text
    };

    let mut args = args.into_iter();
    let command = match args.next().as_deref() {
        Some("prompt") => CliCommand::Prompt {
            text: args.collect::<Vec<_>>().join(" "),
        },
        Some("chat") => {
            let session_id = args.next().unwrap_or_else(|| String::from("demo"));
            let text = args.collect::<Vec<_>>().join(" ");
            CliCommand::Chat { session_id, text }
        }
        Some("sessions") => CliCommand::Sessions,
        Some("session-show") => CliCommand::SessionShow {
            id: args.next().unwrap_or_else(|| String::from("demo")),
        },
        Some("session-add") => {
            let id = args.next().unwrap_or_else(|| String::from("session"));
            let title = args.collect::<Vec<_>>().join(" ");
            CliCommand::SessionAdd { id, title }
        }
        Some("session-export") => CliCommand::SessionExport {
            path: args.next().unwrap_or_else(|| String::from("sessions-export.txt")),
        },
        Some("tool") => CliCommand::Tool {
            name: args.next().unwrap_or_else(|| String::from("echo")),
            input: args.collect::<Vec<_>>().join(" "),
        },
        Some("tools") => CliCommand::Tools,
        Some("workspace") => CliCommand::Workspace,
        Some("providers") => CliCommand::Providers,
        Some("doctor") => CliCommand::Doctor,
        Some("status") => CliCommand::Status,
        Some("permissions") => CliCommand::Permissions { mode: args.next() },
        Some("config-init") => CliCommand::ConfigInit,
        Some("config-show") => CliCommand::ConfigShow,
        Some("ui-export") => {
            let path = args
                .next()
                .unwrap_or_else(|| String::from("ui-shell/data/app-state.json"));
            let session_id = args.next();
            CliCommand::UiExport { path, session_id }
        }
        Some("commands") => CliCommand::Commands,
        _ => CliCommand::Help,
    };

    ParsedCli { output_mode, command }
}

pub fn execute_command<P, S, T>(
    runtime: &mut OctocodeRuntime<P, S, T>,
    command: CliCommand,
) -> Result<CommandResponse, OctoError>
where
    P: ModelProvider,
    S: ConversationStore,
    T: ToolExecutor,
{
    match command {
        CliCommand::Prompt { text } => Ok(CommandResponse::Prompt(runtime.prompt(
            octocode_core::PromptRequest {
                text: if text.is_empty() {
                    String::from("hello octocode")
                } else {
                    text
                },
                model: runtime.config().default_model.clone(),
            },
        )?)),
        CliCommand::Chat { session_id, text } => {
            runtime.prompt_in_session(&session_id, &text)?;
            Ok(CommandResponse::Session(runtime.session(&session_id)?))
        }
        CliCommand::Sessions => Ok(CommandResponse::Sessions(runtime.sessions()?)),
        CliCommand::SessionShow { id } => Ok(CommandResponse::Session(runtime.session(&id)?)),
        CliCommand::SessionAdd { id, title } => {
            runtime.save_session(SessionSummary {
                id,
                title: if title.is_empty() {
                    String::from("Octocode Session")
                } else {
                    title
                },
                model: runtime.config().default_model.clone(),
            })?;
            Ok(CommandResponse::Acknowledged(String::from("session saved")))
        }
        CliCommand::SessionExport { path } => Ok(CommandResponse::Acknowledged(
            runtime.export_sessions(path)?.display().to_string(),
        )),
        CliCommand::Tool { name, input } => Ok(CommandResponse::Tool(runtime.run_tool(
            octocode_core::ToolCall {
                name,
                input,
                permission: PermissionMode::ReadOnly,
            },
        )?)),
        CliCommand::Tools => Ok(CommandResponse::Tools(runtime.tools().to_vec())),
        CliCommand::Workspace => Ok(CommandResponse::Workspace(runtime.workspace().clone())),
        CliCommand::Providers => Ok(CommandResponse::Providers(runtime.providers().to_vec())),
        CliCommand::Doctor => Ok(CommandResponse::Doctor(runtime.doctor())),
        CliCommand::Status => Ok(CommandResponse::Status(runtime.status()?)),
        CliCommand::Permissions { mode } => {
            if let Some(mode) = mode {
                let parsed = match mode.as_str() {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => PermissionMode::DangerFullAccess,
                    _ => PermissionMode::WorkspaceWrite,
                };
                runtime.set_permission_mode(parsed);
            }
            Ok(CommandResponse::Permission(runtime.config().permission_mode.clone()))
        }
        CliCommand::ConfigInit => Ok(CommandResponse::ConfigInit(
            runtime.init_config()?.display().to_string(),
        )),
        CliCommand::ConfigShow => {
            let path = runtime.config_file_path();
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            Ok(CommandResponse::ConfigShow {
                path: path.display().to_string(),
                content,
            })
        }
        CliCommand::UiExport { path, session_id } => Ok(CommandResponse::UiExport(
            runtime
                .export_ui_state(path, session_id.as_deref())?
                .display()
                .to_string(),
        )),
        CliCommand::Commands => Ok(CommandResponse::Commands(runtime.commands().to_vec())),
        CliCommand::Help => Ok(CommandResponse::Help(runtime.commands().to_vec())),
    }
}

pub fn render_text(response: &CommandResponse) -> String {
    match response {
        CommandResponse::Prompt(response) => response.output.clone(),
        CommandResponse::Sessions(sessions) => sessions
            .iter()
            .map(|session| format!("session {} {}", session.id, session.title))
            .collect::<Vec<_>>()
            .join("\n"),
        CommandResponse::Session(session) => {
            let mut lines = vec![format!(
                "session {} {}",
                session.summary.id, session.summary.title
            )];
            lines.extend(
                session
                    .messages
                    .iter()
                    .map(|message| format!("{}: {}", message.role.as_str(), message.content)),
            );
            lines.join("\n")
        }
        CommandResponse::Tool(result) => result.output.clone(),
        CommandResponse::Tools(tools) => tools
            .iter()
            .map(|tool| format!("{} - {} ({:?})", tool.name, tool.summary, tool.minimum_permission))
            .collect::<Vec<_>>()
            .join("\n"),
        CommandResponse::Workspace(workspace) => format!(
            "root={} platform={:?} shell={:?}",
            workspace.root, workspace.platform, workspace.preferred_shell
        ),
        CommandResponse::Providers(providers) => providers
            .iter()
            .map(|provider| {
                format!(
                    "{} kind={:?} tools={} streaming={}",
                    provider.id, provider.kind, provider.supports_tools, provider.supports_streaming
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        CommandResponse::Doctor(report) => vec![
            String::from("Octocode Doctor"),
            format!("workspace.root={}", report.workspace.root),
            format!("workspace.platform={:?}", report.workspace.platform),
            format!("workspace.shell={:?}", report.workspace.preferred_shell),
            format!("config.home={}", report.paths.config_home),
            format!("cache.home={}", report.paths.cache_home),
            format!("data.home={}", report.paths.data_home),
            format!(
                "provider.id={}",
                report.config.provider_id.as_deref().unwrap_or("<auto>")
            ),
            format!(
                "default.model={}",
                report.config.default_model.as_deref().unwrap_or("<none>")
            ),
            format!("permission.mode={:?}", report.config.permission_mode),
        ]
        .join("\n"),
        CommandResponse::Status(status) => vec![
            String::from("Octocode Status"),
            format!("provider.id={}", status.provider_id),
            format!("provider.kind={:?}", status.provider_kind),
            format!("workspace.platform={:?}", status.platform),
            format!("permission.mode={:?}", status.permission_mode),
            format!("sessions.count={}", status.session_count),
        ]
        .join("\n"),
        CommandResponse::Permission(mode) => format!("{:?}", mode),
        CommandResponse::ConfigInit(path) => path.clone(),
        CommandResponse::ConfigShow { path, content } => format!("{}\n{}", path, content),
        CommandResponse::Commands(commands) | CommandResponse::Help(commands) => commands
            .iter()
            .map(|command| format!("{} - {}", command.name, command.summary))
            .collect::<Vec<_>>()
            .join("\n"),
        CommandResponse::UiExport(path) | CommandResponse::Acknowledged(path) => path.clone(),
        CommandResponse::Snapshot(snapshot) => snapshot.status.provider_id.clone(),
    }
}

pub fn render_json(response: &CommandResponse) -> String {
    match response {
        CommandResponse::Prompt(response) => {
            format!("{{\"kind\":\"prompt\",\"output\":\"{}\"}}", escape_json(&response.output))
        }
        CommandResponse::Sessions(sessions) => format!(
            "{{\"kind\":\"sessions\",\"items\":[{}]}}",
            sessions
                .iter()
                .map(|session| format!(
                    "{{\"id\":\"{}\",\"title\":\"{}\",\"model\":\"{}\"}}",
                    escape_json(&session.id),
                    escape_json(&session.title),
                    escape_json(session.model.as_deref().unwrap_or(""))
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::Session(session) => format!(
            "{{\"kind\":\"session\",\"summary\":{{\"id\":\"{}\",\"title\":\"{}\",\"model\":\"{}\"}},\"messages\":[{}]}}",
            escape_json(&session.summary.id),
            escape_json(&session.summary.title),
            escape_json(session.summary.model.as_deref().unwrap_or("")),
            session
                .messages
                .iter()
                .map(|message| format!(
                    "{{\"role\":\"{}\",\"content\":\"{}\"}}",
                    message.role.as_str(),
                    escape_json(&message.content)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::Tool(result) => {
            format!("{{\"kind\":\"tool\",\"output\":\"{}\"}}", escape_json(&result.output))
        }
        CommandResponse::Tools(tools) => format!(
            "{{\"kind\":\"tools\",\"items\":[{}]}}",
            tools
                .iter()
                .map(|tool| format!(
                    "{{\"name\":\"{}\",\"summary\":\"{}\",\"minimumPermission\":\"{:?}\"}}",
                    escape_json(tool.name),
                    escape_json(tool.summary),
                    tool.minimum_permission
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::Workspace(workspace) => format!(
            "{{\"kind\":\"workspace\",\"root\":\"{}\",\"platform\":\"{:?}\",\"shell\":\"{:?}\"}}",
            escape_json(&workspace.root),
            workspace.platform,
            workspace.preferred_shell
        ),
        CommandResponse::Providers(providers) => format!(
            "{{\"kind\":\"providers\",\"items\":[{}]}}",
            providers
                .iter()
                .map(|provider| format!(
                    "{{\"id\":\"{}\",\"displayName\":\"{}\",\"kind\":\"{:?}\",\"supportsTools\":{},\"supportsStreaming\":{}}}",
                    escape_json(&provider.id),
                    escape_json(&provider.display_name),
                    provider.kind,
                    provider.supports_tools,
                    provider.supports_streaming
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::Doctor(report) => format!(
            "{{\"kind\":\"doctor\",\"workspaceRoot\":\"{}\",\"platform\":\"{:?}\",\"shell\":\"{:?}\",\"configHome\":\"{}\",\"cacheHome\":\"{}\",\"dataHome\":\"{}\",\"providerId\":\"{}\",\"defaultModel\":\"{}\",\"permissionMode\":\"{:?}\"}}",
            escape_json(&report.workspace.root),
            report.workspace.platform,
            report.workspace.preferred_shell,
            escape_json(&report.paths.config_home),
            escape_json(&report.paths.cache_home),
            escape_json(&report.paths.data_home),
            escape_json(report.config.provider_id.as_deref().unwrap_or("")),
            escape_json(report.config.default_model.as_deref().unwrap_or("")),
            report.config.permission_mode
        ),
        CommandResponse::Status(status) => format!(
            "{{\"kind\":\"status\",\"providerId\":\"{}\",\"providerKind\":\"{:?}\",\"platform\":\"{:?}\",\"permissionMode\":\"{:?}\",\"sessionCount\":{}}}",
            escape_json(&status.provider_id),
            status.provider_kind,
            status.platform,
            status.permission_mode,
            status.session_count
        ),
        CommandResponse::Permission(mode) => {
            format!("{{\"kind\":\"permissions\",\"mode\":\"{:?}\"}}", mode)
        }
        CommandResponse::ConfigInit(path) => {
            format!("{{\"kind\":\"config-init\",\"path\":\"{}\"}}", escape_json(path))
        }
        CommandResponse::ConfigShow { path, content } => format!(
            "{{\"kind\":\"config-show\",\"path\":\"{}\",\"content\":\"{}\"}}",
            escape_json(path),
            escape_json(content)
        ),
        CommandResponse::Commands(commands) | CommandResponse::Help(commands) => format!(
            "{{\"kind\":\"commands\",\"items\":[{}]}}",
            commands
                .iter()
                .map(|command| format!(
                    "{{\"name\":\"{}\",\"summary\":\"{}\"}}",
                    escape_json(command.name),
                    escape_json(command.summary)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::UiExport(path) | CommandResponse::Acknowledged(path) => {
            format!("{{\"kind\":\"ack\",\"value\":\"{}\"}}", escape_json(path))
        }
        CommandResponse::Snapshot(snapshot) => format!(
            "{{\"kind\":\"snapshot\",\"providerId\":\"{}\",\"sessionCount\":{}}}",
            escape_json(&snapshot.status.provider_id),
            snapshot.status.session_count
        ),
    }
}

fn escape_json(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

#[cfg(test)]
mod tests {
    use super::{parse_cli_args, CliCommand, ParsedCli};
    use octocode_core::OutputMode;

    #[test]
    fn parses_json_status_command() {
        let parsed = parse_cli_args(vec![String::from("--json"), String::from("status")]);
        assert_eq!(
            parsed,
            ParsedCli {
                output_mode: OutputMode::Json,
                command: CliCommand::Status,
            }
        );
    }

    #[test]
    fn parses_chat_command() {
        let parsed = parse_cli_args(vec![
            String::from("chat"),
            String::from("demo"),
            String::from("hello"),
            String::from("octocode"),
        ]);
        assert_eq!(
            parsed,
            ParsedCli {
                output_mode: OutputMode::Text,
                command: CliCommand::Chat {
                    session_id: String::from("demo"),
                    text: String::from("hello octocode"),
                },
            }
        );
    }
}
