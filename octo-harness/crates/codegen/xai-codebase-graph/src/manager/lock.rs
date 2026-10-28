//! Workspace locks held by the operating system for the lifetime of a guard.
//!
//! Readers share a lock; build/save/refresh hold an exclusive lock. Process exit
//! releases the lock immediately. Keep the empty lock file in place: removing it
//! could let another process lock a different file at the same path.

use std::fs::{File, OpenOptions};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexOperation {
    Load,
    Save,
    Build,
    BackgroundRefresh,
}

impl IndexOperation {
    pub fn is_exclusive(&self) -> bool {
        !matches!(self, Self::Load)
    }
}

impl std::fmt::Display for IndexOperation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Load => "load",
            Self::Save => "save",
            Self::Build => "build",
            Self::BackgroundRefresh => "background_refresh",
        })
    }
}

/// Dropping this handle releases the kernel lock, including after process exit.
pub struct WorkspaceLockGuard {
    _file: File,
}

pub enum LockResult {
    Acquired(WorkspaceLockGuard),
    Busy {
        operation: String,
        holder_pid: Option<u32>,
    },
}

impl LockResult {
    pub fn is_acquired(&self) -> bool {
        matches!(self, Self::Acquired(_))
    }

    pub fn unwrap(self) -> WorkspaceLockGuard {
        match self {
            Self::Acquired(guard) => guard,
            Self::Busy { operation, .. } => panic!("Lock was busy: {operation}"),
        }
    }
}

fn get_lock_file_path(workspace: &Path) -> std::path::PathBuf {
    super::get_cache_path(workspace).with_extension("lock")
}

/// Acquire the same filesystem lock from every process, without check/write
/// races, stale-PID heuristics or timeout-based takeover of a live writer.
pub fn try_lock(workspace: &Path, operation: IndexOperation) -> LockResult {
    let acquire = || -> std::io::Result<WorkspaceLockGuard> {
        let workspace = dunce::canonicalize(workspace)?;
        let lock_path = get_lock_file_path(&workspace);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = options.open(lock_path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::other("Index lock must be a regular file"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(std::io::Error::other(
                    "Index lock must not be a reparse point",
                ));
            }
        }
        // Never truncate or write an existing lock path (including a hard link).
        let locked = if operation.is_exclusive() {
            file.try_lock()
        } else {
            file.try_lock_shared()
        };
        locked.map_err(std::io::Error::other)?;
        Ok(WorkspaceLockGuard { _file: file })
    };
    match acquire() {
        Ok(guard) => LockResult::Acquired(guard),
        Err(error) => LockResult::Busy {
            operation: format!("{operation}: {error}"),
            holder_pid: None,
        },
    }
}

/// Probe without retaining a lock or relying on possibly stale metadata.
pub fn is_operation_in_progress(workspace: &Path, operation: IndexOperation) -> bool {
    !try_lock(workspace, operation).is_acquired()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn cross_process_lock_probe() {
        let Some(root) = std::env::var_os("XAI_INDEX_LOCK_PROBE_ROOT") else {
            return;
        };
        let mode = std::env::var("XAI_INDEX_LOCK_PROBE_MODE").unwrap();
        let operation = if mode == "load" {
            IndexOperation::Load
        } else {
            IndexOperation::Build
        };
        let lock = try_lock(Path::new(&root), operation);
        if mode == "hold" {
            use std::io::{Read, Write};
            assert!(lock.is_acquired());
            println!("LOCK_READY");
            std::io::stdout().flush().unwrap();
            let _ = std::io::stdin().read(&mut [0]);
        } else {
            let expected = std::env::var("XAI_INDEX_LOCK_EXPECT_ACQUIRED").unwrap() == "true";
            assert_eq!(lock.is_acquired(), expected);
        }
    }

    #[test]
    fn actual_process_readers_writers_and_crash_release() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let dir = tempdir().unwrap();
        let probe = |mode: &str| {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "manager::lock::tests::cross_process_lock_probe",
                    "--nocapture",
                ])
                .env("XAI_INDEX_LOCK_PROBE_ROOT", dir.path())
                .env("XAI_INDEX_LOCK_PROBE_MODE", mode);
            command
        };
        let check = |mode: &str, acquired: bool| {
            let output = probe(mode)
                .env("XAI_INDEX_LOCK_EXPECT_ACQUIRED", acquired.to_string())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let reader = try_lock(dir.path(), IndexOperation::Load).unwrap();
        check("load", true);
        check("build", false);
        drop(reader);
        let writer = try_lock(dir.path(), IndexOperation::Build).unwrap();
        check("load", false);
        check("build", false);
        drop(writer);
        check("build", true);
        let mut holder = probe("hold")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(holder.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "holder exited before acquiring lock"
            );
            if line.contains("LOCK_READY") {
                break;
            }
        }
        check("build", false);
        holder.kill().unwrap();
        holder.wait().unwrap();
        check("build", true);
    }

    #[test]
    fn test_exclusive_lock_blocks_exclusive() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();

        // Acquire first exclusive lock
        let guard1 = try_lock(workspace, IndexOperation::Build);
        assert!(guard1.is_acquired());

        // Second exclusive lock should fail
        let result2 = try_lock(workspace, IndexOperation::Build);
        assert!(!result2.is_acquired());

        // Drop first lock
        drop(guard1);

        // Now second should succeed
        let guard3 = try_lock(workspace, IndexOperation::Build);
        assert!(guard3.is_acquired());
    }

    #[test]
    fn test_shared_locks_coexist() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();

        // Multiple shared locks should work
        let guard1 = try_lock(workspace, IndexOperation::Load);
        assert!(guard1.is_acquired());

        let guard2 = try_lock(workspace, IndexOperation::Load);
        assert!(guard2.is_acquired());

        let guard3 = try_lock(workspace, IndexOperation::Load);
        assert!(guard3.is_acquired());
    }

    #[test]
    fn test_exclusive_blocks_shared() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();

        // Acquire exclusive lock
        let guard1 = try_lock(workspace, IndexOperation::Build);
        assert!(guard1.is_acquired());

        // Shared lock should fail
        let result2 = try_lock(workspace, IndexOperation::Load);
        assert!(!result2.is_acquired());
    }

    #[test]
    fn test_shared_blocks_exclusive() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();

        // Acquire shared lock
        let guard1 = try_lock(workspace, IndexOperation::Load);
        assert!(guard1.is_acquired());

        // Exclusive lock should fail
        let result2 = try_lock(workspace, IndexOperation::Build);
        assert!(!result2.is_acquired());

        // Drop shared lock
        drop(guard1);

        // Now exclusive should succeed
        let guard3 = try_lock(workspace, IndexOperation::Build);
        assert!(guard3.is_acquired());
    }

    #[test]
    fn test_different_workspaces_independent() {
        let dir1 = tempdir().unwrap();
        let dir2 = tempdir().unwrap();

        // Locks on different workspaces should be independent
        let guard1 = try_lock(dir1.path(), IndexOperation::Build);
        assert!(guard1.is_acquired());

        let guard2 = try_lock(dir2.path(), IndexOperation::Build);
        assert!(guard2.is_acquired());
    }

    #[test]
    fn test_lock_file_created_for_exclusive() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();

        let lock_file = get_lock_file_path(workspace);

        // No lock file initially
        assert!(!lock_file.exists());

        // Acquire exclusive lock
        let guard = try_lock(workspace, IndexOperation::Build);
        assert!(guard.is_acquired());

        // Lock file should exist
        assert!(lock_file.exists());

        // Drop guard
        drop(guard);

        // Windows also prevents reading bytes covered by an exclusive lock.
        // The file is only an OS lock anchor; no data is overwritten.
        let contents = std::fs::read_to_string(&lock_file).unwrap();
        assert!(contents.is_empty());

        // Keep the same file identity so concurrent processes cannot split locks.
        assert!(lock_file.exists());
        assert!(try_lock(workspace, IndexOperation::Build).is_acquired());
    }
}
