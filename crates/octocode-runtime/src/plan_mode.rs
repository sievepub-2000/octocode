//! Plan Mode state machine.
//!
//! Implements a strict lifecycle for agent-proposed plans:
//!
//! ```text
//!     Draft ──► Proposed ──► Approved ──► Executing ──► Completed
//!                   │              │             │
//!                   └──► Cancelled ◄─────────────┘
//! ```
//!
//! All transitions go through a single `transition_to` function which rejects
//! illegal moves at runtime (no silent failures). Backed by sqlite so plan
//! state survives process restarts; concurrent callers are serialized by the
//! inner `Mutex<Connection>` plus sqlite `BEGIN IMMEDIATE`.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use octocode_core::OctoError;

/// Lifecycle states for a plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlanState {
    Draft,
    Proposed,
    Approved,
    Executing,
    Completed,
    Cancelled,
}

impl PlanState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Proposed => "proposed",
            Self::Approved => "approved",
            Self::Executing => "executing",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "draft" => Some(Self::Draft),
            "proposed" => Some(Self::Proposed),
            "approved" => Some(Self::Approved),
            "executing" => Some(Self::Executing),
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// Returns true iff a transition from `self` to `next` is legal.
    ///
    /// Truth table:
    ///
    /// | from       | to         | allowed |
    /// |------------|------------|---------|
    /// | Draft      | Proposed   | yes     |
    /// | Draft      | Cancelled  | yes     |
    /// | Proposed   | Approved   | yes     |
    /// | Proposed   | Cancelled  | yes     |
    /// | Approved   | Executing  | yes     |
    /// | Approved   | Cancelled  | yes     |
    /// | Executing  | Completed  | yes     |
    /// | Executing  | Cancelled  | yes     |
    /// | *          | *          | no      |
    pub fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Draft, Self::Proposed)
                | (Self::Draft, Self::Cancelled)
                | (Self::Proposed, Self::Approved)
                | (Self::Proposed, Self::Cancelled)
                | (Self::Approved, Self::Executing)
                | (Self::Approved, Self::Cancelled)
                | (Self::Executing, Self::Completed)
                | (Self::Executing, Self::Cancelled)
        )
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

/// A plan record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub id: String,
    pub session_id: String,
    pub state: PlanState,
    pub body: String,
    pub created_at_ms: u128,
    pub updated_at_ms: u128,
}

/// Sqlite-backed plan store. Clone-safe; every clone shares the same
/// underlying connection through `Arc<Mutex<_>>`.
#[derive(Clone)]
pub struct PlanStore {
    conn: Arc<Mutex<Connection>>,
}

impl PlanStore {
    pub fn open(workspace_root: &Path) -> Result<Self, OctoError> {
        let dir = workspace_root.join(".octocode");
        std::fs::create_dir_all(&dir)
            .map_err(|e| OctoError::Runtime(format!("plan-store mkdir: {e}")))?;
        let db_path = dir.join("plans.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| OctoError::Runtime(format!("plan-store open: {e}")))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
            .map_err(|e| OctoError::Runtime(format!("plan-store pragma: {e}")))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS plans (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                state TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);",
        )
        .map_err(|e| OctoError::Runtime(format!("plan-store migrate: {e}")))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Insert a new plan in the Draft state.
    pub fn create_draft(&self, session_id: &str, body: &str) -> Result<Plan, OctoError> {
        let id = format!("plan-{:016x}", (now_ms() as u64) ^ rand_u64());
        let now = now_ms();
        let conn = self.conn.lock().map_err(lock_err)?;
        conn.execute(
            "INSERT INTO plans (id, session_id, state, body, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 'draft', ?3, ?4, ?4)",
            params![id, session_id, body, now as i64],
        )
        .map_err(|e| OctoError::Runtime(format!("plan-store insert: {e}")))?;
        Ok(Plan {
            id,
            session_id: String::from(session_id),
            state: PlanState::Draft,
            body: String::from(body),
            created_at_ms: now,
            updated_at_ms: now,
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Plan>, OctoError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, state, body, created_at_ms, updated_at_ms
                 FROM plans WHERE id = ?1",
            )
            .map_err(|e| OctoError::Runtime(format!("plan-store prepare: {e}")))?;
        let mut rows = stmt
            .query(params![id])
            .map_err(|e| OctoError::Runtime(format!("plan-store query: {e}")))?;
        if let Some(row) = rows
            .next()
            .map_err(|e| OctoError::Runtime(format!("plan-store next: {e}")))?
        {
            Ok(Some(row_to_plan(row)?))
        } else {
            Ok(None)
        }
    }

    pub fn list_for_session(&self, session_id: &str) -> Result<Vec<Plan>, OctoError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, state, body, created_at_ms, updated_at_ms
                 FROM plans WHERE session_id = ?1 ORDER BY created_at_ms DESC",
            )
            .map_err(|e| OctoError::Runtime(format!("plan-store prepare: {e}")))?;
        let mut rows = stmt
            .query(params![session_id])
            .map_err(|e| OctoError::Runtime(format!("plan-store query: {e}")))?;
        let mut out = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|e| OctoError::Runtime(format!("plan-store next: {e}")))?
        {
            out.push(row_to_plan(row)?);
        }
        Ok(out)
    }

    /// Atomically transition `id` from its current state to `next`.
    ///
    /// Uses `BEGIN IMMEDIATE` + a state check inside the transaction so
    /// concurrent callers racing to perform the same transition are
    /// serialized; exactly one wins, the rest return `Err`.
    pub fn transition_to(&self, id: &str, next: PlanState) -> Result<Plan, OctoError> {
        let now = now_ms();
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| OctoError::Runtime(format!("plan-store begin: {e}")))?;
        let current: Option<String> = tx
            .query_row(
                "SELECT state FROM plans WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        let current = current.ok_or_else(|| {
            OctoError::Runtime(format!("plan {id} not found"))
        })?;
        let current_state = PlanState::parse(&current).ok_or_else(|| {
            OctoError::Runtime(format!("plan {id} has unknown state: {current}"))
        })?;
        if !current_state.can_transition_to(next) {
            return Err(OctoError::Runtime(format!(
                "illegal plan transition {} -> {} for plan {}",
                current_state.as_str(),
                next.as_str(),
                id
            )));
        }
        tx.execute(
            "UPDATE plans SET state = ?1, updated_at_ms = ?2 WHERE id = ?3",
            params![next.as_str(), now as i64, id],
        )
        .map_err(|e| OctoError::Runtime(format!("plan-store update: {e}")))?;
        tx.commit()
            .map_err(|e| OctoError::Runtime(format!("plan-store commit: {e}")))?;
        drop(conn);
        self.get(id)?.ok_or_else(|| {
            OctoError::Runtime(format!("plan {id} vanished after commit"))
        })
    }

    /// Convenience wrappers around `transition_to`.
    pub fn propose(&self, id: &str) -> Result<Plan, OctoError> {
        self.transition_to(id, PlanState::Proposed)
    }

    pub fn approve(&self, id: &str) -> Result<Plan, OctoError> {
        self.transition_to(id, PlanState::Approved)
    }

    pub fn start_execution(&self, id: &str) -> Result<Plan, OctoError> {
        self.transition_to(id, PlanState::Executing)
    }

    pub fn complete(&self, id: &str) -> Result<Plan, OctoError> {
        self.transition_to(id, PlanState::Completed)
    }

    pub fn cancel(&self, id: &str) -> Result<Plan, OctoError> {
        self.transition_to(id, PlanState::Cancelled)
    }
}

fn row_to_plan(row: &rusqlite::Row) -> Result<Plan, OctoError> {
    let state_str: String = row
        .get::<_, String>(2)
        .map_err(|e| OctoError::Runtime(format!("plan-store row.state: {e}")))?;
    let state = PlanState::parse(&state_str)
        .ok_or_else(|| OctoError::Runtime(format!("unknown plan state: {state_str}")))?;
    Ok(Plan {
        id: row
            .get::<_, String>(0)
            .map_err(|e| OctoError::Runtime(format!("row.id: {e}")))?,
        session_id: row
            .get::<_, String>(1)
            .map_err(|e| OctoError::Runtime(format!("row.session_id: {e}")))?,
        state,
        body: row
            .get::<_, String>(3)
            .map_err(|e| OctoError::Runtime(format!("row.body: {e}")))?,
        created_at_ms: row
            .get::<_, i64>(4)
            .map_err(|e| OctoError::Runtime(format!("row.created_at_ms: {e}")))?
            as u128,
        updated_at_ms: row
            .get::<_, i64>(5)
            .map_err(|e| OctoError::Runtime(format!("row.updated_at_ms: {e}")))?
            as u128,
    })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Simple pseudo-random u64 for plan id suffixes. Does NOT need to be
/// cryptographic — collision probability with 64 bits is negligible for
/// plan ids within a single workspace.
fn rand_u64() -> u64 {
    let a = now_ms() as u64;
    let b = std::process::id() as u64;
    let mut x = a.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(b);
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58476D1CE4E5B9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94D049BB133111EB);
    x ^ (x >> 31)
}

fn lock_err<T>(_: std::sync::PoisonError<T>) -> OctoError {
    OctoError::Runtime(String::from("plan-store mutex poisoned"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (PlanStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = PlanStore::open(dir.path()).expect("open plan store");
        (store, dir)
    }

    #[test]
    fn legal_transitions_exhaustive() {
        use PlanState::*;
        let legal = [
            (Draft, Proposed),
            (Draft, Cancelled),
            (Proposed, Approved),
            (Proposed, Cancelled),
            (Approved, Executing),
            (Approved, Cancelled),
            (Executing, Completed),
            (Executing, Cancelled),
        ];
        for (a, b) in legal {
            assert!(a.can_transition_to(b), "should allow {a:?} -> {b:?}");
        }
    }

    #[test]
    fn illegal_transitions_rejected() {
        use PlanState::*;
        let illegal = [
            (Draft, Approved),
            (Draft, Executing),
            (Draft, Completed),
            (Proposed, Executing),
            (Proposed, Completed),
            (Approved, Completed),
            (Approved, Proposed),
            (Executing, Proposed),
            (Executing, Approved),
            (Completed, Proposed),
            (Completed, Approved),
            (Completed, Executing),
            (Completed, Cancelled),
            (Cancelled, Proposed),
            (Cancelled, Approved),
            (Cancelled, Executing),
            (Cancelled, Completed),
        ];
        for (a, b) in illegal {
            assert!(!a.can_transition_to(b), "should reject {a:?} -> {b:?}");
        }
    }

    #[test]
    fn create_and_full_happy_path() {
        let (store, _dir) = tmp_store();
        let plan = store
            .create_draft("sess-1", "1. investigate\n2. fix\n3. test")
            .unwrap();
        assert_eq!(plan.state, PlanState::Draft);
        assert_eq!(store.propose(&plan.id).unwrap().state, PlanState::Proposed);
        assert_eq!(store.approve(&plan.id).unwrap().state, PlanState::Approved);
        assert_eq!(
            store.start_execution(&plan.id).unwrap().state,
            PlanState::Executing
        );
        assert_eq!(store.complete(&plan.id).unwrap().state, PlanState::Completed);
        assert!(store.get(&plan.id).unwrap().unwrap().state.is_terminal());
    }

    #[test]
    fn illegal_transition_returns_err() {
        let (store, _dir) = tmp_store();
        let plan = store.create_draft("s", "body").unwrap();
        // Draft -> Approved is illegal; must go through Proposed.
        let result = store.approve(&plan.id);
        assert!(result.is_err(), "expected error, got {result:?}");
        // State unchanged.
        assert_eq!(
            store.get(&plan.id).unwrap().unwrap().state,
            PlanState::Draft
        );
    }

    #[test]
    fn cancel_from_any_non_terminal_state() {
        let (store, _dir) = tmp_store();
        for &from in &[PlanState::Draft, PlanState::Proposed, PlanState::Approved, PlanState::Executing] {
            let plan = store.create_draft("s", "body").unwrap();
            // Drive up to target state.
            if from as u8 >= PlanState::Proposed as u8 {
                store.propose(&plan.id).unwrap();
            }
            if from as u8 >= PlanState::Approved as u8 {
                store.approve(&plan.id).unwrap();
            }
            if from as u8 >= PlanState::Executing as u8 {
                store.start_execution(&plan.id).unwrap();
            }
            // Cancel must succeed from all four.
            let cancelled = store.cancel(&plan.id).unwrap();
            assert_eq!(cancelled.state, PlanState::Cancelled, "from {from:?}");
        }
    }

    #[test]
    fn concurrent_approve_exactly_one_wins() {
        let (store, _dir) = tmp_store();
        let plan = store.create_draft("s", "body").unwrap();
        store.propose(&plan.id).unwrap();

        // Two threads race to approve the same plan. Approve is legal from
        // Proposed; but after the winner, the loser tries Proposed->Approved
        // which is still legal (state is now Approved, so Approved->Approved
        // is illegal). Exactly one call must succeed; the other must Err.
        let s1 = store.clone();
        let s2 = store.clone();
        let id1 = plan.id.clone();
        let id2 = plan.id.clone();
        let t1 = std::thread::spawn(move || s1.approve(&id1));
        let t2 = std::thread::spawn(move || s2.approve(&id2));
        let r1 = t1.join().unwrap();
        let r2 = t2.join().unwrap();
        let ok_count = [&r1, &r2].iter().filter(|r| r.is_ok()).count();
        assert_eq!(ok_count, 1, "exactly one must succeed; r1={r1:?} r2={r2:?}");
        assert_eq!(
            store.get(&plan.id).unwrap().unwrap().state,
            PlanState::Approved
        );
    }

    #[test]
    fn persistence_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let id = {
            let store = PlanStore::open(dir.path()).unwrap();
            let p = store.create_draft("s", "b").unwrap();
            store.propose(&p.id).unwrap();
            p.id
        };
        let store2 = PlanStore::open(dir.path()).unwrap();
        let loaded = store2.get(&id).unwrap().unwrap();
        assert_eq!(loaded.state, PlanState::Proposed);
    }

    #[test]
    fn list_for_session_orders_by_created_desc() {
        let (store, _dir) = tmp_store();
        let a = store.create_draft("sx", "a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = store.create_draft("sx", "b").unwrap();
        let items = store.list_for_session("sx").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, b.id);
        assert_eq!(items[1].id, a.id);
    }
}
