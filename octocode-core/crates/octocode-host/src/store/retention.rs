use chrono::{Duration, Utc};
use rusqlite::Connection;

pub const DEFAULT_LOG_RETENTION_DAYS: u32 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct RetentionResult {
    pub deleted_logs: usize,
}

pub(super) fn purge_logs(
    conn: &Connection,
    retention_days: u32,
) -> rusqlite::Result<RetentionResult> {
    let cutoff = (Utc::now() - Duration::days(i64::from(retention_days.max(1)))).timestamp_millis();
    let deleted_logs = conn.execute(
        "DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE created_at < ?1 LIMIT 10000)",
        [cutoff],
    )?;
    Ok(RetentionResult { deleted_logs })
}
