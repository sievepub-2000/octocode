use octocode_core::{
    CommandDescriptor, ConversationRole, ConversationSession, ConversationStore, DoctorReport,
    ModelProvider, OctoError, OutputMode, PermissionMode, PromptResponse, ProviderCircuitStatus,
    ProviderDescriptor, ProviderHealth, ProviderRouteStatus, RuntimeEvent, RuntimeStatus, SessionSummary, ToolDescriptor,
    ToolExecutor, ToolResult, UiSnapshot, WorkspaceContext,
};
use octocode_runtime::OctocodeRuntime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliCommand {
    Prompt { text: String },
    Chat { session_id: String, text: String },
    Resume { id: Option<String> },
    Sessions,
    SessionShow { id: String },
    SessionAdd { id: String, title: String },
    SessionExport { path: String },
    Tool { name: String, input: String },
    Plan { session_id: String, text: String },
    Workflow { session_id: String, text: String },
    Agent { session_id: String, text: String },
    Repl { session_id: String, text: String },
    Tools,
    Workspace,
    Providers,
    Routes,
    CircuitLog,
    Health,
    Doctor,
    Status,
    Snapshot { session_id: Option<String> },
    Events { session_id: Option<String> },
    Permissions { mode: Option<String> },
    ConfigInit,
    ConfigShow,
    UiExport { path: String, session_id: Option<String> },
    Serve { port: u16, session_id: Option<String> },
    Desktop { port: u16, session_id: Option<String> },
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
    Routes(Vec<ProviderRouteStatus>),
    Circuits(Vec<ProviderCircuitStatus>),
    Health(Vec<ProviderHealth>),
    Doctor(DoctorReport),
    Status(RuntimeStatus),
    Events(Vec<RuntimeEvent>),
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
        Some("resume") => CliCommand::Resume { id: args.next() },
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
        Some("plan") => {
            let session_id = args.next().unwrap_or_else(|| String::from("demo"));
            let text = args.collect::<Vec<_>>().join(" ");
            CliCommand::Plan { session_id, text }
        }
        Some("workflow") => {
            let session_id = args.next().unwrap_or_else(|| String::from("demo"));
            let text = args.collect::<Vec<_>>().join(" ");
            CliCommand::Workflow { session_id, text }
        }
        Some("agent") => {
            let session_id = args.next().unwrap_or_else(|| String::from("demo"));
            let text = args.collect::<Vec<_>>().join(" ");
            CliCommand::Agent { session_id, text }
        }
        Some("repl") => {
            let session_id = args.next().unwrap_or_else(|| String::from("demo"));
            let text = args.collect::<Vec<_>>().join(" ");
            CliCommand::Repl { session_id, text }
        }
        Some("tools") => CliCommand::Tools,
        Some("workspace") => CliCommand::Workspace,
        Some("providers") => CliCommand::Providers,
        Some("routes") => CliCommand::Routes,
        Some("circuit-log") => CliCommand::CircuitLog,
        Some("health") => CliCommand::Health,
        Some("doctor") => CliCommand::Doctor,
        Some("status") => CliCommand::Status,
        Some("snapshot") => CliCommand::Snapshot { session_id: args.next() },
        Some("events") => CliCommand::Events { session_id: args.next() },
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
        Some("serve") => {
            let port = args
                .next()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(999);
            let session_id = args.next();
            CliCommand::Serve { port, session_id }
        }
        Some("desktop") => {
            let port = args
                .next()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(999);
            let session_id = args.next();
            CliCommand::Desktop { port, session_id }
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
        CliCommand::Resume { id } => Ok(CommandResponse::Session(runtime.resume_session(id.as_deref())?)),
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
        CliCommand::Plan { session_id, text } => {
            runtime.run_tool_in_session(
                &session_id,
                octocode_core::ToolCall {
                    name: String::from("workflow-plan"),
                    input: text,
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            Ok(CommandResponse::Session(runtime.session(&session_id)?))
        }
        CliCommand::Workflow { session_id, text } => {
            runtime.run_tool_in_session(
                &session_id,
                octocode_core::ToolCall {
                    name: String::from("workflow-plan"),
                    input: if text.trim().is_empty() {
                        String::from("workflow step")
                    } else {
                        text
                    },
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            Ok(CommandResponse::Session(runtime.session(&session_id)?))
        }
        CliCommand::Agent { session_id, text } => {
            runtime.agent_action_in_session(
                &session_id,
                if text.trim().is_empty() {
                    "continue current task"
                } else {
                    &text
                },
            )?;
            Ok(CommandResponse::Session(runtime.session(&session_id)?))
        }
        CliCommand::Repl { session_id, text } => {
            let nested = parse_cli_args(tokenize_command_line(&text)).command;
            let nested_response = execute_command(runtime, nested_repl_command(nested)?)?;
            runtime.append_session_message(
                &session_id,
                ConversationRole::Tool,
                format!("repl => {}", render_text(&nested_response)),
            )?;
            Ok(CommandResponse::Session(runtime.session(&session_id)?))
        }
        CliCommand::Tools => Ok(CommandResponse::Tools(runtime.tools().to_vec())),
        CliCommand::Workspace => Ok(CommandResponse::Workspace(runtime.workspace().clone())),
        CliCommand::Providers => Ok(CommandResponse::Providers(runtime.providers().to_vec())),
        CliCommand::Routes => Ok(CommandResponse::Routes(runtime.provider_routes())),
        CliCommand::CircuitLog => Ok(CommandResponse::Circuits(runtime.provider_circuits())),
        CliCommand::Health => Ok(CommandResponse::Health(runtime.provider_healths())),
        CliCommand::Doctor => Ok(CommandResponse::Doctor(runtime.doctor())),
        CliCommand::Status => Ok(CommandResponse::Status(runtime.status()?)),
        CliCommand::Snapshot { session_id } => Ok(CommandResponse::Snapshot(
            runtime.snapshot(session_id.as_deref())?,
        )),
        CliCommand::Events { session_id } => Ok(CommandResponse::Events(
            runtime.event_feed(session_id.as_deref())?,
        )),
        CliCommand::Permissions { mode } => {
            if let Some(mode) = mode {
                let parsed = match mode.as_str() {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => PermissionMode::DangerFullAccess,
                    _ => PermissionMode::WorkspaceWrite,
                };
                runtime.set_permission_mode(parsed);
                let _ = runtime.save_config();
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
        CliCommand::Serve { .. } => Ok(CommandResponse::Acknowledged(String::from("serve"))),
        CliCommand::Desktop { .. } => Ok(CommandResponse::Acknowledged(String::from("desktop"))),
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
                    "{} kind={:?} tools={} streaming={} json={} sessionMemory={}",
                    provider.id,
                    provider.kind,
                    provider.supports_tools,
                    provider.supports_streaming,
                    provider.capabilities.json_output,
                    provider.capabilities.session_memory
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        CommandResponse::Routes(routes) => routes
            .iter()
            .map(|route| {
                format!(
                    "{} primary={} active={} healthy={} state={:?} detail={}",
                    route.provider_id,
                    route.is_primary,
                    route.is_active,
                    route.healthy,
                    route.circuit_state,
                    route.detail
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        CommandResponse::Circuits(circuits) => circuits
            .iter()
            .map(|circuit| {
                let mut lines = vec![format!(
                    "{} state={:?} fails={} cooldown={} recent_failure={}",
                    circuit.provider_id,
                    circuit.circuit_state,
                    circuit.failure_count,
                    circuit
                        .cooldown_remaining_ms
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| String::from("-")),
                    circuit.recent_failure_reason.as_deref().unwrap_or("-")
                )];
                lines.extend(circuit.event_log.iter().map(|event| {
                    format!("  [{}] {:?} {}", event.at_ms, event.kind, event.detail)
                }));
                lines.join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        CommandResponse::Health(healths) => healths
            .iter()
            .map(|health| {
                format!(
                    "{} healthy={} model={} latency_ms={} detail={}",
                    health.provider_id,
                    health.healthy,
                    health.model.as_deref().unwrap_or("-"),
                    health
                        .latency_ms
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| String::from("-")),
                    health.detail
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
                "provider.base_url={}",
                report
                    .config
                    .provider_base_url
                    .as_deref()
                    .unwrap_or("<default>")
            ),
            format!(
                "default.model={}",
                report.config.default_model.as_deref().unwrap_or("<none>")
            ),
            format!("permission.mode={:?}", report.config.permission_mode),
            format!("history.limit={}", report.config.history_limit),
            format!("provider.health.count={}", report.provider_healths.len()),
            format!("provider.route.count={}", report.provider_routes.len()),
        ]
        .join("\n"),
        CommandResponse::Status(status) => vec![
            String::from("Octocode Status"),
            format!("provider.id={}", status.provider_id),
            format!("provider.active={}", status.active_provider_id),
            format!("provider.kind={:?}", status.provider_kind),
            format!("workspace.platform={:?}", status.platform),
            format!("permission.mode={:?}", status.permission_mode),
            format!("sessions.count={}", status.session_count),
            format!("provider.healthy={}", status.provider_health.healthy),
            format!("provider.routes={}", status.provider_routes.len()),
        ]
        .join("\n"),
        CommandResponse::Events(events) => events
            .iter()
            .map(|event| match event.at_ms {
                Some(at_ms) => format!("[{}] {} {}", event.scope, at_ms, event.message),
                None => format!("[{}] {}", event.scope, event.message),
            })
            .collect::<Vec<_>>()
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
        CommandResponse::Snapshot(snapshot) => {
            let mut lines = vec![
                String::from("Octocode Snapshot"),
                format!("provider.id={}", snapshot.status.provider_id),
                format!("provider.active={}", snapshot.status.active_provider_id),
                format!("provider.routes={}", snapshot.provider_routes.len()),
                format!("events.count={}", snapshot.event_feed.len()),
                format!("tools.count={}", snapshot.tools.len()),
                format!("sessions.count={}", snapshot.sessions.len()),
                format!("workspace.root={}", snapshot.workspace.root),
                format!("workspace.shell={:?}", snapshot.workspace.preferred_shell),
            ];
            if let Some(active_session) = &snapshot.active_session {
                lines.push(format!("active.session={}", active_session.summary.id));
                lines.push(format!("active.messages={}", active_session.messages.len()));
            } else {
                lines.push(String::from("active.session=<none>"));
            }
            lines.join("\n")
        }
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
                    concat!(
                        "{{",
                        "\"id\":\"{}\",",
                        "\"displayName\":\"{}\",",
                        "\"kind\":\"{:?}\",",
                        "\"supportsTools\":{},",
                        "\"supportsStreaming\":{},",
                        "\"capabilities\":{{",
                        "\"chat\":{},",
                        "\"streaming\":{},",
                        "\"toolCalls\":{},",
                        "\"sessionMemory\":{},",
                        "\"jsonOutput\":{}",
                        "}}",
                        "}}"
                    ),
                    escape_json(&provider.id),
                    escape_json(&provider.display_name),
                    provider.kind,
                    provider.supports_tools,
                    provider.supports_streaming,
                    provider.capabilities.chat,
                    provider.capabilities.streaming,
                    provider.capabilities.tool_calls,
                    provider.capabilities.session_memory,
                    provider.capabilities.json_output
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::Routes(routes) => format!(
            "{{\"kind\":\"routes\",\"items\":[{}]}}",
            routes
                .iter()
                .map(|route| format!(
                    concat!(
                        "{{",
                        "\"providerId\":\"{}\",",
                        "\"displayName\":\"{}\",",
                        "\"kind\":\"{:?}\",",
                        "\"healthy\":{},",
                        "\"circuitState\":\"{:?}\",",
                        "\"detail\":\"{}\",",
                        "\"latencyMs\":{},",
                        "\"isPrimary\":{},",
                        "\"isActive\":{}",
                        "}}"
                    ),
                    escape_json(&route.provider_id),
                    escape_json(&route.display_name),
                    route.kind,
                    route.healthy,
                    route.circuit_state,
                    escape_json(&route.detail),
                    route.latency_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                    route.is_primary,
                    route.is_active
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::Circuits(circuits) => format!(
            "{{\"kind\":\"circuits\",\"items\":[{}]}}",
            circuits
                .iter()
                .map(|circuit| format!(
                    concat!(
                        "{{",
                        "\"providerId\":\"{}\",",
                        "\"displayName\":\"{}\",",
                        "\"circuitState\":\"{:?}\",",
                        "\"failureCount\":{},",
                        "\"cooldownRemainingMs\":{},",
                        "\"recentFailureReason\":{},",
                        "\"lastOpenedAtMs\":{},",
                        "\"lastHalfOpenedAtMs\":{},",
                        "\"lastRecoveredAtMs\":{},",
                        "\"eventLog\":[{}]",
                        "}}"
                    ),
                    escape_json(&circuit.provider_id),
                    escape_json(&circuit.display_name),
                    circuit.circuit_state,
                    circuit.failure_count,
                    circuit.cooldown_remaining_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                    option_json_string(circuit.recent_failure_reason.as_deref()),
                    circuit.last_opened_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                    circuit.last_half_opened_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                    circuit.last_recovered_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                    circuit.event_log.iter().map(|event| format!(
                        "{{\"atMs\":{},\"kind\":\"{:?}\",\"detail\":\"{}\"}}",
                        event.at_ms,
                        event.kind,
                        escape_json(&event.detail)
                    )).collect::<Vec<_>>().join(",")
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::Health(healths) => format!(
            "{{\"kind\":\"health\",\"items\":[{}]}}",
            healths
                .iter()
                .map(|health| format!(
                    "{{\"providerId\":\"{}\",\"displayName\":\"{}\",\"healthy\":{},\"detail\":\"{}\",\"model\":\"{}\",\"latencyMs\":{}}}",
                    escape_json(&health.provider_id),
                    escape_json(&health.display_name),
                    health.healthy,
                    escape_json(&health.detail),
                    escape_json(health.model.as_deref().unwrap_or("")),
                    health.latency_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null"))
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        CommandResponse::Doctor(report) => format!(
            "{{\"kind\":\"doctor\",\"workspaceRoot\":\"{}\",\"platform\":\"{:?}\",\"shell\":\"{:?}\",\"configHome\":\"{}\",\"cacheHome\":\"{}\",\"dataHome\":\"{}\",\"providerId\":\"{}\",\"providerBaseUrl\":\"{}\",\"defaultModel\":\"{}\",\"permissionMode\":\"{:?}\",\"historyLimit\":{},\"providerHealthCount\":{} }}",
            escape_json(&report.workspace.root),
            report.workspace.platform,
            report.workspace.preferred_shell,
            escape_json(&report.paths.config_home),
            escape_json(&report.paths.cache_home),
            escape_json(&report.paths.data_home),
            escape_json(report.config.provider_id.as_deref().unwrap_or("")),
            escape_json(report.config.provider_base_url.as_deref().unwrap_or("")),
            escape_json(report.config.default_model.as_deref().unwrap_or("")),
            report.config.permission_mode,
            report.config.history_limit,
            report.provider_healths.len()
        ),
        CommandResponse::Status(status) => format!(
            "{{\"kind\":\"status\",\"providerId\":\"{}\",\"activeProviderId\":\"{}\",\"providerKind\":\"{:?}\",\"platform\":\"{:?}\",\"permissionMode\":\"{:?}\",\"sessionCount\":{},\"providerHealthy\":{}}}",
            escape_json(&status.provider_id),
            escape_json(&status.active_provider_id),
            status.provider_kind,
            status.platform,
            status.permission_mode,
            status.session_count,
            status.provider_health.healthy
        ),
        CommandResponse::Events(events) => format!(
            "{{\"kind\":\"events\",\"items\":[{}]}}",
            events
                .iter()
                .map(|event| format!(
                    "{{\"scope\":\"{}\",\"message\":\"{}\",\"atMs\":{}}}",
                    escape_json(&event.scope),
                    escape_json(&event.message),
                    event.at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null"))
                ))
                .collect::<Vec<_>>()
                .join(",")
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
        CommandResponse::Snapshot(snapshot) => render_snapshot_json(snapshot),
    }
}

fn render_snapshot_json(snapshot: &UiSnapshot) -> String {
    let providers = snapshot
        .providers
        .iter()
        .map(|provider| format!(
            concat!(
                "{{",
                "\"id\":\"{}\",",
                "\"displayName\":\"{}\",",
                "\"kind\":\"{:?}\",",
                "\"supportsTools\":{},",
                "\"supportsStreaming\":{},",
                "\"capabilities\":{{",
                "\"chat\":{},",
                "\"streaming\":{},",
                "\"toolCalls\":{},",
                "\"sessionMemory\":{},",
                "\"jsonOutput\":{}",
                "}}",
                "}}"
            ),
            escape_json(&provider.id),
            escape_json(&provider.display_name),
            provider.kind,
            provider.supports_tools,
            provider.supports_streaming,
            provider.capabilities.chat,
            provider.capabilities.streaming,
            provider.capabilities.tool_calls,
            provider.capabilities.session_memory,
            provider.capabilities.json_output
        ))
        .collect::<Vec<_>>()
        .join(",");
    let provider_healths = snapshot
        .provider_healths
        .iter()
        .map(|health| format!(
            concat!(
                "{{",
                "\"providerId\":\"{}\",",
                "\"displayName\":\"{}\",",
                "\"healthy\":{},",
                "\"detail\":\"{}\",",
                "\"model\":\"{}\",",
                "\"latencyMs\":{},",
                "\"circuitState\":\"{:?}\",",
                "\"failureCount\":{},",
                "\"cooldownRemainingMs\":{}",
                "}}"
            ),
            escape_json(&health.provider_id),
            escape_json(&health.display_name),
            health.healthy,
            escape_json(&health.detail),
            escape_json(health.model.as_deref().unwrap_or("")),
            health.latency_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
            health.circuit_state,
            health.failure_count,
            health.cooldown_remaining_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null"))
        ))
        .collect::<Vec<_>>()
        .join(",");
    let provider_routes = snapshot
        .provider_routes
        .iter()
        .map(|route| format!(
            concat!(
                "{{",
                "\"providerId\":\"{}\",",
                "\"displayName\":\"{}\",",
                "\"kind\":\"{:?}\",",
                "\"healthy\":{},",
                "\"circuitState\":\"{:?}\",",
                "\"detail\":\"{}\",",
                "\"latencyMs\":{},",
                "\"isPrimary\":{},",
                "\"isActive\":{}",
                "}}"
            ),
            escape_json(&route.provider_id),
            escape_json(&route.display_name),
            route.kind,
            route.healthy,
            route.circuit_state,
            escape_json(&route.detail),
            route.latency_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
            route.is_primary,
            route.is_active
        ))
        .collect::<Vec<_>>()
        .join(",");
    let provider_circuits = snapshot
        .provider_circuits
        .iter()
        .map(|circuit| format!(
            concat!(
                "{{",
                "\"providerId\":\"{}\",",
                "\"displayName\":\"{}\",",
                "\"circuitState\":\"{:?}\",",
                "\"failureCount\":{},",
                "\"cooldownRemainingMs\":{},",
                "\"recentFailureReason\":{},",
                "\"lastOpenedAtMs\":{},",
                "\"lastHalfOpenedAtMs\":{},",
                "\"lastRecoveredAtMs\":{},",
                "\"eventLog\":[{}]",
                "}}"
            ),
            escape_json(&circuit.provider_id),
            escape_json(&circuit.display_name),
            circuit.circuit_state,
            circuit.failure_count,
            circuit.cooldown_remaining_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
            option_json_string(circuit.recent_failure_reason.as_deref()),
            circuit.last_opened_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
            circuit.last_half_opened_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
            circuit.last_recovered_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
            circuit
                .event_log
                .iter()
                .map(|event| format!(
                    "{{\"atMs\":{},\"kind\":\"{:?}\",\"detail\":\"{}\"}}",
                    event.at_ms,
                    event.kind,
                    escape_json(&event.detail)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ))
        .collect::<Vec<_>>()
        .join(",");
    let commands = snapshot
        .commands
        .iter()
        .map(|command| format!(
            "{{\"name\":\"{}\",\"summary\":\"{}\"}}",
            escape_json(command.name),
            escape_json(command.summary)
        ))
        .collect::<Vec<_>>()
        .join(",");
    let tools = snapshot
        .tools
        .iter()
        .map(|tool| format!(
            "{{\"name\":\"{}\",\"summary\":\"{}\",\"minimumPermission\":\"{:?}\"}}",
            escape_json(tool.name),
            escape_json(tool.summary),
            tool.minimum_permission
        ))
        .collect::<Vec<_>>()
        .join(",");
    let sessions = snapshot
        .sessions
        .iter()
        .map(|session| format!(
            "{{\"id\":\"{}\",\"title\":\"{}\",\"model\":\"{}\"}}",
            escape_json(&session.id),
            escape_json(&session.title),
            escape_json(session.model.as_deref().unwrap_or(""))
        ))
        .collect::<Vec<_>>()
        .join(",");
    let active_session = snapshot.active_session.as_ref().map(|session| {
        format!(
            "{{\"summary\":{{\"id\":\"{}\",\"title\":\"{}\",\"model\":\"{}\"}},\"messages\":[{}]}}",
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
        )
    });
    let event_feed = snapshot
        .event_feed
        .iter()
        .map(|event| format!(
            "{{\"scope\":\"{}\",\"message\":\"{}\",\"atMs\":{}}}",
            escape_json(&event.scope),
            escape_json(&event.message),
            event.at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null"))
        ))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        concat!(
            "{{",
            "\"kind\":\"snapshot\",",
            "\"status\":{{",
            "\"providerId\":\"{}\",",
            "\"activeProviderId\":\"{}\",",
            "\"providerKind\":\"{:?}\",",
            "\"platform\":\"{:?}\",",
            "\"permissionMode\":\"{:?}\",",
            "\"sessionCount\":{},",
            "\"providerHealth\":{{",
            "\"providerId\":\"{}\",",
            "\"displayName\":\"{}\",",
            "\"healthy\":{},",
            "\"detail\":\"{}\",",
            "\"model\":\"{}\",",
            "\"latencyMs\":{},",
            "\"circuitState\":\"{:?}\",",
            "\"failureCount\":{},",
            "\"cooldownRemainingMs\":{}",
            "}},",
            "\"providerCircuit\":{},",
            "\"providerRoutes\":[{}]",
            "}},",
            "\"workspace\":{{\"root\":\"{}\",\"platform\":\"{:?}\",\"shell\":\"{:?}\"}},",
            "\"config\":{{\"providerId\":\"{}\",\"providerBaseUrl\":\"{}\",\"defaultModel\":\"{}\",\"permissionMode\":\"{:?}\",\"historyLimit\":{}}},",
            "\"providers\":[{}],",
            "\"providerHealths\":[{}],",
            "\"providerCircuits\":[{}],",
            "\"providerRoutes\":[{}],",
            "\"commands\":[{}],",
            "\"tools\":[{}],",
            "\"sessions\":[{}],",
            "\"eventFeed\":[{}],",
            "\"activeSession\":{}",
            "}}"
        ),
        escape_json(&snapshot.status.provider_id),
        escape_json(&snapshot.status.active_provider_id),
        snapshot.status.provider_kind,
        snapshot.status.platform,
        snapshot.status.permission_mode,
        snapshot.status.session_count,
        escape_json(&snapshot.status.provider_health.provider_id),
        escape_json(&snapshot.status.provider_health.display_name),
        snapshot.status.provider_health.healthy,
        escape_json(&snapshot.status.provider_health.detail),
        escape_json(snapshot.status.provider_health.model.as_deref().unwrap_or("")),
        snapshot.status.provider_health.latency_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
        snapshot.status.provider_health.circuit_state,
        snapshot.status.provider_health.failure_count,
        snapshot.status.provider_health.cooldown_remaining_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
        provider_circuits
            .split(',')
            .next()
            .filter(|_| !snapshot.status.provider_circuit.provider_id.is_empty())
            .map(|_| format!(
                concat!(
                    "{{",
                    "\"providerId\":\"{}\",",
                    "\"displayName\":\"{}\",",
                    "\"circuitState\":\"{:?}\",",
                    "\"failureCount\":{},",
                    "\"cooldownRemainingMs\":{},",
                    "\"recentFailureReason\":{},",
                    "\"lastOpenedAtMs\":{},",
                    "\"lastHalfOpenedAtMs\":{},",
                    "\"lastRecoveredAtMs\":{},",
                    "\"eventLog\":[{}]",
                    "}}"
                ),
                escape_json(&snapshot.status.provider_circuit.provider_id),
                escape_json(&snapshot.status.provider_circuit.display_name),
                snapshot.status.provider_circuit.circuit_state,
                snapshot.status.provider_circuit.failure_count,
                snapshot.status.provider_circuit.cooldown_remaining_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                option_json_string(snapshot.status.provider_circuit.recent_failure_reason.as_deref()),
                snapshot.status.provider_circuit.last_opened_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                snapshot.status.provider_circuit.last_half_opened_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                snapshot.status.provider_circuit.last_recovered_at_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
                snapshot.status.provider_circuit.event_log.iter().map(|event| format!(
                    "{{\"atMs\":{},\"kind\":\"{:?}\",\"detail\":\"{}\"}}",
                    event.at_ms,
                    event.kind,
                    escape_json(&event.detail)
                )).collect::<Vec<_>>().join(",")
            ))
            .unwrap_or_else(|| String::from("null")),
        provider_routes,
        escape_json(&snapshot.workspace.root),
        snapshot.workspace.platform,
        snapshot.workspace.preferred_shell,
        escape_json(snapshot.config.provider_id.as_deref().unwrap_or("")),
        escape_json(snapshot.config.provider_base_url.as_deref().unwrap_or("")),
        escape_json(snapshot.config.default_model.as_deref().unwrap_or("")),
        snapshot.config.permission_mode,
        snapshot.config.history_limit,
        providers,
        provider_healths,
        provider_circuits,
        snapshot.provider_routes.iter().map(|route| format!(
            concat!(
                "{{",
                "\"providerId\":\"{}\",",
                "\"displayName\":\"{}\",",
                "\"kind\":\"{:?}\",",
                "\"healthy\":{},",
                "\"circuitState\":\"{:?}\",",
                "\"detail\":\"{}\",",
                "\"latencyMs\":{},",
                "\"isPrimary\":{},",
                "\"isActive\":{}",
                "}}"
            ),
            escape_json(&route.provider_id),
            escape_json(&route.display_name),
            route.kind,
            route.healthy,
            route.circuit_state,
            escape_json(&route.detail),
            route.latency_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
            route.is_primary,
            route.is_active
        )).collect::<Vec<_>>().join(","),
        commands,
        tools,
        sessions,
        event_feed,
        active_session.unwrap_or_else(|| String::from("null"))
    )
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
    use super::{parse_cli_args, CliCommand};

    #[test]
    fn parses_json_output_flag() {
        let parsed = parse_cli_args(vec![
            String::from("--json"),
            String::from("status"),
        ]);
        assert!(matches!(parsed.command, CliCommand::Status));
    }

    #[test]
    fn parses_serve_command() {
        let parsed = parse_cli_args(vec![
            String::from("serve"),
            String::from("999"),
            String::from("demo"),
        ]);
        assert!(matches!(parsed.command, CliCommand::Serve { port: 999, .. }));
    }

    #[test]
    fn parses_desktop_command_with_default_port() {
        let parsed = parse_cli_args(vec![String::from("desktop")]);
        assert!(matches!(parsed.command, CliCommand::Desktop { port: 999, .. }));
    }

    #[test]
    fn parses_workflow_command() {
        let parsed = parse_cli_args(vec![
            String::from("workflow"),
            String::from("demo"),
            String::from("plan"),
            String::from("fallback"),
        ]);
        assert!(matches!(parsed.command, CliCommand::Workflow { session_id, .. } if session_id == "demo"));
    }
}

fn tokenize_command_line(input: &str) -> Vec<String> {
    input.split_whitespace().map(String::from).collect()
}

fn nested_repl_command(command: CliCommand) -> Result<CliCommand, OctoError> {
    match command {
        CliCommand::Status
        | CliCommand::Health
        | CliCommand::Providers
        | CliCommand::Routes
        | CliCommand::Snapshot { .. }
        | CliCommand::Events { .. }
        | CliCommand::Tools
        | CliCommand::Workspace
        | CliCommand::Commands
        | CliCommand::Doctor
        | CliCommand::CircuitLog
        | CliCommand::Sessions => Ok(command),
        _ => Err(OctoError::Runtime(String::from(
            "repl currently supports status/health/providers/routes/snapshot/events/tools/workspace/commands/doctor/circuit-log/sessions",
        ))),
    }
}

fn option_json_string(value: Option<&str>) -> String {
    value
        .map(|value| format!("\"{}\"", escape_json(value)))
        .unwrap_or_else(|| String::from("null"))
}
