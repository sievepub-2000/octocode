use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;

use octocode_core::OctoError;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::json;

#[cfg(not(target_os = "windows"))]
use std::path::Path;

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;
const MAX_BACKLOG_BYTES: usize = 256 * 1024;

static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);
static TERMINAL_HUB: OnceLock<TerminalHub> = OnceLock::new();

pub fn terminal_hub() -> &'static TerminalHub {
    TERMINAL_HUB.get_or_init(TerminalHub::new)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub shell: String,
    pub owner_session_id: String,
    pub cols: u16,
    pub rows: u16,
}

struct TerminalSession {
    info: TerminalSessionInfo,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send>>,
    subscribers: Mutex<Vec<mpsc::Sender<String>>>,
    backlog: Mutex<String>,
}

impl TerminalSession {
    fn push_output(&self, text: &str) {
        {
            let mut backlog = self.backlog.lock().unwrap();
            backlog.push_str(text);
            if backlog.len() > MAX_BACKLOG_BYTES {
                let trim_to = backlog.len() - MAX_BACKLOG_BYTES;
                backlog.drain(..trim_to);
            }
        }
        self.broadcast(json!({ "type": "output", "data": text }).to_string());
    }

    fn broadcast(&self, payload: String) {
        let mut subscribers = self.subscribers.lock().unwrap();
        subscribers.retain(|sender| sender.send(payload.clone()).is_ok());
    }
}

pub struct TerminalHub {
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
}

impl TerminalHub {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn open_session(
        &self,
        workspace_root: &str,
        owner_session_id: &str,
        requested_cwd: Option<&str>,
        label: Option<&str>,
        requested_cols: Option<u16>,
        requested_rows: Option<u16>,
    ) -> Result<TerminalSessionInfo, OctoError> {
        let cwd = normalize_cwd(workspace_root, requested_cwd);
        let cols = requested_cols.unwrap_or(DEFAULT_COLS).max(40);
        let rows = requested_rows.unwrap_or(DEFAULT_ROWS).max(12);
        let pty_system = native_pty_system();
        let (shell_name, mut command) = build_shell_command();
        command.cwd(cwd.as_path());
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| OctoError::Runtime(format!("failed to open PTY: {error}")))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| OctoError::Runtime(format!("failed to clone PTY reader: {error}")))?;
        let writer = pair.master.take_writer().map_err(|error| {
            OctoError::Runtime(format!("failed to acquire PTY writer: {error}"))
        })?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| OctoError::Runtime(format!("failed to spawn terminal shell: {error}")))?;

        let terminal_number = NEXT_TERMINAL_ID.fetch_add(1, Ordering::Relaxed);
        let info = TerminalSessionInfo {
            id: format!("term-{terminal_number}"),
            label: label
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(String::from)
                .unwrap_or_else(|| format!("{shell_name} {terminal_number}")),
            cwd: cwd.display().to_string(),
            shell: shell_name,
            owner_session_id: owner_session_id.trim().to_string(),
            cols,
            rows,
        };
        let session = Arc::new(TerminalSession {
            info: info.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            subscribers: Mutex::new(Vec::new()),
            backlog: Mutex::new(String::new()),
        });

        spawn_reader(session.clone(), reader);
        self.sessions
            .lock()
            .unwrap()
            .insert(info.id.clone(), session);
        Ok(info)
    }

    pub fn subscribe(&self, terminal_id: &str) -> Option<mpsc::Receiver<String>> {
        let session = self.sessions.lock().unwrap().get(terminal_id).cloned()?;
        let (sender, receiver) = mpsc::channel();
        let backlog = session.backlog.lock().unwrap().clone();
        if !backlog.is_empty() {
            let _ = sender.send(json!({ "type": "snapshot", "data": backlog }).to_string());
        }
        session.subscribers.lock().unwrap().push(sender);
        Some(receiver)
    }

    pub fn write_input(&self, terminal_id: &str, input: &str) -> Result<(), OctoError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| OctoError::Runtime(format!("terminal session not found: {terminal_id}")))?;
        let mut writer = session.writer.lock().unwrap();
        writer
            .write_all(input.as_bytes())
            .map_err(|error| OctoError::Runtime(format!("failed to write terminal input: {error}")))?;
        writer
            .flush()
            .map_err(|error| OctoError::Runtime(format!("failed to flush terminal input: {error}")))
    }

    pub fn resize_session(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), OctoError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| OctoError::Runtime(format!("terminal session not found: {terminal_id}")))?;
        let master = session.master.lock().unwrap();
        master
            .resize(PtySize {
                rows: rows.max(12),
                cols: cols.max(40),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| OctoError::Runtime(format!("failed to resize terminal: {error}")))
    }

    pub fn close_session(&self, terminal_id: &str) {
        let session = self.sessions.lock().unwrap().remove(terminal_id);
        if let Some(session) = session {
            let _ = session.child.lock().unwrap().kill();
            session.broadcast(json!({ "type": "exit", "data": "\r\n[terminal closed]\r\n" }).to_string());
        }
    }

    pub fn session_info(&self, terminal_id: &str) -> Option<TerminalSessionInfo> {
        self.sessions
            .lock()
            .unwrap()
            .get(terminal_id)
            .map(|session| session.info.clone())
    }
}

fn spawn_reader(session: Arc<TerminalSession>, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    session.broadcast(json!({ "type": "exit", "data": "\r\n[process exited]\r\n" }).to_string());
                    break;
                }
                Ok(read) => {
                    let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                    session.push_output(&text);
                }
                Err(error) => {
                    session.broadcast(
                        json!({
                            "type": "error",
                            "data": format!("\r\n[terminal read error] {error}\r\n")
                        })
                        .to_string(),
                    );
                    break;
                }
            }
        }
    });
}

fn build_shell_command() -> (String, CommandBuilder) {
    #[cfg(target_os = "windows")]
    {
        let program = std::env::var("OCTOCODE_PTY_SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| String::from("powershell.exe"));
        let mut builder = CommandBuilder::new(program);
        builder.arg("-NoLogo");
        builder.arg("-NoExit");
        builder.arg("-NoProfile");
        builder.arg("-Command");
        builder.arg("$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $host.UI.RawUI.WindowTitle = 'Octocode Terminal'; function global:prompt { 'PS ' + (Get-Location) + '> ' }; if (Get-Module -ListAvailable -Name PSReadLine) { Import-Module PSReadLine -ErrorAction SilentlyContinue; Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue; Set-PSReadLineOption -Colors @{ Command = 'Gray'; ContinuationPrompt = 'DarkGray'; Default = 'Gray'; Emphasis = 'Gray'; Error = 'Red'; Keyword = 'Gray'; Member = 'Gray'; Number = 'Gray'; Operator = 'Gray'; Parameter = 'Gray'; Selection = 'DarkCyan'; String = 'Gray'; Type = 'Gray'; Variable = 'Gray' } -ErrorAction SilentlyContinue }");
        (String::from("PowerShell"), builder)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let program = std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| String::from("/bin/bash"));
        let label = Path::new(&program)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Shell")
            .to_string();
        let mut builder = CommandBuilder::new(program);
        builder.arg("-i");
        (label, builder)
    }
}

fn normalize_cwd(workspace_root: &str, requested_cwd: Option<&str>) -> PathBuf {
    let root = PathBuf::from(workspace_root);
    let candidate = requested_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|value| {
            if value.components().all(|component| matches!(component, Component::CurDir)) {
                root.clone()
            } else if value.is_absolute() {
                value
            } else {
                root.join(value)
            }
        })
        .unwrap_or_else(|| root.clone());
    if candidate.is_dir() {
        collapse_cwd(candidate)
    } else {
        collapse_cwd(root)
    }
}

fn collapse_cwd(path: PathBuf) -> PathBuf {
    let collapsed: PathBuf = path
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect();
    if collapsed.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        collapsed
    }
}