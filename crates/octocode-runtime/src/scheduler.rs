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
use std::time::{SystemTime, UNIX_EPOCH};

use octocode_core::OctoError;

const SCHEDULE_FILE: &str = "schedules.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleEntry {
    pub name: String,
    pub interval_secs: u64,
    pub command: String,
    pub last_fired_unix: u64,
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
        });
        self.save(&entries)
    }

    pub fn list(&self) -> Result<Vec<ScheduleEntry>, OctoError> {
        self.load()
    }

    /// Return names of entries that have elapsed since `last_fired_unix`
    /// when measured against `now_unix`. Updates persistence so each
    /// entry only fires once per interval per `tick` call.
    #[allow(dead_code)]
    pub fn tick(&self, now_unix: u64) -> Result<Vec<ScheduleEntry>, OctoError> {
        let mut entries = self.load()?;
        let mut due: Vec<ScheduleEntry> = Vec::new();
        for entry in entries.iter_mut() {
            let next_fire = entry.last_fired_unix.saturating_add(entry.interval_secs);
            if now_unix >= next_fire {
                entry.last_fired_unix = now_unix;
                due.push(entry.clone());
            }
        }
        if !due.is_empty() {
            self.save(&entries)?;
        }
        Ok(due)
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
        .replace('\n', " ")
        .replace('\r', " ")
        .replace('|', "/")
}

fn render_entries(entries: &[ScheduleEntry]) -> String {
    let mut out = String::from("# octocode schedules v1\n");
    for e in entries {
        out.push_str(&format!(
            "v1|{}|{}|{}|{}\n",
            sanitize(&e.name),
            e.interval_secs,
            e.last_fired_unix,
            sanitize(&e.command)
        ));
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
        if tag != "v1" {
            continue;
        }
        let name = parts.next().unwrap_or("").to_string();
        let interval = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let last = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let command = parts.next().unwrap_or("").to_string();
        if name.is_empty() || interval == 0 || command.is_empty() {
            continue;
        }
        out.push(ScheduleEntry {
            name,
            interval_secs: interval,
            command,
            last_fired_unix: last,
        });
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
}
