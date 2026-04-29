//! Lightweight cron-lite scheduler used by `schedule-add` / `schedule-list`
//! tools. Persists every entry into `<workspace>/.octocode/schedules.json`
//! so the catalog survives restarts. Entries are interval-based (in
//! seconds) — a full cron expression parser is intentionally out of
//! scope for this MVP slice.
//!
//! The scheduler does **not** spawn a background thread. Callers are
//! expected to drive [`Scheduler::tick`] from an existing event loop
//! (e.g. the agent loop, the WebUI ticker, or a future
//! `octocode-gateway` worker). This keeps the module reusable across
//! short-lived CLI invocations and long-running WebUI processes
//! without forcing a runtime decision here.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use octocode_core::OctoError;

use crate::cron::CronSchedule;

const SCHEDULE_FILE: &str = "schedules.json";

/// Trigger metadata for a registered schedule. `Interval` repeats every
/// N seconds; `Cron` evaluates a 5-field expression (UTC).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleTrigger {
    Interval { secs: u64 },
    Cron { expr: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleEntry {
    pub name: String,
    pub interval_secs: u64,
    pub command: String,
    pub last_fired_unix: u64,
    pub trigger: ScheduleTrigger,
}

#[derive(Debug, Clone)]
pub struct Scheduler {
    workspace_root: PathBuf,
}

impl Scheduler {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self { workspace_root: workspace_root.into() }
    }

    fn store_path(&self) -> PathBuf {
        self.workspace_root.join(".octocode").join(SCHEDULE_FILE)
    }

    fn load(&self) -> Result<Vec<ScheduleEntry>, OctoError> {
        let path = self.store_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|e| OctoError::Runtime(format!("schedule read: {e}")))?;
        Ok(parse_entries(&text))
    }

    fn save(&self, entries: &[ScheduleEntry]) -> Result<(), OctoError> {
        let path = self.store_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| OctoError::Runtime(format!("schedule mkdir: {e}")))?;
        }
        std::fs::write(&path, render_entries(entries))
            .map_err(|e| OctoError::Runtime(format!("schedule write: {e}")))?;
        Ok(())
    }

    /// Register or replace a schedule by `name`.
    pub fn add(&self, name: &str, interval_secs: u64, command: &str) -> Result<(), OctoError> {
        if name.trim().is_empty() {
            return Err(OctoError::Runtime(String::from("schedule name must be non-empty")));
        }
        if interval_secs == 0 {
            return Err(OctoError::Runtime(String::from(
                "schedule interval_secs must be > 0",
            )));
        }
        if command.trim().is_empty() {
            return Err(OctoError::Runtime(String::from("schedule command must be non-empty")));
        }
        let mut entries = self.load()?;
        entries.retain(|e| e.name != name);
        entries.push(ScheduleEntry {
            name: String::from(name.trim()),
            interval_secs,
            command: String::from(command.trim()),
            last_fired_unix: 0,
            trigger: ScheduleTrigger::Interval { secs: interval_secs },
        });
        self.save(&entries)
    }

    /// Register or replace a schedule that fires on a 5-field cron
    /// expression (UTC). Validates the expression eagerly so callers
    /// see syntax errors at registration time, not at first tick.
    pub fn add_cron(&self, name: &str, expr: &str, command: &str) -> Result<(), OctoError> {
        if name.trim().is_empty() {
            return Err(OctoError::Runtime(String::from("schedule name must be non-empty")));
        }
        if command.trim().is_empty() {
            return Err(OctoError::Runtime(String::from("schedule command must be non-empty")));
        }
        // Validate up-front; we do not store the parsed form because
        // schedules persist as plain text.
        let _ = CronSchedule::parse(expr)?;
        let mut entries = self.load()?;
        entries.retain(|e| e.name != name);
        entries.push(ScheduleEntry {
            name: String::from(name.trim()),
            interval_secs: 0,
            command: String::from(command.trim()),
            last_fired_unix: 0,
            trigger: ScheduleTrigger::Cron { expr: String::from(expr.trim()) },
        });
        self.save(&entries)
    }

    pub fn list(&self) -> Result<Vec<ScheduleEntry>, OctoError> {
        self.load()
    }

    /// Return entries that are due relative to `now_unix`. Each entry's
    /// trigger decides "due":
    ///   * `Interval { secs }` — fires when `now >= last_fired + secs`.
    ///   * `Cron { expr }` — fires when `now >= next_after(last_fired)`.
    /// Updates persistence so each entry only fires once per call.
    #[allow(dead_code)]
    pub fn tick(&self, now_unix: u64) -> Result<Vec<ScheduleEntry>, OctoError> {
        let mut entries = self.load()?;
        let mut due: Vec<ScheduleEntry> = Vec::new();
        for entry in entries.iter_mut() {
            let is_due = match &entry.trigger {
                ScheduleTrigger::Interval { secs } => {
                    let next_fire = entry.last_fired_unix.saturating_add(*secs);
                    now_unix >= next_fire
                }
                ScheduleTrigger::Cron { expr } => match CronSchedule::parse(expr) {
                    Ok(sched) => match sched.next_after(entry.last_fired_unix) {
                        Some(next) => now_unix >= next,
                        None => false,
                    },
                    Err(_) => false, // skip invalid expression silently
                },
            };
            if is_due {
                entry.last_fired_unix = now_unix;
                due.push(entry.clone());
            }
        }
        if !due.is_empty() {
            self.save(&entries)?;
        }
        Ok(due)
    }

    /// Spawn a background thread that wakes every `poll_interval` and
    /// invokes `on_due` for each fired entry. The returned handle owns
    /// the shutdown flag and the join handle, so callers can stop the
    /// runner deterministically. The runner intentionally swallows
    /// individual errors to keep the loop alive across transient I/O
    /// failures (e.g. a temporarily unwritable schedules file).
    #[allow(dead_code)]
    pub fn spawn_background<F>(
        self,
        poll_interval: Duration,
        on_due: F,
    ) -> SchedulerHandle
    where
        F: Fn(&ScheduleEntry) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let join = thread::spawn(move || {
            while !stop_for_thread.load(Ordering::Relaxed) {
                let now = now_unix();
                if let Ok(due) = self.tick(now) {
                    for entry in &due {
                        on_due(entry);
                    }
                }
                // Sleep in small chunks so shutdown is responsive.
                let mut slept = Duration::ZERO;
                while slept < poll_interval && !stop_for_thread.load(Ordering::Relaxed) {
                    let chunk = poll_interval
                        .saturating_sub(slept)
                        .min(Duration::from_millis(50));
                    thread::sleep(chunk);
                    slept += chunk;
                }
            }
        });
        SchedulerHandle { stop, join: Some(join) }
    }
}

/// Owning handle for a background scheduler. Dropping the handle stops
/// the runner thread and joins it, so test cleanup is deterministic.
#[allow(dead_code)]
pub struct SchedulerHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[allow(dead_code)]
impl SchedulerHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    pub fn join(mut self) {
        self.stop();
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for SchedulerHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Convenience: current unix seconds.
#[allow(dead_code)]
pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── Tiny JSON-array serializer (avoids pulling serde_json into this
//    module just for a flat record list). The format is one entry per
//    line, pipe-delimited, prefixed with `v1|`. Inputs are sanitized
//    so they never contain `|` or newline.

fn sanitize(value: &str) -> String {
    value
        .replace(['\n', '\r'], " ")
        .replace('|', "/")
}

fn render_entries(entries: &[ScheduleEntry]) -> String {
    let mut out = String::from("# octocode schedules v1\n");
    for e in entries {
        match &e.trigger {
            ScheduleTrigger::Interval { secs } => out.push_str(&format!(
                "v1|{}|{}|{}|{}\n",
                sanitize(&e.name),
                secs,
                e.last_fired_unix,
                sanitize(&e.command)
            )),
            ScheduleTrigger::Cron { expr } => out.push_str(&format!(
                "v2|{}|cron:{}|{}|{}\n",
                sanitize(&e.name),
                sanitize(expr),
                e.last_fired_unix,
                sanitize(&e.command)
            )),
        }
    }
    out
}

fn parse_entries(text: &str) -> Vec<ScheduleEntry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(5, '|');
        let tag = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").to_string();
        let trigger_field = parts.next().unwrap_or("");
        let last = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let command = parts.next().unwrap_or("").to_string();
        if name.is_empty() || command.is_empty() {
            continue;
        }
        match tag {
            "v1" => {
                let interval = trigger_field.parse::<u64>().unwrap_or(0);
                if interval == 0 {
                    continue;
                }
                out.push(ScheduleEntry {
                    name,
                    interval_secs: interval,
                    command,
                    last_fired_unix: last,
                    trigger: ScheduleTrigger::Interval { secs: interval },
                });
            }
            "v2" => {
                let expr = match trigger_field.strip_prefix("cron:") {
                    Some(rest) => rest.to_string(),
                    None => continue,
                };
                if expr.is_empty() {
                    continue;
                }
                out.push(ScheduleEntry {
                    name,
                    interval_secs: 0,
                    command,
                    last_fired_unix: last,
                    trigger: ScheduleTrigger::Cron { expr },
                });
            }
            _ => continue,
        }
    }
    out
}

#[allow(dead_code)]
pub fn workspace_schedule_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".octocode")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "octocode-sched-{}-{}-{}",
            std::process::id(),
            now_unix(),
            n
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn add_then_list_round_trips_entry() {
        let root = temp_root();
        let s = Scheduler::new(&root);
        s.add("nightly-build", 86400, "cargo build --release").unwrap();
        let entries = s.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "nightly-build");
        assert_eq!(entries[0].interval_secs, 86400);
        assert_eq!(entries[0].command, "cargo build --release");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn add_replaces_entry_with_same_name() {
        let root = temp_root();
        let s = Scheduler::new(&root);
        s.add("ping", 60, "echo a").unwrap();
        s.add("ping", 30, "echo b").unwrap();
        let entries = s.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].interval_secs, 30);
        assert_eq!(entries[0].command, "echo b");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tick_fires_due_entries_and_advances_last_fired() {
        let root = temp_root();
        let s = Scheduler::new(&root);
        s.add("a", 10, "echo a").unwrap();
        s.add("b", 100, "echo b").unwrap();
        let due = s.tick(50).unwrap();
        // Both entries are due against last_fired=0 + interval at t=50:
        // a (10s) is due, b (100s) is also due because 0+100=100 > 50? no
        // 50 >= 100 is false, so b is not due.
        let names: Vec<_> = due.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a"));
        assert!(!names.contains(&"b"));
        // Re-tick at same time: 'a' just fired at 50, 50>=50+10=60 false.
        let due_again = s.tick(55).unwrap();
        assert!(due_again.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_zero_interval_and_empty_command() {
        let root = temp_root();
        let s = Scheduler::new(&root);
        assert!(s.add("x", 0, "echo").is_err());
        assert!(s.add("x", 10, "   ").is_err());
        assert!(s.add("  ", 10, "echo").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sanitizes_pipe_and_newline_in_command() {
        let root = temp_root();
        let s = Scheduler::new(&root);
        s.add("danger", 10, "echo a|b\nc").unwrap();
        let entries = s.list().unwrap();
        assert_eq!(entries.len(), 1);
        // pipe replaced with '/', newline with space — round-trip safe.
        assert_eq!(entries[0].command, "echo a/b c");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn add_cron_round_trips_and_reports_trigger() {
        let root = temp_root();
        let s = Scheduler::new(&root);
        s.add_cron("daily-9am", "0 9 * * 1-5", "cargo build").unwrap();
        let entries = s.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "daily-9am");
        assert_eq!(entries[0].command, "cargo build");
        match &entries[0].trigger {
            ScheduleTrigger::Cron { expr } => assert_eq!(expr, "0 9 * * 1-5"),
            other => panic!("expected cron trigger, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn add_cron_rejects_invalid_expression_eagerly() {
        let root = temp_root();
        let s = Scheduler::new(&root);
        let err = s.add_cron("bad", "60 * * * *", "x").expect_err("must reject");
        assert!(err.to_string().contains("cron"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tick_fires_cron_entry_when_minute_elapses() {
        let root = temp_root();
        let s = Scheduler::new(&root);
        // Wildcard cron fires every minute. last_fired_unix=0 initially,
        // and tick at any positive time should fire.
        s.add_cron("every-min", "* * * * *", "echo ping").unwrap();
        let due = s.tick(120).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].name, "every-min");
        // Re-tick at the same second is a no-op because last_fired==120,
        // and next_after(120) is 180, so 120 < 180.
        let again = s.tick(120).unwrap();
        assert!(again.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn spawn_background_invokes_callback_then_stops_cleanly() {
        use std::sync::atomic::{AtomicUsize, Ordering as O};
        let root = temp_root();
        let s = Scheduler::new(&root);
        s.add("ping", 1, "echo go").unwrap();
        let counter = std::sync::Arc::new(AtomicUsize::new(0));
        let counter_for_cb = counter.clone();
        let handle = s.spawn_background(Duration::from_millis(20), move |_e| {
            counter_for_cb.fetch_add(1, O::Relaxed);
        });
        // Wait up to 500 ms for at least one fire (interval=1s with
        // last_fired=0 means immediately due on first tick).
        for _ in 0..50 {
            if counter.load(O::Relaxed) > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        handle.join();
        assert!(counter.load(O::Relaxed) >= 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
