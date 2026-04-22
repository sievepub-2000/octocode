//! Rich interactive terminal UI for Octocode.
//!
//! Provides:
//! - Colored output with semantic styling (success, error, info, dim)
//! - Progress spinners for long-running operations
//! - Status bars showing token counts and cost
//! - Interactive prompt with history support
//! - Markdown-aware rendering for AI responses

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossterm::{
    cursor, execute,
    style::{Attribute, Color, Print, SetAttribute, SetForegroundColor, ResetColor},
    terminal::{self, ClearType},
};

// ─── Color Palette ──────────────────────────────────────────────────────────────

/// Semantic colors for terminal output.
pub struct Theme {
    pub accent: Color,
    pub success: Color,
    pub error: Color,
    pub warning: Color,
    pub info: Color,
    pub dim: Color,
    pub user_prompt: Color,
    pub ai_response: Color,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            accent: Color::Magenta,
            success: Color::Green,
            error: Color::Red,
            warning: Color::Yellow,
            info: Color::Cyan,
            dim: Color::DarkGrey,
            user_prompt: Color::White,
            ai_response: Color::Reset,
        }
    }
}

// ─── Styled Printer ─────────────────────────────────────────────────────────────

/// Styled terminal output writer.
pub struct TuiPrinter {
    theme: Theme,
    stdout: io::Stdout,
}

impl TuiPrinter {
    pub fn new() -> Self {
        Self {
            theme: Theme::default(),
            stdout: io::stdout(),
        }
    }

    pub fn with_theme(theme: Theme) -> Self {
        Self {
            theme,
            stdout: io::stdout(),
        }
    }

    /// Print a success message (green).
    pub fn success(&mut self, msg: &str) {
        self.colored_line(self.theme.success, "✓", msg);
    }

    /// Print an error message (red).
    pub fn error(&mut self, msg: &str) {
        self.colored_line(self.theme.error, "✗", msg);
    }

    /// Print a warning message (yellow).
    pub fn warning(&mut self, msg: &str) {
        self.colored_line(self.theme.warning, "⚠", msg);
    }

    /// Print an info message (cyan).
    pub fn info(&mut self, msg: &str) {
        self.colored_line(self.theme.info, "ℹ", msg);
    }

    /// Print a dimmed message (grey).
    pub fn dim(&mut self, msg: &str) {
        let _ = execute!(
            self.stdout,
            SetForegroundColor(self.theme.dim),
            Print(msg),
            Print("\n"),
            ResetColor,
        );
    }

    /// Print a header/section title (bold magenta).
    pub fn header(&mut self, msg: &str) {
        let _ = execute!(
            self.stdout,
            SetForegroundColor(self.theme.accent),
            SetAttribute(Attribute::Bold),
            Print(msg),
            Print("\n"),
            SetAttribute(Attribute::Reset),
            ResetColor,
        );
    }

    /// Print a separator line.
    pub fn separator(&mut self) {
        let width = terminal::size().map(|(w, _)| w as usize).unwrap_or(80);
        let line = "─".repeat(width.min(120));
        self.dim(&line);
    }

    /// Print token/cost summary in a status bar format.
    pub fn status_bar(&mut self, input_tokens: u32, output_tokens: u32, cost_usd: f64) {
        let _ = execute!(
            self.stdout,
            SetForegroundColor(self.theme.dim),
            Print("  "),
            SetForegroundColor(self.theme.info),
            Print(format!("↑{input_tokens}")),
            SetForegroundColor(self.theme.dim),
            Print(" / "),
            SetForegroundColor(self.theme.success),
            Print(format!("↓{output_tokens}")),
            SetForegroundColor(self.theme.dim),
            Print(format!(" tokens  ${cost_usd:.4}\n")),
            ResetColor,
        );
    }

    /// Print a streaming token (no newline).
    pub fn stream_token(&mut self, token: &str) {
        let _ = execute!(
            self.stdout,
            SetForegroundColor(self.theme.ai_response),
            Print(token),
            ResetColor,
        );
        let _ = self.stdout.flush();
    }

    /// Print the user's prompt with styling.
    pub fn user_input(&mut self, text: &str) {
        let _ = execute!(
            self.stdout,
            SetForegroundColor(self.theme.user_prompt),
            SetAttribute(Attribute::Bold),
            Print("❯ "),
            SetAttribute(Attribute::Reset),
            SetForegroundColor(self.theme.user_prompt),
            Print(text),
            Print("\n"),
            ResetColor,
        );
    }

    fn colored_line(&mut self, color: Color, prefix: &str, msg: &str) {
        let _ = execute!(
            self.stdout,
            SetForegroundColor(color),
            Print(format!("{prefix} ")),
            ResetColor,
            Print(msg),
            Print("\n"),
        );
    }
}

impl Default for TuiPrinter {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Progress Spinner ───────────────────────────────────────────────────────────

/// An animated progress spinner for long-running operations.
pub struct Spinner {
    message: String,
    running: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

impl Spinner {
    /// Start a new spinner with a message.
    pub fn start(message: &str) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let running_clone = Arc::clone(&running);
        let msg = message.to_string();

        let handle = std::thread::spawn(move || {
            let mut stdout = io::stdout();
            let mut frame = 0;
            while running_clone.load(Ordering::Relaxed) {
                let _ = execute!(
                    stdout,
                    cursor::MoveToColumn(0),
                    terminal::Clear(ClearType::CurrentLine),
                    SetForegroundColor(Color::Cyan),
                    Print(SPINNER_FRAMES[frame % SPINNER_FRAMES.len()]),
                    ResetColor,
                    Print(format!(" {msg}")),
                );
                let _ = stdout.flush();
                frame += 1;
                std::thread::sleep(Duration::from_millis(80));
            }
            // Clear the spinner line
            let _ = execute!(
                stdout,
                cursor::MoveToColumn(0),
                terminal::Clear(ClearType::CurrentLine),
            );
        });

        Self {
            message: message.to_string(),
            running,
            handle: Some(handle),
        }
    }

    /// Stop the spinner and print a completion message.
    pub fn stop_with_message(mut self, msg: &str) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let mut printer = TuiPrinter::new();
        printer.success(msg);
    }

    /// Stop the spinner with an error message.
    pub fn stop_with_error(mut self, msg: &str) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let mut printer = TuiPrinter::new();
        printer.error(msg);
    }

    /// Stop silently.
    pub fn stop(mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        // Don't join in drop to avoid blocking
    }
}

// ─── Progress Bar ───────────────────────────────────────────────────────────────

/// A simple progress bar for deterministic operations.
pub struct ProgressBar {
    total: usize,
    current: usize,
    label: String,
    start_time: Instant,
}

impl ProgressBar {
    pub fn new(total: usize, label: &str) -> Self {
        Self {
            total,
            current: 0,
            label: label.to_string(),
            start_time: Instant::now(),
        }
    }

    /// Advance the progress bar by one step.
    pub fn tick(&mut self) {
        self.current += 1;
        self.render();
    }

    /// Set progress to a specific value.
    pub fn set(&mut self, value: usize) {
        self.current = value.min(self.total);
        self.render();
    }

    /// Complete the progress bar.
    pub fn finish(&mut self) {
        self.current = self.total;
        self.render();
        let _ = writeln!(io::stdout());
    }

    fn render(&self) {
        let width = terminal::size().map(|(w, _)| w as usize).unwrap_or(80);
        let bar_width = (width - self.label.len() - 20).clamp(10, 50);
        let filled = if self.total > 0 {
            (self.current * bar_width) / self.total
        } else {
            0
        };
        let empty = bar_width - filled;
        let pct = if self.total > 0 {
            (self.current * 100) / self.total
        } else {
            0
        };
        let elapsed = self.start_time.elapsed().as_secs();

        let bar = format!(
            "\r{} [{}{}] {}/{} ({pct}%) {elapsed}s",
            self.label,
            "█".repeat(filled),
            "░".repeat(empty),
            self.current,
            self.total,
        );

        let mut stdout = io::stdout();
        let _ = execute!(
            stdout,
            cursor::MoveToColumn(0),
            terminal::Clear(ClearType::CurrentLine),
            SetForegroundColor(Color::Cyan),
            Print(&bar),
            ResetColor,
        );
        let _ = stdout.flush();
    }
}

// ─── Interactive Prompt ─────────────────────────────────────────────────────────

/// Read a line of input with a styled prompt.
pub fn read_input(prompt_str: &str) -> io::Result<String> {
    let mut stdout = io::stdout();
    let _ = execute!(
        stdout,
        SetForegroundColor(Color::Magenta),
        SetAttribute(Attribute::Bold),
        Print(prompt_str),
        SetAttribute(Attribute::Reset),
        ResetColor,
    );
    let _ = stdout.flush();

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    Ok(input.trim_end().to_string())
}

// ─── Table Renderer ─────────────────────────────────────────────────────────────

/// Render a simple aligned table in the terminal.
pub fn render_table(headers: &[&str], rows: &[Vec<String>]) {
    let col_count = headers.len();
    let mut widths = vec![0usize; col_count];

    // Calculate column widths
    for (i, h) in headers.iter().enumerate() {
        widths[i] = h.len();
    }
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if i < col_count {
                widths[i] = widths[i].max(cell.len());
            }
        }
    }

    let mut stdout = io::stdout();

    // Header
    let _ = execute!(stdout, SetForegroundColor(Color::Cyan), SetAttribute(Attribute::Bold));
    for (i, h) in headers.iter().enumerate() {
        let _ = write!(stdout, " {:<width$}", h, width = widths[i] + 1);
    }
    let _ = execute!(stdout, SetAttribute(Attribute::Reset), ResetColor, Print("\n"));

    // Separator
    let total_width: usize = widths.iter().sum::<usize>() + col_count * 2;
    let _ = execute!(
        stdout,
        SetForegroundColor(Color::DarkGrey),
        Print("─".repeat(total_width)),
        Print("\n"),
        ResetColor,
    );

    // Rows
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if i < col_count {
                let _ = write!(stdout, " {:<width$}", cell, width = widths[i] + 1);
            }
        }
        let _ = writeln!(stdout);
    }
    let _ = stdout.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_default_has_distinct_colors() {
        let theme = Theme::default();
        // Ensure key colors are different
        assert_ne!(format!("{:?}", theme.success), format!("{:?}", theme.error));
        assert_ne!(format!("{:?}", theme.info), format!("{:?}", theme.warning));
    }

    #[test]
    fn progress_bar_tracks_progress() {
        let mut bar = ProgressBar::new(100, "test");
        assert_eq!(bar.current, 0);
        bar.tick();
        assert_eq!(bar.current, 1);
        bar.set(50);
        assert_eq!(bar.current, 50);
        bar.set(200); // clamps to total
        assert_eq!(bar.current, 100);
    }

    #[test]
    fn spinner_can_start_and_stop() {
        let spinner = Spinner::start("testing...");
        std::thread::sleep(Duration::from_millis(100));
        spinner.stop();
        // Should not panic or hang
    }

    #[test]
    fn tui_printer_doesnt_panic() {
        let mut printer = TuiPrinter::new();
        printer.success("ok");
        printer.error("fail");
        printer.warning("warn");
        printer.info("info");
        printer.dim("dim");
        printer.header("header");
    }

    #[test]
    fn render_table_doesnt_panic_on_empty() {
        render_table(&["A", "B"], &[]);
    }

    #[test]
    fn render_table_with_data() {
        render_table(
            &["Name", "Status", "Tokens"],
            &[
                vec!["session-1".into(), "active".into(), "1234".into()],
                vec!["session-2".into(), "done".into(), "5678".into()],
            ],
        );
    }
}
