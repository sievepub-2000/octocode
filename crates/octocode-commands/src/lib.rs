use octocode_core::OutputMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliCommand {
    Prompt { text: String },
    Sessions,
    SessionAdd { id: String, title: String },
    SessionExport { path: String },
    Tool { name: String, input: String },
    Workspace,
    Providers,
    Doctor,
    Status,
    Permissions { mode: Option<String> },
    ConfigInit,
    ConfigShow,
    Commands,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCli {
    pub output_mode: OutputMode,
    pub command: CliCommand,
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
        Some("sessions") => CliCommand::Sessions,
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
        Some("workspace") => CliCommand::Workspace,
        Some("providers") => CliCommand::Providers,
        Some("doctor") => CliCommand::Doctor,
        Some("status") => CliCommand::Status,
        Some("permissions") => CliCommand::Permissions { mode: args.next() },
        Some("config-init") => CliCommand::ConfigInit,
        Some("config-show") => CliCommand::ConfigShow,
        Some("commands") => CliCommand::Commands,
        _ => CliCommand::Help,
    };

    ParsedCli { output_mode, command }
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
    fn parses_session_export_command() {
        let parsed = parse_cli_args(vec![
            String::from("session-export"),
            String::from("out/sessions.txt"),
        ]);
        assert_eq!(
            parsed,
            ParsedCli {
                output_mode: OutputMode::Text,
                command: CliCommand::SessionExport {
                    path: String::from("out/sessions.txt"),
                },
            }
        );
    }
}