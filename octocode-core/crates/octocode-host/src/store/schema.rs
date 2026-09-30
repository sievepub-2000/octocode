use rusqlite::Connection;

pub(super) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sessions(
            id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT, model TEXT,
            status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages(
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
            UNIQUE(session_id, ordinal)
        );
        CREATE TABLE IF NOT EXISTS events(
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_session_sequence ON events(session_id,sequence);
        CREATE TABLE IF NOT EXISTS tool_runs(
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            name TEXT NOT NULL, input TEXT NOT NULL, output TEXT, status TEXT NOT NULL,
            exit_code INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS artifacts(
            id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            mime_type TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS logs(
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            tool_run_id TEXT REFERENCES tool_runs(id) ON DELETE SET NULL, level TEXT NOT NULL,
            subsystem TEXT NOT NULL, message TEXT NOT NULL, fields TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'developer', created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS logs_created_at ON logs(created_at);
        CREATE TABLE IF NOT EXISTS workflow_runs(
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            objective TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL,
            heartbeat_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(message_id UNINDEXED, content);
        CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(log_id UNINDEXED, message);
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
            INSERT INTO message_fts(message_id,content) VALUES(new.id,new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
            DELETE FROM message_fts WHERE message_id=old.id;
            INSERT INTO message_fts(message_id,content) VALUES(new.id,new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
            DELETE FROM message_fts WHERE message_id=old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS logs_fts_insert AFTER INSERT ON logs BEGIN
            INSERT INTO log_fts(log_id,message) VALUES(new.id,new.message);
        END;
        CREATE TRIGGER IF NOT EXISTS logs_fts_update AFTER UPDATE OF message ON logs BEGIN
            DELETE FROM log_fts WHERE log_id=old.id;
            INSERT INTO log_fts(log_id,message) VALUES(new.id,new.message);
        END;
        CREATE TRIGGER IF NOT EXISTS logs_fts_delete AFTER DELETE ON logs BEGIN
            DELETE FROM log_fts WHERE log_id=old.id;
        END;
        "#,
    )?;
    let has_category = conn
        .prepare("PRAGMA table_info(logs)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == "category");
    if !has_category {
        conn.execute(
            "ALTER TABLE logs ADD COLUMN category TEXT NOT NULL DEFAULT 'developer'",
            [],
        )?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS logs_category_created_at ON logs(category, created_at)",
        [],
    )?;
    // Memory, knowledge, world-model and curation tables from older builds are
    // left in place and unused: memory moved to the harness (2026-09-18), and the
    // vec0 virtual tables cannot be dropped without the retired extension.
    conn.execute_batch("CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL,
        directory TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );")?;
    if !has_column(conn, "sessions", "project_id")? {
        conn.execute("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL", [])?;
    }
    conn.execute("CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id)", [])?;
    conn.pragma_update(None, "user_version", 6)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    Ok(conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column))
}
