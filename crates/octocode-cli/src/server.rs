use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use octocode_api::{BuiltinProvider, ProviderRegistry};
use octocode_commands::{
    execute_command, is_allowed_web_port, CliCommand, WEB_PORT_MAX, WEB_PORT_MIN,
};
use octocode_core::{
    ConversationStore, ModelProvider, OctoError, PermissionMode, PlatformSupport,
    ProviderFactory, RuntimeConfig, SessionStore, SessionSummary, TaskKind, TaskState,
    ToolCall, ToolExecutor, TurnStateStore,
};
use octocode_runtime::{
    ConfigLoader, CoordinatorEngine, FileSessionStore, NativePlatform,
    OctocodeRuntime, RuntimeProviderRouter, TaskStore, WorkspaceToolExecutor,
};
use crate::{manage_config, terminal, ws};
use crate::server_cache::{
    cached_config_load, cached_health_payload, spawn_sse_heartbeat,
    store_cached_health_payload, turn_now_ms_for_cache,
};

/// Maximum HTTP request body size (10 MB).
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

/// Maximum API requests per second per IP (simple sliding window).
const RATE_LIMIT_PER_SEC: usize = 30;

/// P11-C: Prometheus-style process counters. They are deliberately minimal —
/// the goal is to give operators a single scrape target to confirm the
/// server is live and see basic request volume. No high-cardinality labels.
static METRICS_REQUESTS_TOTAL: AtomicU64 = AtomicU64::new(0);
static METRICS_ERRORS_TOTAL: AtomicU64 = AtomicU64::new(0);
/// 2026.4.24-B1: operational counters for agent workload observability.
/// Still label-free to keep Prometheus cardinality at O(1) per series.
static METRICS_CHAT_REQUESTS_TOTAL: AtomicU64 = AtomicU64::new(0);
static METRICS_TOOL_INVOCATIONS_TOTAL: AtomicU64 = AtomicU64::new(0);
static METRICS_SESSIONS_CREATED_TOTAL: AtomicU64 = AtomicU64::new(0);
/// T6 (release-hardening): release operability counters.
/// `agent_iterations_total` increments per supervised agent loop step;
/// `circuit_open_total` increments each time the provider router trips
/// a circuit breaker open. Both are label-free for cardinality safety.
pub(crate) static METRICS_AGENT_ITERATIONS_TOTAL: AtomicU64 = AtomicU64::new(0);
pub(crate) static METRICS_CIRCUIT_OPEN_TOTAL: AtomicU64 = AtomicU64::new(0);

/// P13-B: Render the Prometheus text body for the `/metrics` endpoint.
/// Exposed as a pub fn so integration tests can assert the format
/// without binding a socket.
pub fn render_metrics_body() -> String {
    let requests = METRICS_REQUESTS_TOTAL.load(Ordering::Relaxed);
    let errors = METRICS_ERRORS_TOTAL.load(Ordering::Relaxed);
    let chat_requests = METRICS_CHAT_REQUESTS_TOTAL.load(Ordering::Relaxed);
    let tool_invocations = METRICS_TOOL_INVOCATIONS_TOTAL.load(Ordering::Relaxed);
    let sessions_created = METRICS_SESSIONS_CREATED_TOTAL.load(Ordering::Relaxed);
    let memory_notes = METRICS_MEMORY_NOTES_TOTAL.load(Ordering::Relaxed);
    let agent_tasks_active = agent_tasks::active_count();
    let agent_iterations = METRICS_AGENT_ITERATIONS_TOTAL.load(Ordering::Relaxed);
    let circuit_open = METRICS_CIRCUIT_OPEN_TOTAL.load(Ordering::Relaxed);
    let version = env!("CARGO_PKG_VERSION");
    format!(
        concat!(
            "# HELP octocode_requests_total Total HTTP requests received (excluding CORS preflight).\n",
            "# TYPE octocode_requests_total counter\n",
            "octocode_requests_total {requests}\n",
            "# HELP octocode_errors_total Total HTTP requests that failed with a 5xx response.\n",
            "# TYPE octocode_errors_total counter\n",
            "octocode_errors_total {errors}\n",
            "# HELP octocode_chat_requests_total Total /api/chat prompt attempts (successful + failed).\n",
            "# TYPE octocode_chat_requests_total counter\n",
            "octocode_chat_requests_total {chat_requests}\n",
            "# HELP octocode_tool_invocations_total Total /api/tool direct-invocation attempts.\n",
            "# TYPE octocode_tool_invocations_total counter\n",
            "octocode_tool_invocations_total {tool_invocations}\n",
            "# HELP octocode_sessions_created_total Total sessions created via /api/sessions/create.\n",
            "# TYPE octocode_sessions_created_total counter\n",
            "octocode_sessions_created_total {sessions_created}\n",
            "# HELP octocode_memory_notes_total Total permanent-memory notes appended since startup.\n",
            "# TYPE octocode_memory_notes_total counter\n",
            "octocode_memory_notes_total {memory_notes}\n",
            "# HELP octocode_agent_tasks_active Current number of supervised agent tasks in 'running' status.\n",
            "# TYPE octocode_agent_tasks_active gauge\n",
            "octocode_agent_tasks_active {agent_tasks_active}\n",
            "# HELP octocode_agent_iterations_total Total agent loop iterations executed across all sessions.\n",
            "# TYPE octocode_agent_iterations_total counter\n",
            "octocode_agent_iterations_total {agent_iterations}\n",
            "# HELP octocode_circuit_open_total Total number of times a provider circuit breaker tripped open.\n",
            "# TYPE octocode_circuit_open_total counter\n",
            "octocode_circuit_open_total {circuit_open}\n",
            "# HELP octocode_build_info Build information (labeled gauge, always 1).\n",
            "# TYPE octocode_build_info gauge\n",
            "octocode_build_info{{version=\"{version}\"}} 1\n",
        ),
        requests = requests,
        errors = errors,
        chat_requests = chat_requests,
        tool_invocations = tool_invocations,
        sessions_created = sessions_created,
        memory_notes = memory_notes,
        agent_tasks_active = agent_tasks_active,
        agent_iterations = agent_iterations,
        circuit_open = circuit_open,
        version = version,
    )
}

/// 2026.4.24-B1: operational counters for permanent memory + agent supervision.
static METRICS_MEMORY_NOTES_TOTAL: AtomicU64 = AtomicU64::new(0);

/// Persistent structured memory store inspired by mem0 (multi-level scope,
/// tags, importance, keyword search) and simplemem (tag-indexed minimal
/// notes). Stored as JSONL at `{data_home}/memory.jsonl` so operators can
/// cat/grep/tail without a DB dependency.
///
/// Record schema (v2, forward-compatible with v1):
///   {
///     "id": 17,
///     "createdAt": 1745500000000,
///     "updatedAt": 1745500000000,
///     "scope": "default" | "user" | "session" | "agent" | ...,
///     "userId": "alice" | null,
///     "sessionId": "s-123" | null,
///     "agentId": "coder" | null,
///     "tags": ["pref", "style"],
///     "importance": 5,        // 1..=10, default 5
///     "text": "prefers dark mode",
///     "deleted": false        // tombstone marker
///   }
///
/// Deletes are tombstones (we never rewrite the append log for a single
/// delete) — `compact()` rewrites the file dropping tombstones.
mod memory_store {
    use std::collections::HashMap;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Monotonic id generator. Seeded lazily from the on-disk max id so
    /// restarts don't collide with earlier rows.
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    static SEED_DONE: OnceLock<()> = OnceLock::new();

    /// Serialises writes so concurrent /api/memory/* calls don't interleave
    /// lines inside a JSONL record. Reads are lock-free.
    fn write_lock() -> &'static Mutex<()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
    }

    fn file_path(data_home: &str) -> PathBuf {
        PathBuf::from(data_home).join("memory.jsonl")
    }

    fn now_ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    fn escape(value: &str) -> String {
        let mut out = String::with_capacity(value.len() + 2);
        for ch in value.chars() {
            match ch {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out
    }

    #[derive(Clone, Default)]
    pub struct Record {
        pub id: u64,
        pub created_at: u128,
        pub updated_at: u128,
        pub scope: String,
        pub user_id: Option<String>,
        pub session_id: Option<String>,
        pub agent_id: Option<String>,
        pub tags: Vec<String>,
        pub importance: u8,
        pub text: String,
        pub deleted: bool,
    }

    #[derive(Clone, Default)]
    pub struct Filter {
        pub scope: Option<String>,
        pub user_id: Option<String>,
        pub session_id: Option<String>,
        pub agent_id: Option<String>,
        pub tag: Option<String>,
        pub limit: Option<usize>,
    }

    /// Ultra-small hand-rolled JSON reader for our own schema. We only need
    /// a handful of known keys; a full parser would add deps without value.
    fn parse_record(line: &str) -> Option<Record> {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
            return None;
        }
        let mut rec = Record { importance: 5, ..Record::default() };

        // very small state machine — walk key:value pairs
        let bytes = trimmed.as_bytes();
        let mut i = 1usize; // skip opening '{'
        while i < bytes.len() {
            // skip whitespace/commas
            while i < bytes.len() && matches!(bytes[i], b' ' | b',' | b'\n' | b'\t') {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] == b'}' {
                break;
            }
            if bytes[i] != b'"' {
                return None;
            }
            i += 1;
            let key_start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' { i += 2; continue; }
                i += 1;
            }
            if i >= bytes.len() { return None; }
            let key = &trimmed[key_start..i];
            i += 1;
            while i < bytes.len() && matches!(bytes[i], b' ' | b':' | b'\t') {
                i += 1;
            }
            if i >= bytes.len() { return None; }

            // parse value
            match bytes[i] {
                b'"' => {
                    i += 1;
                    let val_start = i;
                    let mut unescaped = String::new();
                    while i < bytes.len() && bytes[i] != b'"' {
                        if bytes[i] == b'\\' && i + 1 < bytes.len() {
                            let c = bytes[i + 1];
                            unescaped.push_str(&trimmed[val_start..i]);
                            match c {
                                b'n' => unescaped.push('\n'),
                                b't' => unescaped.push('\t'),
                                b'r' => unescaped.push('\r'),
                                b'"' => unescaped.push('"'),
                                b'\\' => unescaped.push('\\'),
                                _ => unescaped.push(c as char),
                            }
                            i += 2;
                            // resume: we already consumed through i+2, track new segment
                            let seg_start = i;
                            while i < bytes.len() && bytes[i] != b'"' && bytes[i] != b'\\' {
                                i += 1;
                            }
                            unescaped.push_str(&trimmed[seg_start..i]);
                            continue;
                        }
                        i += 1;
                    }
                    if i >= bytes.len() { return None; }
                    let value = if unescaped.is_empty() {
                        trimmed[val_start..i].to_string()
                    } else {
                        unescaped
                    };
                    i += 1;
                    match key {
                        "scope" => rec.scope = value,
                        "text" => rec.text = value,
                        "userId" => rec.user_id = Some(value),
                        "sessionId" => rec.session_id = Some(value),
                        "agentId" => rec.agent_id = Some(value),
                        _ => {}
                    }
                }
                b'[' => {
                    i += 1;
                    let mut vals: Vec<String> = Vec::new();
                    loop {
                        while i < bytes.len() && matches!(bytes[i], b' ' | b',' | b'\t') { i += 1; }
                        if i >= bytes.len() || bytes[i] == b']' { i = i.saturating_add(1); break; }
                        if bytes[i] == b'"' {
                            i += 1;
                            let vs = i;
                            while i < bytes.len() && bytes[i] != b'"' {
                                if bytes[i] == b'\\' { i += 2; continue; }
                                i += 1;
                            }
                            if i >= bytes.len() { return None; }
                            vals.push(trimmed[vs..i].to_string());
                            i += 1;
                        } else {
                            // skip non-string array members
                            while i < bytes.len() && bytes[i] != b',' && bytes[i] != b']' { i += 1; }
                        }
                    }
                    if key == "tags" { rec.tags = vals; }
                }
                b't' | b'f' => {
                    let is_true = bytes.get(i..i + 4).map(|s| s == b"true").unwrap_or(false);
                    // advance past the literal
                    while i < bytes.len() && bytes[i].is_ascii_alphabetic() { i += 1; }
                    if key == "deleted" { rec.deleted = is_true; }
                }
                b'n' => {
                    while i < bytes.len() && bytes[i].is_ascii_alphabetic() { i += 1; }
                }
                _ => {
                    // number
                    let ns = i;
                    while i < bytes.len()
                        && (bytes[i].is_ascii_digit() || bytes[i] == b'-' || bytes[i] == b'.')
                    {
                        i += 1;
                    }
                    let num = &trimmed[ns..i];
                    match key {
                        "id" => rec.id = num.parse().unwrap_or(0),
                        "createdAt" => rec.created_at = num.parse().unwrap_or(0),
                        "updatedAt" => rec.updated_at = num.parse().unwrap_or(0),
                        "importance" => rec.importance = num.parse().unwrap_or(5),
                        _ => {}
                    }
                }
            }
        }
        if rec.updated_at == 0 { rec.updated_at = rec.created_at; }
        if rec.scope.is_empty() { rec.scope = String::from("default"); }
        Some(rec)
    }

    fn serialise(rec: &Record) -> String {
        let tags_json = rec
            .tags
            .iter()
            .map(|t| format!("\"{}\"", escape(t)))
            .collect::<Vec<_>>()
            .join(",");
        let opt_field = |field: &str, v: &Option<String>| -> String {
            match v {
                Some(s) => format!(",\"{field}\":\"{}\"", escape(s)),
                None => String::new(),
            }
        };
        format!(
            "{{\"id\":{id},\"createdAt\":{created},\"updatedAt\":{updated},\"scope\":\"{scope}\"{u}{s}{a},\"tags\":[{tags}],\"importance\":{imp},\"text\":\"{text}\",\"deleted\":{del}}}\n",
            id = rec.id,
            created = rec.created_at,
            updated = rec.updated_at,
            scope = escape(&rec.scope),
            u = opt_field("userId", &rec.user_id),
            s = opt_field("sessionId", &rec.session_id),
            a = opt_field("agentId", &rec.agent_id),
            tags = tags_json,
            imp = rec.importance,
            text = escape(&rec.text),
            del = rec.deleted,
        )
    }

    fn read_all_records(data_home: &str) -> Vec<Record> {
        let path = file_path(data_home);
        let raw = fs::read_to_string(&path).unwrap_or_default();
        raw.lines().filter_map(parse_record).collect()
    }

    fn latest_by_id(data_home: &str) -> HashMap<u64, Record> {
        let mut map: HashMap<u64, Record> = HashMap::new();
        for rec in read_all_records(data_home) {
            let entry = map.entry(rec.id).or_default();
            if rec.updated_at >= entry.updated_at || entry.id == 0 {
                *entry = rec;
            }
        }
        map
    }

    fn seed_next_id(data_home: &str) {
        SEED_DONE.get_or_init(|| {
            let mut max = 0u64;
            for rec in read_all_records(data_home) {
                if rec.id > max { max = rec.id; }
            }
            NEXT_ID.store(max, Ordering::Relaxed);
        });
    }

    /// Appends a new record. Returns the new id. Only `scope` + `text` are
    /// required; tags/importance/scopes are optional.
    #[allow(clippy::too_many_arguments)]
    pub fn add(
        data_home: &str,
        scope: &str,
        text: &str,
        tags: Vec<String>,
        importance: u8,
        user_id: Option<String>,
        session_id: Option<String>,
        agent_id: Option<String>,
    ) -> std::io::Result<u64> {
        seed_next_id(data_home);
        let path = file_path(data_home);
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        let _g = write_lock().lock().unwrap();
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed) + 1;
        let now = now_ms();
        let rec = Record {
            id,
            created_at: now,
            updated_at: now,
            scope: if scope.is_empty() { String::from("default") } else { scope.to_string() },
            user_id,
            session_id,
            agent_id,
            tags,
            importance: importance.clamp(1, 10),
            text: text.to_string(),
            deleted: false,
        };
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        f.write_all(serialise(&rec).as_bytes())?;
        Ok(id)
    }

    /// Appends a tombstone record that marks `id` as deleted. Older versions
    /// remain in the log but `latest_by_id` surfaces the tombstone.
    pub fn delete(data_home: &str, id: u64) -> std::io::Result<bool> {
        let latest = latest_by_id(data_home);
        let Some(mut rec) = latest.get(&id).cloned() else { return Ok(false); };
        if rec.deleted { return Ok(false); }
        rec.updated_at = now_ms();
        rec.deleted = true;
        let path = file_path(data_home);
        let _g = write_lock().lock().unwrap();
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        f.write_all(serialise(&rec).as_bytes())?;
        Ok(true)
    }

    /// Appends an update record. None-valued fields preserve previous value.
    pub fn update(
        data_home: &str,
        id: u64,
        text: Option<String>,
        tags: Option<Vec<String>>,
        importance: Option<u8>,
    ) -> std::io::Result<bool> {
        let latest = latest_by_id(data_home);
        let Some(mut rec) = latest.get(&id).cloned() else { return Ok(false); };
        if rec.deleted { return Ok(false); }
        if let Some(t) = text { rec.text = t; }
        if let Some(ts) = tags { rec.tags = ts; }
        if let Some(imp) = importance { rec.importance = imp.clamp(1, 10); }
        rec.updated_at = now_ms();
        let path = file_path(data_home);
        let _g = write_lock().lock().unwrap();
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        f.write_all(serialise(&rec).as_bytes())?;
        Ok(true)
    }

    fn matches_filter(rec: &Record, f: &Filter) -> bool {
        if rec.deleted { return false; }
        if let Some(s) = &f.scope { if &rec.scope != s { return false; } }
        if let Some(u) = &f.user_id { if rec.user_id.as_deref() != Some(u.as_str()) { return false; } }
        if let Some(s) = &f.session_id { if rec.session_id.as_deref() != Some(s.as_str()) { return false; } }
        if let Some(a) = &f.agent_id { if rec.agent_id.as_deref() != Some(a.as_str()) { return false; } }
        if let Some(t) = &f.tag { if !rec.tags.iter().any(|x| x == t) { return false; } }
        true
    }

    fn render_array(items: &[Record]) -> String {
        let body = items
            .iter()
            .map(|r| serialise(r).trim_end_matches('\n').to_string())
            .collect::<Vec<_>>()
            .join(",");
        format!("[{body}]")
    }

    /// Returns non-deleted records matching filter, newest first, capped
    /// at `limit` (default 200).
    pub fn list_json(data_home: &str, filter: &Filter) -> String {
        let map = latest_by_id(data_home);
        let mut items: Vec<Record> = map
            .into_values()
            .filter(|r| matches_filter(r, filter))
            .collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let limit = filter.limit.unwrap_or(200).min(1000);
        items.truncate(limit);
        render_array(&items)
    }

    /// Keyword BM25-lite scoring. We avoid pulling a dependency by using
    /// a TF-weighted term overlap with importance boosting:
    ///   score = Σ(tf_in_record * idf) + importance/10
    /// where idf = log(1 + N / (1 + df)).
    pub fn search_json(
        data_home: &str,
        query: &str,
        filter: &Filter,
        top_k: usize,
    ) -> String {
        fn tokenise(text: &str) -> Vec<String> {
            text.to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .filter(|t| !t.is_empty() && t.len() > 1)
                .map(|t| t.to_string())
                .collect()
        }
        let map = latest_by_id(data_home);
        let candidates: Vec<Record> = map
            .into_values()
            .filter(|r| matches_filter(r, filter))
            .collect();
        if candidates.is_empty() {
            return String::from("[]");
        }
        let q_terms = tokenise(query);
        if q_terms.is_empty() {
            return list_json(data_home, filter);
        }
        let n = candidates.len() as f64;
        // document frequencies
        let mut df: HashMap<String, f64> = HashMap::new();
        let doc_tokens: Vec<(u64, Vec<String>)> = candidates
            .iter()
            .map(|r| {
                let mut toks = tokenise(&r.text);
                toks.extend(r.tags.iter().flat_map(|t| tokenise(t)));
                let mut seen: HashMap<&str, ()> = HashMap::new();
                for t in &toks {
                    if seen.insert(t.as_str(), ()).is_none() {
                        *df.entry(t.clone()).or_insert(0.0) += 1.0;
                    }
                }
                (r.id, toks)
            })
            .collect();
        let scored: Vec<(f64, Record)> = candidates
            .into_iter()
            .map(|r| {
                let toks = &doc_tokens.iter().find(|(id, _)| *id == r.id).map(|(_, t)| t.clone()).unwrap_or_default();
                let mut score = 0.0_f64;
                for q in &q_terms {
                    let tf = toks.iter().filter(|t| *t == q).count() as f64;
                    if tf == 0.0 { continue; }
                    let d = *df.get(q).unwrap_or(&0.0);
                    let idf = (1.0 + n / (1.0 + d)).ln();
                    score += tf * idf;
                }
                if score > 0.0 {
                    score += r.importance as f64 / 20.0; // gentle boost
                }
                (score, r)
            })
            .filter(|(s, _)| *s > 0.0)
            .collect();
        let mut scored = scored;
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let k = top_k.clamp(1, 100).min(scored.len());
        let body = scored
            .into_iter()
            .take(k)
            .map(|(score, r)| {
                let line = serialise(&r);
                let stripped = line.trim_end_matches('\n').trim_end_matches('}');
                format!("{stripped},\"score\":{score:.4}}}")
            })
            .collect::<Vec<_>>()
            .join(",");
        format!("[{body}]")
    }

    /// Rewrites the file dropping tombstones and earlier versions of
    /// updated records. Returns (kept, dropped).
    pub fn compact(data_home: &str) -> std::io::Result<(usize, usize)> {
        let _g = write_lock().lock().unwrap();
        let map = latest_by_id(data_home);
        let alive: Vec<Record> = map.into_values().filter(|r| !r.deleted).collect();
        let dropped = {
            let path = file_path(data_home);
            let total = fs::read_to_string(&path)
                .map(|s| s.lines().count())
                .unwrap_or(0);
            total.saturating_sub(alive.len())
        };
        let path = file_path(data_home);
        let mut buf = String::new();
        for r in &alive { buf.push_str(&serialise(r)); }
        fs::write(&path, buf)?;
        Ok((alive.len(), dropped))
    }

    pub fn clear(data_home: &str) -> std::io::Result<()> {
        let _g = write_lock().lock().unwrap();
        let path = file_path(data_home);
        if path.exists() { fs::remove_file(&path)?; }
        // reset id seed so a fresh run starts at 1
        SEED_DONE.get_or_init(|| ());
        NEXT_ID.store(0, Ordering::Relaxed);
        Ok(())
    }
}

/// In-memory agent task registry for long-running supervision. Entries are
/// keyed by caller-supplied task_id. This is intentionally process-local
/// (not persisted) — operators use metrics for cross-restart durability.
mod agent_tasks {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Clone)]
    pub struct TaskRecord {
        pub id: String,
        pub title: String,
        pub started_at: u128,
        pub last_heartbeat: u128,
        pub status: String,
    }

    static REGISTRY: OnceLock<Mutex<HashMap<String, TaskRecord>>> = OnceLock::new();

    fn registry() -> &'static Mutex<HashMap<String, TaskRecord>> {
        REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn now_ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    fn escape(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        for ch in value.chars() {
            match ch {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out
    }

    /// Starts or replaces a task. Returns true if a new task was created.
    pub fn start(id: &str, title: &str) -> bool {
        let mut g = registry().lock().unwrap();
        let now = now_ms();
        let is_new = !g.contains_key(id);
        g.insert(
            id.to_string(),
            TaskRecord {
                id: id.to_string(),
                title: title.to_string(),
                started_at: now,
                last_heartbeat: now,
                status: String::from("running"),
            },
        );
        is_new
    }

    pub fn heartbeat(id: &str) -> bool {
        let mut g = registry().lock().unwrap();
        if let Some(rec) = g.get_mut(id) {
            rec.last_heartbeat = now_ms();
            true
        } else {
            false
        }
    }

    pub fn finish(id: &str, status: &str) -> bool {
        let mut g = registry().lock().unwrap();
        if let Some(rec) = g.get_mut(id) {
            rec.status = status.to_string();
            rec.last_heartbeat = now_ms();
            true
        } else {
            false
        }
    }

    pub fn list_json() -> String {
        let g = registry().lock().unwrap();
        let mut items: Vec<String> = Vec::new();
        for rec in g.values() {
            items.push(format!(
                "{{\"id\":\"{id}\",\"title\":\"{title}\",\"startedAt\":{started},\"lastHeartbeat\":{hb},\"status\":\"{status}\"}}",
                id = escape(&rec.id),
                title = escape(&rec.title),
                started = rec.started_at,
                hb = rec.last_heartbeat,
                status = escape(&rec.status)
            ));
        }
        format!("[{}]", items.join(","))
    }

    pub fn active_count() -> u64 {
        let g = registry().lock().unwrap();
        g.values().filter(|r| r.status == "running").count() as u64
    }
}

/// Simple sliding-window rate limiter keyed by client address string.
struct RateLimiter {
    windows: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `true` if the request is allowed, `false` if rate-limited.
    fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let cutoff = now - std::time::Duration::from_secs(1);
        let mut map = self.windows.lock().unwrap();
        let timestamps = map.entry(key.to_string()).or_default();
        timestamps.retain(|t| *t > cutoff);
        if timestamps.len() >= RATE_LIMIT_PER_SEC {
            return false;
        }
        timestamps.push(now);
        true
    }
}

static RATE_LIMITER: OnceLock<RateLimiter> = OnceLock::new();

fn rate_limiter() -> &'static RateLimiter {
    RATE_LIMITER.get_or_init(RateLimiter::new)
}

pub type AppRuntime = OctocodeRuntime<RuntimeProviderRouter<BuiltinProvider>, FileSessionStore, WorkspaceToolExecutor>;

static SHARED_TASK_STORE: OnceLock<TaskStore> = OnceLock::new();
static SHARED_COORDINATOR: OnceLock<CoordinatorEngine> = OnceLock::new();
static SERVER_AUTH_TOKEN: OnceLock<String> = OnceLock::new();

fn is_stream_cancelled(error: &OctoError) -> bool {
    matches!(error, OctoError::Runtime(message) if message == "stream cancelled")
}

fn shared_task_store() -> TaskStore {
    SHARED_TASK_STORE.get_or_init(TaskStore::new).clone()
}

fn shared_coordinator() -> CoordinatorEngine {
    SHARED_COORDINATOR
        .get_or_init(CoordinatorEngine::new)
        .clone()
}

/// Generate a cryptographically random hex token for server auth.
fn generate_auth_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("getrandom failed");
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// T1 (release-hardening): resolve the WebUI bearer token. Priority:
///
/// 1. `OCTOCODE_BEARER_TOKEN` environment variable (operators inject via
///    systemd / docker / launchd).
/// 2. `OCTOCODE_BEARER_TOKEN_FILE` env var pointing at a file whose
///    trimmed contents are the token (lets the operator chmod 600 a
///    secret file separately).
/// 3. Fresh `getrandom` token, printed once on stdout (current dev
///    behaviour, kept as the safe default).
///
/// Once resolved, the value is memoised in [`SERVER_AUTH_TOKEN`] so the
/// rest of the request lifecycle never re-reads disk / env.
fn resolve_auth_token() -> String {
    if let Ok(token) = std::env::var("OCTOCODE_BEARER_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(path) = std::env::var("OCTOCODE_BEARER_TOKEN_FILE") {
        if let Ok(content) = std::fs::read_to_string(&path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    generate_auth_token()
}

fn get_server_token() -> &'static str {
    SERVER_AUTH_TOKEN.get_or_init(resolve_auth_token)
}

/// Validate the auth token from request headers.
/// Returns true if auth is valid or auth is disabled (no token set).
fn check_auth(headers: &HashMap<String, String>) -> bool {
    let expected = get_server_token();
    // Allow requests from the same-origin WebUI (served by us)
    // by checking the Authorization header or x-auth-token header.
    if let Some(auth) = headers.get("authorization") {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return token.trim() == expected;
        }
    }
    if let Some(token) = headers.get("x-auth-token") {
        return token.trim() == expected;
    }
    false
}

fn summarize_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return String::from(value);
    }
    let mut out = value.chars().take(max_chars).collect::<String>();
    out.push_str(" ...");
    out
}

fn execute_async_task(runtime: &AppRuntime, session_id: &str, kind: TaskKind, label: &str) -> Result<String, OctoError> {
    match kind {
        TaskKind::Workflow => {
            let result = runtime.run_tool_in_session(
                session_id,
                ToolCall {
                    name: String::from("workflow-plan"),
                    input: String::from(label),
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            Ok(format!("workflow completed: {}", summarize_text(&result.output, 220)))
        }
        TaskKind::Agent => {
            let result = runtime.agent_action_in_session(session_id, label)?;
            Ok(format!("agent completed: {}", summarize_text(&result.output, 220)))
        }
        TaskKind::Tool => {
            let (tool_name, tool_input) = if let Some((name, input)) = label.split_once('|') {
                let parsed_name = name.trim();
                if parsed_name.is_empty() {
                    (String::from("echo"), String::from(input.trim()))
                } else {
                    (String::from(parsed_name), String::from(input.trim()))
                }
            } else {
                (String::from("echo"), String::from(label))
            };

            if tool_name.starts_with("task-") || tool_name.starts_with("team-") {
                return Err(OctoError::Runtime(format!(
                    "tool task does not support recursive orchestration tool '{}'",
                    tool_name
                )));
            }

            let result = runtime.run_tool_in_session(
                session_id,
                ToolCall {
                    name: tool_name.clone(),
                    input: tool_input,
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            Ok(format!(
                "tool {} completed: {}",
                tool_name,
                summarize_text(&result.output, 220)
            ))
        }
    }
}

fn start_async_task_worker(
    workspace_root: String,
    task_id: String,
    session_id: String,
    kind: TaskKind,
    label: String,
) {
    thread::spawn(move || {
        let run = || -> Result<(), Box<dyn std::error::Error>> {
            let platform = NativePlatform::detect(workspace_root.clone());
            let loader = ConfigLoader::new(platform.config_paths());
            let config = cached_config_load(&loader)?;
            let runtime = build_runtime(workspace_root.clone(), config)?;

            let _ = runtime.task_start(&task_id, Some(String::from("worker started")));
            match execute_async_task(&runtime, &session_id, kind.clone(), &label) {
                Ok(summary) => {
                    let _ = runtime.task_finish(&task_id, TaskState::Done, Some(summary));
                }
                Err(error) => {
                    let _ = runtime.task_finish(
                        &task_id,
                        TaskState::Failed,
                        Some(error.to_string()),
                    );
                }
            }
            Ok(())
        };

        if let Err(error) = run() {
            eprintln!("async task worker failed (task={}): {}", task_id, error);
        }
    });
}

pub fn build_runtime(
    workspace_root: String,
    config: RuntimeConfig,
) -> Result<AppRuntime, Box<dyn std::error::Error>> {
    let platform = NativePlatform::detect(workspace_root);
    let registry = ProviderRegistry::new();
    let store = FileSessionStore::new(&platform.config_paths())?;
    let mut runtime = OctocodeRuntime::new(
        RuntimeProviderRouter::from_factory(&registry, &config)?,
        store,
        WorkspaceToolExecutor::with_shell(
            platform.context().root.clone(),
            platform.context().preferred_shell.clone(),
        ),
        platform.context().clone(),
        registry.descriptors().to_vec(),
    );
    runtime.task_store = shared_task_store();
    runtime.coordinator = shared_coordinator();
    Ok(runtime)
}

/// Fixed-size thread pool for handling concurrent HTTP connections.
struct ThreadPool {
    workers: Vec<thread::JoinHandle<()>>,
    sender: Option<mpsc::Sender<Box<dyn FnOnce() + Send + 'static>>>,
}

impl ThreadPool {
    fn new(size: usize) -> Self {
        let (sender, receiver) = mpsc::channel::<Box<dyn FnOnce() + Send + 'static>>();
        let receiver = Arc::new(std::sync::Mutex::new(receiver));
        let mut workers = Vec::with_capacity(size);

        for _ in 0..size {
            let receiver = Arc::clone(&receiver);
            let handle = thread::spawn(move || loop {
                let job = {
                    let lock = receiver.lock().expect("thread pool mutex poisoned");
                    lock.recv()
                };
                match job {
                    Ok(job) => job(),
                    Err(_) => break, // channel closed, shut down
                }
            });
            workers.push(handle);
        }

        ThreadPool {
            workers,
            sender: Some(sender),
        }
    }

    fn execute<F: FnOnce() + Send + 'static>(&self, f: F) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(Box::new(f));
        }
    }
}

impl Drop for ThreadPool {
    fn drop(&mut self) {
        // Drop the sender to signal workers to stop
        drop(self.sender.take());
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

/// Number of worker threads for the HTTP server.
const THREAD_POOL_SIZE: usize = 8;

const FS_MAX_RESULTS: usize = 400;
const FS_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const FS_SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
];

pub fn run_server(
    port: u16,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    if !is_allowed_web_port(port) {
        return Err(format!(
            "port {} is out of allowed range {}-{}",
            port, WEB_PORT_MIN, WEB_PORT_MAX
        )
        .into());
    }

    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;

    // Generate and display auth token for API access
    let token = get_server_token();
    let token_source = if std::env::var("OCTOCODE_BEARER_TOKEN").is_ok() {
        "OCTOCODE_BEARER_TOKEN env"
    } else if std::env::var("OCTOCODE_BEARER_TOKEN_FILE").is_ok() {
        "OCTOCODE_BEARER_TOKEN_FILE env"
    } else {
        "auto-generated"
    };
    println!("Octocode WebUI ready on port {port} (thread pool: {THREAD_POOL_SIZE} workers)");
    println!("Auth token: {token} (source: {token_source})");

    // Write token to a file for the WebUI to read
    let token_path = std::env::temp_dir().join(format!("octocode-auth-{port}.token"));
    let _ = fs::write(&token_path, token);

    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let flag = Arc::clone(&shutdown);
        ctrlc::set_handler(move || {
            eprintln!("\nreceived Ctrl+C, shutting down...");
            flag.store(true, Ordering::SeqCst);
        })?;
    }

    let pool = ThreadPool::new(THREAD_POOL_SIZE);
    let session_id = Arc::new(initial_session_id);

    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                let session_id = Arc::clone(&session_id);
                pool.execute(move || {
                    let sid = (*session_id).clone();
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handle_connection(stream, sid)
                    }));
                    match result {
                        Ok(Err(error)) => {
                            let msg = error.to_string();
                            // Suppress noise from empty/scanner connections and localized
                            // socket reset/abort errors when the peer closes early.
                            if !should_suppress_request_error(error.as_ref()) {
                                eprintln!("server error: {msg}");
                            }
                        }
                        Err(_) => eprintln!("server panic: request handler panicked — worker recovered"),
                        Ok(Ok(())) => {}
                    }
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => eprintln!("accept error: {error}"),
        }
    }

    println!("Octocode server shutting down gracefully...");
    drop(pool);
    println!("Octocode server stopped.");
    Ok(())
}

fn default_session_id() -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("session-{stamp}")
}

fn create_session(store: &FileSessionStore, title: Option<String>) -> Result<String, OctoError> {
    let session_id = default_session_id();
    let session_title = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("New Session");

    store.save_session(SessionSummary {
        id: session_id.clone(),
        title: String::from(session_title),
        model: None,
        parent_id: None,
        branch_name: None,
        total_input_tokens: 0,
        total_output_tokens: 0,
    })?;
    Ok(session_id)
}

fn ensure_session_exists(store: &FileSessionStore) -> Result<String, OctoError> {
    if let Some(existing) = store.list_sessions()?.into_iter().next() {
        return Ok(existing.id);
    }

    create_session(store, None)
}

fn resolve_fs_path(workspace_root: &Path, raw: Option<&str>, must_exist: bool) -> Result<PathBuf, OctoError> {
    let candidate = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.to_path_buf());
    let full_path = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    };

    if must_exist {
        return fs::canonicalize(&full_path).map_err(|error| {
            OctoError::Runtime(format!(
                "failed to resolve path {}: {error}",
                full_path.display()
            ))
        });
    }

    if let Some(parent) = full_path.parent() {
        if parent.exists() {
            let canonical_parent = fs::canonicalize(parent).map_err(|error| {
                OctoError::Runtime(format!(
                    "failed to resolve parent path {}: {error}",
                    parent.display()
                ))
            })?;
            if let Some(name) = full_path.file_name() {
                return Ok(canonical_parent.join(name));
            }
        }
    }

    Ok(full_path)
}

fn entry_modified_ms(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
}

fn should_skip_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|name| FS_SKIP_DIRS.contains(&name))
        .unwrap_or(false)
}

fn list_fs_entries(path: &Path) -> Result<Vec<serde_json::Value>, OctoError> {
    let entries = fs::read_dir(path).map_err(|error| {
        OctoError::Runtime(format!("failed to read directory {}: {error}", path.display()))
    })?;
    let mut items = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| {
            OctoError::Runtime(format!("failed to read directory entry: {error}"))
        })?;
        let entry_path = entry.path();
        let metadata = entry.metadata().map_err(|error| {
            OctoError::Runtime(format!(
                "failed to read metadata {}: {error}",
                entry_path.display()
            ))
        })?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        let is_dir = metadata.is_dir();
        items.push((
            is_dir,
            file_name.to_ascii_lowercase(),
            serde_json::json!({
                "name": file_name,
                "path": entry_path.display().to_string(),
                "kind": if is_dir { "directory" } else { "file" },
                "size": if metadata.is_file() { Some(metadata.len()) } else { None },
                "modifiedAtMs": entry_modified_ms(&metadata),
                "hidden": entry_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|name| name.starts_with('.'))
                    .unwrap_or(false),
            }),
        ));
    }

    items.sort_by(|left, right| {
        if left.0 != right.0 {
            if left.0 {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            left.1.cmp(&right.1)
        }
    });

    Ok(items.into_iter().map(|(_, _, item)| item).collect())
}

fn search_text_in_path(
    path: &Path,
    query: &str,
    results: &mut Vec<serde_json::Value>,
) -> Result<(), OctoError> {
    if results.len() >= FS_MAX_RESULTS {
        return Ok(());
    }

    let metadata = fs::metadata(path).map_err(|error| {
        OctoError::Runtime(format!("failed to read metadata {}: {error}", path.display()))
    })?;

    if metadata.is_dir() {
        if should_skip_dir(path) {
            return Ok(());
        }
        let entries = fs::read_dir(path).map_err(|error| {
            OctoError::Runtime(format!("failed to read directory {}: {error}", path.display()))
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                OctoError::Runtime(format!("failed to read directory entry: {error}"))
            })?;
            search_text_in_path(&entry.path(), query, results)?;
            if results.len() >= FS_MAX_RESULTS {
                break;
            }
        }
        return Ok(());
    }

    if metadata.len() > FS_MAX_FILE_BYTES {
        return Ok(());
    }

    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return Ok(()),
    };

    for (line_index, line) in content.lines().enumerate() {
        let mut start = 0usize;
        while let Some(offset) = line[start..].find(query) {
            let column = start + offset + 1;
            results.push(serde_json::json!({
                "path": path.display().to_string(),
                "line": line_index + 1,
                "column": column,
                "snippet": line.trim(),
            }));
            start += offset + query.len().max(1);
            if results.len() >= FS_MAX_RESULTS {
                return Ok(());
            }
        }
    }

    Ok(())
}

fn replace_text_in_path(
    path: &Path,
    old_text: &str,
    new_text: &str,
    changed_files: &mut Vec<serde_json::Value>,
) -> Result<usize, OctoError> {
    let metadata = fs::metadata(path).map_err(|error| {
        OctoError::Runtime(format!("failed to read metadata {}: {error}", path.display()))
    })?;

    if metadata.is_dir() {
        if should_skip_dir(path) {
            return Ok(0);
        }
        let entries = fs::read_dir(path).map_err(|error| {
            OctoError::Runtime(format!("failed to read directory {}: {error}", path.display()))
        })?;
        let mut total = 0usize;
        for entry in entries {
            let entry = entry.map_err(|error| {
                OctoError::Runtime(format!("failed to read directory entry: {error}"))
            })?;
            total += replace_text_in_path(&entry.path(), old_text, new_text, changed_files)?;
        }
        return Ok(total);
    }

    if metadata.len() > FS_MAX_FILE_BYTES {
        return Ok(0);
    }

    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return Ok(0),
    };

    let replacements = content.matches(old_text).count();
    if replacements == 0 {
        return Ok(0);
    }

    let updated = content.replace(old_text, new_text);
    fs::write(path, updated).map_err(|error| {
        OctoError::Runtime(format!("failed to write file {}: {error}", path.display()))
    })?;
    changed_files.push(serde_json::json!({
        "path": path.display().to_string(),
        "replacements": replacements,
    }));
    Ok(replacements)
}

fn manage_catalog_json(runtime: &AppRuntime) -> Result<String, Box<dyn std::error::Error>> {
    let workspace_root = runtime.workspace().root.clone();
    let config_paths = runtime.config_paths();
    let workspace_root_path = PathBuf::from(&workspace_root);
    let config_home_path = PathBuf::from(&config_paths.config_home);
    let provider_profiles = manage_config::load_provider_profiles(&config_home_path)?;
    let hook_items = manage_config::list_hook_items(&workspace_root_path, &config_home_path)?;
    let external_catalog = manage_config::load_external_catalog(&workspace_root_path, &config_home_path)?;
    let mcp_servers = runtime
        .mcp_servers()?
        .into_iter()
        .map(|server| {
            let manifest_path = PathBuf::from(&server.descriptor.manifest_path);
            let scope = infer_manage_scope(&manifest_path, &workspace_root_path, &config_home_path);
            serde_json::json!({
                "descriptor": {
                    "id": server.descriptor.id,
                    "transport": server.descriptor.transport,
                    "command": server.descriptor.command,
                    "endpoint": server.descriptor.endpoint,
                    "description": server.descriptor.description,
                    "manifestPath": server.descriptor.manifest_path,
                    "trusted": server.descriptor.trusted,
                },
                "state": server.state,
                "detail": server.detail,
                "scope": scope,
                "manifestContent": fs::read_to_string(&manifest_path).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    let skills = runtime
        .skills()?
        .into_iter()
        .map(|skill| {
            let path = PathBuf::from(&skill.path);
            serde_json::json!({
                "id": skill.id,
                "summary": skill.summary,
                "path": skill.path,
                "scope": skill.scope,
                "content": fs::read_to_string(path).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    let tools = runtime
        .tools()
        .iter()
        .map(|tool| {
            serde_json::json!({
                "name": tool.name,
                "summary": tool.summary,
                "minimumPermission": format!("{:?}", tool.minimum_permission).to_ascii_lowercase().replace("readonly", "read-only").replace("workspacewrite", "workspace-write").replace("dangerfullaccess", "danger-full-access"),
                "isCustom": false,
            })
        })
        .chain(external_catalog.tools.iter().map(|tool| {
            serde_json::json!({
                "name": tool.name,
                "summary": tool.summary,
                "minimumPermission": tool.minimum_permission,
                "commandTemplate": tool.command_template,
                "scope": tool.scope,
                "sourcePath": tool.source_path,
                "isCustom": true,
            })
        }))
        .collect::<Vec<_>>();
    let commands = runtime
        .commands()
        .iter()
        .map(|command| {
            serde_json::json!({
                "name": command.name,
                "summary": command.summary,
                "isCustom": false,
            })
        })
        .chain(external_catalog.commands.iter().map(|command| {
            serde_json::json!({
                "name": command.name,
                "summary": command.summary,
                "template": command.template,
                "scope": command.scope,
                "sourcePath": command.source_path,
                "isCustom": true,
            })
        }))
        .collect::<Vec<_>>();

    Ok(serde_json::json!({
        "workspace": runtime.workspace(),
        "paths": config_paths,
        "settingsPath": runtime.config_file_path(),
        "providers": runtime.provider_routes(),
        "providerProfiles": provider_profiles,
        "tools": tools,
        "commands": commands,
        "skills": skills,
        "mcpServers": mcp_servers,
        "hooks": {
            "items": hook_items,
        },
    })
    .to_string())
}

fn infer_manage_scope(path: &Path, workspace_root: &Path, config_home: &Path) -> &'static str {
    if path.starts_with(config_home) {
        return "user";
    }
    if path.starts_with(workspace_root) {
        return "workspace";
    }
    "workspace"
}

fn form_flag(request: &HttpRequest, name: &str) -> bool {
    request
        .form_value(name)
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn permission_mode_from_str(value: &str) -> PermissionMode {
    match value.trim() {
        "read-only" => PermissionMode::ReadOnly,
        "danger-full-access" => PermissionMode::DangerFullAccess,
        _ => PermissionMode::WorkspaceWrite,
    }
}

fn expand_custom_template(template: &str, input: &str) -> String {
    if template.contains("{input}") {
        return template.replace("{input}", input);
    }
    if template.contains("{args}") {
        return template.replace("{args}", input);
    }
    if input.trim().is_empty() {
        String::from(template)
    } else {
        format!("{} {}", template.trim(), input.trim())
    }
}

fn execute_custom_tool_if_configured(
    runtime: &AppRuntime,
    workspace_root: &str,
    config_home: &str,
    session_id: &str,
    name: &str,
    input: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let catalog = manage_config::load_external_catalog(Path::new(workspace_root), Path::new(config_home))?;
    let Some(tool) = catalog.tools.into_iter().find(|entry| entry.name == name) else {
        return Ok(false);
    };
    let command_line = expand_custom_template(&tool.command_template, input);
    runtime.run_shell_command_in_session(
        session_id,
        &tool.name,
        &command_line,
        permission_mode_from_str(&tool.minimum_permission),
    )?;
    Ok(true)
}

fn resolve_custom_command(
    workspace_root: &str,
    config_home: &str,
    action: &str,
    args: &str,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let catalog = manage_config::load_external_catalog(Path::new(workspace_root), Path::new(config_home))?;
    Ok(catalog
        .commands
        .into_iter()
        .find(|entry| entry.name == action)
        .map(|entry| expand_custom_template(&entry.template, args)))
}

fn form_usize(request: &HttpRequest, name: &str) -> Result<Option<usize>, Box<dyn std::error::Error>> {
    match request.form_value(name) {
        Some(value) if !value.trim().is_empty() => Ok(Some(value.trim().parse::<usize>().map_err(|error| {
            OctoError::Runtime(format!("invalid {}: {error}", name))
        })?)),
        _ => Ok(None),
    }
}

fn refresh_manage_catalog(
    workspace_root: String,
    config: RuntimeConfig,
) -> Result<String, Box<dyn std::error::Error>> {
    let runtime = build_runtime(workspace_root, config)?;
    json_response(manage_catalog_json(&runtime)?)
}

fn handle_manage_upsert(
    request: &HttpRequest,
    workspace_root: String,
    config_home: String,
    config: RuntimeConfig,
) -> Result<String, Box<dyn std::error::Error>> {
    let workspace_root_path = PathBuf::from(&workspace_root);
    let config_home_path = PathBuf::from(&config_home);
    let kind = request
        .form_value("kind")
        .unwrap_or_default()
        .trim()
        .to_string();

    match kind.as_str() {
        "providerProfile" => {
            manage_config::upsert_provider_profile(
                &config_home_path,
                request.form_value("originalId").as_deref(),
                manage_config::ProviderProfile {
                    id: request.form_value("id").unwrap_or_default(),
                    display_name: request.form_value("displayName").unwrap_or_default(),
                    provider_id: request.form_value("providerId").unwrap_or_default(),
                    provider_base_url: request.form_value("providerBaseUrl"),
                    default_model: request.form_value("defaultModel"),
                },
            )?;
        }
        "mcp" => {
            manage_config::upsert_mcp_manifest(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("originalId").as_deref(),
                request.form_value("originalPath").as_deref(),
                request.form_value("id").as_deref().unwrap_or(""),
                request.form_value("transport").as_deref().unwrap_or("stdio"),
                request.form_value("command"),
                request.form_value("endpoint"),
                request.form_value("description"),
                form_flag(request, "trusted"),
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        "skill" => {
            manage_config::upsert_skill(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("originalId").as_deref(),
                request.form_value("originalPath").as_deref(),
                request.form_value("id").as_deref().unwrap_or(""),
                request.form_value("summary"),
                request.form_value("content"),
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        "hook" => {
            manage_config::upsert_hook(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("tool"),
                request.form_value("command").unwrap_or_default(),
                request.form_value("timing").unwrap_or_else(|| String::from("before")),
                form_flag(request, "blocking"),
                request
                    .form_value("timeoutMs")
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .unwrap_or(5000),
                request.form_value("originalTool"),
                form_usize(request, "originalIndex")?,
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        "externalTool" => {
            let runtime = build_runtime(workspace_root.clone(), config.clone())?;
            let name = request.form_value("name").unwrap_or_default();
            if runtime.tools().iter().any(|tool| tool.name == name.trim()) {
                return error_response(400, "tool name conflicts with a built-in tool");
            }
            manage_config::upsert_external_tool(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("originalName").as_deref(),
                manage_config::ExternalToolConfig {
                    scope: request.form_value("scope").unwrap_or_else(|| String::from("user")),
                    name,
                    summary: request.form_value("summary").unwrap_or_default(),
                    command_template: request.form_value("commandTemplate").unwrap_or_default(),
                    minimum_permission: request.form_value("minimumPermission").unwrap_or_else(|| String::from("danger-full-access")),
                    source_path: String::new(),
                },
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        "externalCommand" => {
            let runtime = build_runtime(workspace_root.clone(), config.clone())?;
            let name = request.form_value("name").unwrap_or_default();
            if runtime.commands().iter().any(|command| command.name == name.trim()) {
                return error_response(400, "command name conflicts with a built-in command");
            }
            manage_config::upsert_external_command(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("originalName").as_deref(),
                manage_config::ExternalCommandConfig {
                    scope: request.form_value("scope").unwrap_or_else(|| String::from("user")),
                    name,
                    summary: request.form_value("summary").unwrap_or_default(),
                    template: request.form_value("template").unwrap_or_default(),
                    source_path: String::new(),
                },
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        _ => {
            return error_response(400, "unsupported manage kind");
        }
    }

    refresh_manage_catalog(workspace_root, config)
}

fn handle_manage_delete(
    request: &HttpRequest,
    workspace_root: String,
    config_home: String,
    config: RuntimeConfig,
) -> Result<String, Box<dyn std::error::Error>> {
    let workspace_root_path = PathBuf::from(&workspace_root);
    let config_home_path = PathBuf::from(&config_home);
    let kind = request
        .form_value("kind")
        .unwrap_or_default()
        .trim()
        .to_string();

    match kind.as_str() {
        "providerProfile" => {
            manage_config::delete_provider_profile(
                &config_home_path,
                request.form_value("id").as_deref().unwrap_or(""),
            )?;
        }
        "mcp" => {
            manage_config::delete_mcp_manifest(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("id").as_deref().unwrap_or(""),
                request.form_value("originalPath").as_deref(),
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        "skill" => {
            manage_config::delete_skill(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("id").as_deref().unwrap_or(""),
                request.form_value("originalPath").as_deref(),
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        "hook" => {
            let index = form_usize(request, "index")?
                .ok_or_else(|| OctoError::Runtime(String::from("missing hook index")))?;
            manage_config::delete_hook(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("tool"),
                index,
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        "externalTool" => {
            manage_config::delete_external_tool(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("name").as_deref().unwrap_or(""),
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        "externalCommand" => {
            manage_config::delete_external_command(
                request.form_value("scope").as_deref().unwrap_or("user"),
                request.form_value("name").as_deref().unwrap_or(""),
                &workspace_root_path,
                &config_home_path,
            )?;
        }
        _ => {
            return error_response(400, "unsupported manage kind");
        }
    }

    refresh_manage_catalog(workspace_root, config)
}

fn handle_connection(
    mut stream: TcpStream,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Accepted sockets may inherit non-blocking mode from the listener on
    // some platforms; force blocking so reads wait for data.
    stream.set_nonblocking(false)?;
    // Timeout so stale / scanner connections don't block a worker forever.
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;

    let request = match read_http_request(&mut stream) {
        Ok(req) => req,
        Err(err) => {
            // Empty / malformed connections (port scanners, pre-connect) are
            // expected — silently drop them instead of printing a scary error.
            return Err(err);
        }
    };

    // CORS preflight
    if request.method == "OPTIONS" {
        let preflight = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: http://127.0.0.1\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization, X-Auth-Token\r\nAccess-Control-Max-Age: 86400\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        stream.write_all(preflight.as_bytes())?;
        stream.flush()?;
        return Ok(());
    }

    // P11-C: count every non-preflight request before auth so we can observe
    // attempted traffic even when it is rejected.
    METRICS_REQUESTS_TOTAL.fetch_add(1, Ordering::Relaxed);

    // Auth check for API endpoints (exempt: health, static assets, token endpoint)
    let requires_auth = request.path.starts_with("/api/")
        && request.path != "/api/health"
        && request.path != "/api/auth-token";
    if requires_auth && !check_auth(&request.headers) {
        let body = r#"{"error":"unauthorized","message":"missing or invalid auth token"}"#;
        let response = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes())?;
        stream.flush()?;
        return Ok(());
    }

    // Rate limiting for API endpoints
    if request.path.starts_with("/api/") {
        let client_key = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
        if !rate_limiter().check(&client_key) {
            let body = r#"{"error":"rate_limited","message":"too many requests"}"#;
            let response = format!(
                "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes())?;
            stream.flush()?;
            return Ok(());
        }
    }

    // SSE streaming endpoint — needs direct stream access
    if request.method == "GET" && request.path == "/api/stream" {
        return handle_sse_stream(&mut stream, &request, initial_session_id);
    }

    if request.method == "GET" && request.path == "/terminal/ws" {
        let token = request.query_value("token").unwrap_or_default();
        if token.trim() != get_server_token() {
            let body = r#"{"error":"unauthorized","message":"missing or invalid terminal token"}"#;
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes())?;
            stream.flush()?;
            return Ok(());
        }
        return handle_terminal_ws(&mut stream, &request);
    }

    // WebSocket upgrade
    if request.method == "GET"
        && request.path == "/ws"
        && request
            .headers
            .get("upgrade")
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    {
        return handle_ws_upgrade(&mut stream, &request, initial_session_id);
    }

    let response = match route_request(&request, initial_session_id) {
        Ok(r) => r,
        Err(err) => {
            let msg = format!("{err}");
            METRICS_ERRORS_TOTAL.fetch_add(1, Ordering::Relaxed);
            error_response(500, &msg)?
        }
    };
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn handle_sse_stream(
    stream: &mut TcpStream,
    request: &HttpRequest,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let session_id = request
        .query_value("session")
        .or(initial_session_id)
        .unwrap_or_else(|| String::from("demo"));
    let text = request.query_value("text").unwrap_or_default();

    let workspace_root = String::from(".");
    let platform = NativePlatform::detect(workspace_root.clone());
    let loader = ConfigLoader::new(platform.config_paths());
    let config = cached_config_load(&loader)?;
    let runtime = build_runtime(workspace_root, config)?;

    // P0-L2: spawn keep-alive heartbeat (SSE comment every 15 s). The thread
    // writes to a cloned socket so it can interleave with the token stream
    // without locking — SSE allows interleaved comment/data lines.
    let heartbeat = spawn_sse_heartbeat(stream, Duration::from_secs(15));
    let result = write_sse_stream_response(stream, &runtime, &session_id, &text);
    heartbeat.stop();
    result
}

fn write_sse_stream_response<P, S, T, W>(
    stream: &mut W,
    runtime: &OctocodeRuntime<P, S, T>,
    session_id: &str,
    text: &str,
) -> Result<(), Box<dyn std::error::Error>>
where
    P: ModelProvider,
    S: ConversationStore + TurnStateStore,
    T: ToolExecutor,
    W: Write,
{
    if text.is_empty() {
        let err = error_response(400, "missing text parameter")?;
        stream.write_all(err.as_bytes())?;
        stream.flush()?;
        return Ok(());
    }

    // Stream tokens via SSE
    let stream_ref = std::cell::RefCell::new(stream);
    let mut token_count: usize = 0;
    // Write SSE headers
    let headers = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream\r\n",
        "Cache-Control: no-cache\r\n",
        "Connection: keep-alive\r\n",
        "Access-Control-Allow-Origin: http://127.0.0.1\r\n",
        "Vary: Origin\r\n",
        "X-Content-Type-Options: nosniff\r\n",
        "\r\n"
    );
    stream_ref.borrow_mut().write_all(headers.as_bytes())?;
    stream_ref.borrow_mut().flush()?;

    let stream_result = runtime.prompt_stream_in_session(
        session_id,
        text,
        &mut |token: &str| {
            token_count += 1;
            let escaped = escape_json(token);
            let event = format!(
                "data: {{\"token\":\"{}\",\"index\":{}}}\n\n",
                escaped, token_count
            );
            let mut s = stream_ref.borrow_mut();
            s.write_all(event.as_bytes()).and_then(|_| s.flush()).is_ok()
        },
    );

    // Send done event
    let mut s = stream_ref.borrow_mut();
    match stream_result {
        Ok(_) => {
            s.write_all(b"data: [DONE]\n\n")?;
        }
        Err(error) if is_stream_cancelled(&error) => {
            return Ok(());
        }
        Err(error) => {
            let err_event = format!(
                "data: {{\"error\":\"{}\"}}\n\n",
                escape_json(&error.to_string())
            );
            s.write_all(err_event.as_bytes())?;
        }
    }
    s.flush()?;
    Ok(())
}

fn snapshot_response_from_runtime<P, S, T>(
    runtime: &OctocodeRuntime<P, S, T>,
    session_id: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>>
where
    P: ModelProvider,
    S: ConversationStore + TurnStateStore,
    T: ToolExecutor,
{
    json_response(runtime.snapshot_json(session_id)?)
}

// ── WebSocket support ─────────────────────────────────────────────────────────

/// RFC 6455 §4.2.2 WebSocket magic GUID.
const WS_MAGIC: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Shared WebSocket hub for tracking active connections and broadcasting events.
static WS_HUB: OnceLock<ws::WsHub> = OnceLock::new();

fn ws_hub() -> &'static ws::WsHub {
    WS_HUB.get_or_init(ws::WsHub::new)
}

fn handle_ws_upgrade(
    stream: &mut TcpStream,
    request: &HttpRequest,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let ws_key = request
        .headers
        .get("sec-websocket-key")
        .ok_or_else(|| OctoError::Runtime(String::from("missing Sec-WebSocket-Key")))?;

    // Compute accept key: SHA-1(key + magic), then Base64
    use sha1::Digest;
    let mut hasher = sha1::Sha1::new();
    hasher.update(ws_key.as_bytes());
    hasher.update(WS_MAGIC.as_bytes());
    let accept = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hasher.finalize());

    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
    );
    stream.write_all(handshake.as_bytes())?;
    stream.flush()?;

    // Session
    let session_id = request
        .query_value("session")
        .or(initial_session_id)
        .unwrap_or_else(|| String::from("demo"));

    // Register this connection in the shared hub for broadcasting.
    let hub = ws_hub();
    let conn = ws::WsConnection::from_raw_stream(stream.try_clone()?, session_id.clone());
    let conn_id = hub.add(conn);

    // Simple WebSocket message loop
    loop {
        let msg = match ws_read_frame(stream) {
            Ok(Some(msg)) => msg,
            Ok(None) => break, // close frame or connection ended
            Err(_) => break,
        };

        // Treat each message as a chat prompt; stream tokens back as WS text frames.
        let workspace_root = String::from(".");
        let platform = NativePlatform::detect(workspace_root.clone());
        let loader = ConfigLoader::new(platform.config_paths());
        let config = cached_config_load(&loader)?;
        let runtime = build_runtime(workspace_root, config)?;

        let stream_ref = std::cell::RefCell::new(&mut *stream);
        let mut token_count: usize = 0;
        let stream_result = runtime.prompt_stream_in_session(
            &session_id,
            &msg,
            &mut |token: &str| {
                token_count += 1;
                let escaped = escape_json(token);
                let payload = format!(
                    "{{\"token\":\"{}\",\"index\":{}}}",
                    escaped, token_count
                );
                let mut s = stream_ref.borrow_mut();
                if ws_write_frame(*s, &payload).is_err() {
                    return false;
                }
                // Broadcast to other connections in the same session
                hub.send_to_session(&session_id, &payload);
                true
            },
        );

        // Send done marker
        match stream_result {
            Ok(_) => {
                let _ = ws_write_frame(stream, "{\"done\":true}");
            }
            Err(error) if is_stream_cancelled(&error) => {}
            Err(error) => {
                let err_payload = format!(
                    "{{\"error\":\"{}\"}}",
                    escape_json(&error.to_string())
                );
                let _ = ws_write_frame(stream, &err_payload);
            }
        }
    }

    // Clean up closed connections from the hub
    let _ = conn_id; // used for tracking; gc removes closed conns
    hub.gc();

    Ok(())
}

fn handle_terminal_ws(
    stream: &mut TcpStream,
    request: &HttpRequest,
) -> Result<(), Box<dyn std::error::Error>> {
    let terminal_id = request
        .query_value("id")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| OctoError::Runtime(String::from("missing terminal id")))?;

    if terminal::terminal_hub().session_info(&terminal_id).is_none() {
        return Err(OctoError::Runtime(format!("terminal session not found: {terminal_id}")).into());
    }

    if ws::WsConnection::accept(stream.try_clone()?, &request.headers).is_none() {
        return Err(OctoError::Runtime(String::from("terminal websocket handshake failed")).into());
    }

    let receiver = terminal::terminal_hub()
        .subscribe(&terminal_id)
        .ok_or_else(|| OctoError::Runtime(format!("terminal session not found: {terminal_id}")))?;

    let writer_done = Arc::new(AtomicBool::new(false));
    let writer_done_flag = writer_done.clone();
    let writer_stream = stream.try_clone()?;
    let writer_terminal_id = terminal_id.clone();

    let writer_thread = thread::spawn(move || {
        let mut writer_ws = ws::WsConnection::from_raw_stream(writer_stream, writer_terminal_id);
        loop {
            match receiver.recv_timeout(std::time::Duration::from_millis(250)) {
                Ok(payload) => {
                    if !writer_ws.send_text(&payload) {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if writer_done_flag.load(Ordering::SeqCst) {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    let mut reader_ws = ws::WsConnection::from_raw_stream(stream.try_clone()?, terminal_id.clone());
    while let Some(message) = reader_ws.read_message() {
        match message.opcode {
            ws::WsOpcode::Text => {
                if let Some(text) = message.as_text() {
                    terminal::terminal_hub().write_input(&terminal_id, text)?;
                }
            }
            ws::WsOpcode::Close => break,
            ws::WsOpcode::Ping | ws::WsOpcode::Pong | ws::WsOpcode::Binary => {}
        }
    }

    writer_done.store(true, Ordering::SeqCst);
    let _ = writer_thread.join();
    Ok(())
}

/// Read a single WebSocket frame (text or binary).  Returns `None` for
/// close/ping/pong control frames.
fn ws_read_frame(stream: &mut TcpStream) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let mut header = [0u8; 2];
    stream.read_exact(&mut header)?;

    let opcode = header[0] & 0x0F;
    let masked = (header[1] & 0x80) != 0;
    let mut payload_len = (header[1] & 0x7F) as u64;

    if payload_len == 126 {
        let mut buf = [0u8; 2];
        stream.read_exact(&mut buf)?;
        payload_len = u16::from_be_bytes(buf) as u64;
    } else if payload_len == 127 {
        let mut buf = [0u8; 8];
        stream.read_exact(&mut buf)?;
        payload_len = u64::from_be_bytes(buf);
    }

    // Limit frame size (same as HTTP body limit)
    if payload_len > MAX_BODY_BYTES as u64 {
        return Err(Box::new(OctoError::Runtime(String::from("WebSocket frame too large"))));
    }

    let mask_key = if masked {
        let mut key = [0u8; 4];
        stream.read_exact(&mut key)?;
        Some(key)
    } else {
        None
    };

    let mut payload = vec![0u8; payload_len as usize];
    stream.read_exact(&mut payload)?;

    if let Some(mask) = mask_key {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }

    match opcode {
        0x01 | 0x02 => Ok(Some(String::from_utf8_lossy(&payload).into_owned())),
        0x08 => Ok(None),        // close
        0x09 => {
            // ping → pong
            let _ = ws_write_control(stream, 0x0A, &payload);
            Ok(Some(String::new()))  // empty string = skip processing
        }
        _ => Ok(None),
    }
}

/// Write a text frame to a WebSocket connection (unmasked, server → client).
fn ws_write_frame(stream: &mut TcpStream, text: &str) -> Result<(), Box<dyn std::error::Error>> {
    let payload = text.as_bytes();
    let mut frame = Vec::with_capacity(payload.len() + 10);

    // FIN + text opcode
    frame.push(0x81);

    let len = payload.len();
    if len < 126 {
        frame.push(len as u8);
    } else if len < 65536 {
        frame.push(126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }

    frame.extend_from_slice(payload);
    stream.write_all(&frame)?;
    stream.flush()?;
    Ok(())
}

/// Write a WebSocket control frame (pong, close).
fn ws_write_control(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let mut frame = Vec::with_capacity(payload.len() + 2);
    frame.push(0x80 | opcode);
    frame.push(payload.len() as u8);
    frame.extend_from_slice(payload);
    stream.write_all(&frame)?;
    stream.flush()?;
    Ok(())
}

fn route_request(
    request: &HttpRequest,
    initial_session_id: Option<String>,
) -> Result<String, Box<dyn std::error::Error>> {
    let workspace_root = String::from(".");
    let platform = NativePlatform::detect(workspace_root.clone());
    let loader = ConfigLoader::new(platform.config_paths());
    let config = cached_config_load(&loader)?;

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => Ok(http_redirect("/ui-shell/")),
        ("GET", "/api/state") => {
            let session_id = request
                .query_value("session")
                .or(initial_session_id.clone());
            let runtime = build_runtime(workspace_root, config)?;
            snapshot_response_from_runtime(&runtime, session_id.as_deref())
        }
        ("GET", "/api/events") => {
            let session_id = request
                .query_value("session")
                .or(initial_session_id.clone());
            let runtime = build_runtime(workspace_root, config)?;
            // P1-L7: support `?since=<ms>` query param OR `Last-Event-ID`
            // header so a reconnecting WebUI can request only the deltas
            // instead of the entire feed.
            let since_ms = request
                .query_value("since")
                .and_then(|s| s.trim().parse::<u128>().ok())
                .or_else(|| {
                    request
                        .headers
                        .get("last-event-id")
                        .and_then(|s| s.trim().parse::<u128>().ok())
                });
            match since_ms {
                Some(since) => json_response(runtime.event_feed_json_since(session_id.as_deref(), since)?),
                None => json_response(runtime.event_feed_json(session_id.as_deref())?),
            }
        }
        ("GET", "/api/timeline") => {
            let session_id = request
                .query_value("session")
                .or(initial_session_id.clone());
            let runtime = build_runtime(workspace_root, config)?;
            let raw = runtime.event_feed_json(session_id.as_deref())?;
            // Add relativeMs to each event: inject into the items array
            // We return the raw event feed; client computes relative timing from atMs
            json_response(raw)
        }
        ("GET", "/api/health") => {
            // P0-S1: serve a 30 s in-process cached response when fresh; on miss
            // we still build a fresh runtime to probe providers, but the router
            // now probes them in parallel (see RuntimeProviderRouter::health_catalog).
            if let Some(cached) = cached_health_payload() {
                return json_response(cached);
            }
            let runtime = build_runtime(workspace_root, config)?;
            let body = runtime
                .provider_healths()
                .into_iter()
                .map(|health| {
                    format!(
                        concat!(
                            "{{",
                            "\"providerId\":\"{}\",",
                            "\"displayName\":\"{}\",",
                            "\"healthy\":{},",
                            "\"detail\":\"{}\",",
                            "\"model\":\"{}\",",
                            "\"latencyMs\":{}",
                            "}}"
                        ),
                        escape_json(&health.provider_id),
                        escape_json(&health.display_name),
                        health.healthy,
                        escape_json(&health.detail),
                        escape_json(health.model.as_deref().unwrap_or("")),
                        health
                            .latency_ms
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| String::from("null"))
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let payload = format!(
                "{{\"items\":[{}],\"wsConnections\":{},\"cachedAt\":{}}}",
                body,
                ws_hub().connection_count(),
                turn_now_ms_for_cache()
            );
            store_cached_health_payload(payload.clone());
            json_response(payload)
        }
        ("GET", "/api/ws-status") => {
            json_response(format!(
                "{{\"connections\":{}}}",
                ws_hub().connection_count()
            ))
        }
        ("GET", "/api/manage/catalog") => {
            let runtime = build_runtime(workspace_root, config)?;
            json_response(manage_catalog_json(&runtime)?)
        }
        ("POST", "/api/manage/upsert") => {
            handle_manage_upsert(
                request,
                workspace_root,
                platform.config_paths().config_home,
                config,
            )
        }
        ("POST", "/api/manage/delete") => {
            handle_manage_delete(
                request,
                workspace_root,
                platform.config_paths().config_home,
                config,
            )
        }
        ("GET", "/api/fs/list") => {
            let workspace_root_path = PathBuf::from(&platform.context().root);
            let raw_path = request.query_value("path");
            let dir_path = resolve_fs_path(&workspace_root_path, raw_path.as_deref(), true)?;
            if !dir_path.is_dir() {
                return error_response(400, "path is not a directory");
            }
            json_response(
                serde_json::json!({
                    "workspaceRoot": platform.context().root,
                    "currentPath": dir_path.display().to_string(),
                    "parentPath": dir_path.parent().map(|value| value.display().to_string()),
                    "entries": list_fs_entries(&dir_path)?,
                })
                .to_string(),
            )
        }
        ("GET", "/api/fs/read") => {
            // Serve a workspace file as text so chat-rendered links ("created
            // foo.txt", "wrote bar.rs", etc.) can be clicked to view / download.
            // Text-only (UTF-8 / BOM-stripped). Binary responses require a
            // separate streaming path; reject them here with 415.
            let workspace_root_path = PathBuf::from(&platform.context().root);
            let raw_path = request.query_value("path");
            let target_path = resolve_fs_path(&workspace_root_path, raw_path.as_deref(), true)?;
            if !target_path.is_file() {
                return error_response(400, "path is not a file");
            }
            // 10 MB hard cap on in-memory text reads.
            const FS_READ_MAX: u64 = 10 * 1024 * 1024;
            match fs::metadata(&target_path) {
                Ok(meta) if meta.len() > FS_READ_MAX => {
                    return error_response(413, "file too large (limit 10MB)")
                }
                _ => {}
            }
            let bytes = fs::read(&target_path).map_err(|error| {
                OctoError::Runtime(format!("read {}: {error}", target_path.display()))
            })?;
            let body = match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(_) => return error_response(415, "file is not valid UTF-8 text"),
            };
            let filename = target_path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("download.txt")
                .to_string();
            let want_download = matches!(
                request.query_value("download").as_deref(),
                Some("1") | Some("true")
            );
            let disposition = if want_download {
                format!("attachment; filename=\"{}\"", escape_json(&filename))
            } else {
                format!("inline; filename=\"{}\"", escape_json(&filename))
            };
            Ok(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nContent-Disposition: {}\r\nCache-Control: no-store\r\nX-Workspace-Path: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                disposition,
                escape_json(&target_path.display().to_string()),
                body
            ))
        }
        ("POST", "/api/fs/create") => {
            let workspace_root_path = PathBuf::from(&platform.context().root);
            let raw_path = request.form_value("path");
            let kind = request.form_value("kind").unwrap_or_else(|| String::from("file"));
            let target_path = resolve_fs_path(&workspace_root_path, raw_path.as_deref(), false)?;

            match kind.as_str() {
                "folder" => {
                    fs::create_dir_all(&target_path).map_err(|error| {
                        OctoError::Runtime(format!(
                            "failed to create folder {}: {error}",
                            target_path.display()
                        ))
                    })?;
                }
                _ => {
                    if let Some(parent) = target_path.parent() {
                        fs::create_dir_all(parent).map_err(|error| {
                            OctoError::Runtime(format!(
                                "failed to create parent folder {}: {error}",
                                parent.display()
                            ))
                        })?;
                    }
                    if !target_path.exists() {
                        fs::write(&target_path, "").map_err(|error| {
                            OctoError::Runtime(format!(
                                "failed to create file {}: {error}",
                                target_path.display()
                            ))
                        })?;
                    }
                }
            }

            json_response(
                serde_json::json!({
                    "ok": true,
                    "kind": if target_path.is_dir() { "folder" } else { "file" },
                    "path": target_path.display().to_string(),
                })
                .to_string(),
            )
        }
        ("POST", "/api/fs/search") => {
            let workspace_root_path = PathBuf::from(&platform.context().root);
            let raw_path = request.form_value("path");
            let query = request.form_value("query").unwrap_or_default();
            let query = query.trim().to_string();
            if query.is_empty() {
                return error_response(400, "missing search query");
            }

            let target_path = resolve_fs_path(&workspace_root_path, raw_path.as_deref(), true)?;
            let mut results = Vec::new();
            search_text_in_path(&target_path, &query, &mut results)?;

            json_response(
                serde_json::json!({
                    "path": target_path.display().to_string(),
                    "query": query,
                    "limit": FS_MAX_RESULTS,
                    "resultCount": results.len(),
                    "results": results,
                })
                .to_string(),
            )
        }
        ("POST", "/api/fs/replace") => {
            let workspace_root_path = PathBuf::from(&platform.context().root);
            let raw_path = request.form_value("path");
            let old_text = request.form_value("oldText").unwrap_or_default();
            let new_text = request.form_value("newText").unwrap_or_default();
            if old_text.is_empty() {
                return error_response(400, "missing replacement source text");
            }

            let target_path = resolve_fs_path(&workspace_root_path, raw_path.as_deref(), true)?;
            let mut changed_files = Vec::new();
            let replacements = replace_text_in_path(&target_path, &old_text, &new_text, &mut changed_files)?;

            json_response(
                serde_json::json!({
                    "path": target_path.display().to_string(),
                    "oldText": old_text,
                    "newText": new_text,
                    "filesChanged": changed_files.len(),
                    "replacementCount": replacements,
                    "items": changed_files,
                })
                .to_string(),
            )
        }
        ("POST", "/api/sessions/delete") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| OctoError::Runtime(String::from("missing session id")))?;
            let store = FileSessionStore::new(&platform.config_paths())?;
            let _ = store.delete_session(&session_id)?;
            let next_session_id = ensure_session_exists(&store)?;
            let runtime = build_runtime(workspace_root, config)?;
            json_response(runtime.snapshot_json(Some(&next_session_id))?)
        }
        ("POST", "/api/sessions/create") => {
            let title = request.form_value("title");
            let store = FileSessionStore::new(&platform.config_paths())?;
            let session_id = create_session(&store, title)?;
            METRICS_SESSIONS_CREATED_TOTAL.fetch_add(1, Ordering::Relaxed);
            let runtime = build_runtime(workspace_root, config)?;
            json_response(runtime.snapshot_json(Some(&session_id))?)
        }
        ("POST", "/api/sessions/fork") => {
            let parent_session_id = request
                .form_value("parentSessionId")
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| OctoError::Runtime(String::from("missing parent session id")))?;
            let branch_name = request
                .form_value("branchName")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| String::from("fork"));
            let upto_message_index = request
                .form_value("messageIndex")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value.parse::<usize>().map_err(|_| {
                        OctoError::Runtime(format!("invalid fork message index: {value}"))
                    })
                })
                .transpose()?;
            let session_id = default_session_id();
            let runtime = build_runtime(workspace_root, config)?;
            runtime.fork_session_from_index(
                &parent_session_id,
                &session_id,
                &branch_name,
                upto_message_index,
            )?;
            json_response(runtime.snapshot_json(Some(&session_id))?)
        }
        ("POST", "/api/sessions/stop") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| String::from("demo"));
            let runtime = build_runtime(workspace_root, config)?;
            runtime.request_session_stop(&session_id);
            json_response(format!(
                "{{\"ok\":true,\"sessionId\":\"{}\"}}",
                escape_json(&session_id)
            ))
        }
        // P0-L3 alias: many UIs use the verb "cancel" for in-flight tasks.
        // Accept both `/api/sessions/stop` (existing) and
        // `/api/sessions/cancel` so Canvas UI / IDE bridges don't have to
        // pick one. Behaviourally identical — flips the per-session stop
        // flag that runtime agent loops poll between iterations.
        ("POST", "/api/sessions/cancel") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| String::from("demo"));
            let runtime = build_runtime(workspace_root, config)?;
            runtime.request_session_stop(&session_id);
            json_response(format!(
                "{{\"ok\":true,\"cancelled\":true,\"sessionId\":\"{}\"}}",
                escape_json(&session_id)
            ))
        }
        ("POST", "/api/sessions/delete-all") => {
            let store = FileSessionStore::new(&platform.config_paths())?;
            let _ = store.delete_all_sessions()?;
            let next_session_id = ensure_session_exists(&store)?;
            let runtime = build_runtime(workspace_root, config)?;
            json_response(runtime.snapshot_json(Some(&next_session_id))?)
        }
        ("GET", "/api/tools") => {
            let runtime = build_runtime(workspace_root, config)?;
            let items: Vec<String> = runtime
                .tools()
                .iter()
                .map(|t| {
                    format!(
                        "{{\"name\":\"{}\",\"summary\":\"{}\",\"minimumPermission\":\"{:?}\"}}",
                        escape_json(t.name),
                        escape_json(t.summary),
                        t.minimum_permission
                    )
                })
                .collect();
            json_response(format!("[{}]", items.join(",")))
        }
        ("GET", "/api/tasks") => {
            let session_filter = request.query_value("session");
            let runtime = build_runtime(workspace_root, config)?;
            let tasks = runtime.task_list(session_filter.as_deref());
            let items: Vec<String> = tasks
                .iter()
                .map(|t| {
                    format!(
                        concat!(
                            "{{",
                            "\"id\":\"{}\",",
                            "\"kind\":\"{}\",",
                            "\"sessionId\":\"{}\",",
                            "\"label\":\"{}\",",
                            "\"state\":\"{}\",",
                            "\"createdAtMs\":{},",
                            "\"finishedAtMs\":{},",
                            "\"resultSummary\":{}",
                            "}}"
                        ),
                        escape_json(&t.id),
                        escape_json(&format!("{:?}", t.kind).to_lowercase()),
                        escape_json(&t.session_id),
                        escape_json(&t.label),
                        escape_json(&format!("{:?}", t.state).to_lowercase()),
                        t.created_at_ms,
                        t.finished_at_ms
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| String::from("null")),
                        t.result_summary
                            .as_deref()
                            .map(|s| format!("\"{}\"", escape_json(s)))
                            .unwrap_or_else(|| String::from("null")),
                    )
                })
                .collect();
            json_response(format!("{{\"items\":[{}]}}", items.join(",")))
        }
        ("POST", "/api/tasks") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| String::from("demo"));
            let label = request
                .form_value("label")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| String::from("task"));
            let kind_str = request.form_value("kind").unwrap_or_default();
            let kind = match kind_str.trim() {
                "workflow" => TaskKind::Workflow,
                "tool" => TaskKind::Tool,
                _ => TaskKind::Agent,
            };
            let runtime = build_runtime(workspace_root, config)?;
            let rec = runtime.task_submit(kind, &session_id, &label);
            start_async_task_worker(
                String::from("."),
                rec.id.clone(),
                rec.session_id.clone(),
                rec.kind.clone(),
                rec.label.clone(),
            );
            json_response(format!(
                concat!(
                    "{{",
                    "\"id\":\"{}\",",
                    "\"sessionId\":\"{}\",",
                    "\"label\":\"{}\",",
                    "\"state\":\"pending\"",
                    "}}"
                ),
                escape_json(&rec.id),
                escape_json(&rec.session_id),
                escape_json(&rec.label),
            ))
        }
        ("POST", "/api/terminal/open") => {
            let owner_session_id = request
                .form_value("sessionId")
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| OctoError::Runtime(String::from("missing terminal owner session id")))?;
            let label = request.form_value("label");
            let cwd = request.form_value("cwd");
            let cols = request
                .form_value("cols")
                .and_then(|value| value.parse::<u16>().ok());
            let rows = request
                .form_value("rows")
                .and_then(|value| value.parse::<u16>().ok());
            let info = terminal::terminal_hub().open_session(
                &workspace_root,
                &owner_session_id,
                cwd.as_deref(),
                label.as_deref(),
                cols,
                rows,
            )?;
            json_response(serde_json::to_string(&info)?)
        }
        ("POST", "/api/terminal/resize") => {
            let terminal_id = request
                .form_value("id")
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| OctoError::Runtime(String::from("missing terminal id")))?;
            let cols = request
                .form_value("cols")
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(120);
            let rows = request
                .form_value("rows")
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(30);
            terminal::terminal_hub().resize_session(&terminal_id, cols, rows)?;
            json_response(String::from("{\"ok\":true}"))
        }
        ("POST", "/api/terminal/close") => {
            let terminal_id = request
                .form_value("id")
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| OctoError::Runtime(String::from("missing terminal id")))?;
            terminal::terminal_hub().close_session(&terminal_id);
            json_response(String::from("{\"ok\":true}"))
        }
        ("POST", "/api/chat") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| String::from("demo"));
            let text = request.form_value("text").unwrap_or_default();
            METRICS_CHAT_REQUESTS_TOTAL.fetch_add(1, Ordering::Relaxed);
            // T6 (release-hardening): each chat turn drives one or more
            // agent loop iterations. We approximate `agent_iterations_total`
            // as one-per-turn here — finer-grained accounting requires a
            // dedicated runtime callback and is deferred.
            METRICS_AGENT_ITERATIONS_TOTAL.fetch_add(1, Ordering::Relaxed);
            let runtime = build_runtime(workspace_root, config)?;
            let result = runtime.prompt_in_session(&session_id, &text);
            match result {
                Ok(_) => json_response(runtime.snapshot_json(Some(&session_id))?),
                Err(error) => error_response(500, &format!("chat failed: {error}")),
            }
        }
        ("POST", "/api/tool") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| String::from("demo"));
            let name = request.form_value("name").unwrap_or_else(|| String::from("echo"));
            let input = request.form_value("input").unwrap_or_default();
            METRICS_TOOL_INVOCATIONS_TOTAL.fetch_add(1, Ordering::Relaxed);
            let runtime = build_runtime(workspace_root, config)?;
            if execute_custom_tool_if_configured(
                &runtime,
                &platform.context().root,
                &platform.config_paths().config_home,
                &session_id,
                &name,
                &input,
            )? {
                return json_response(runtime.snapshot_json(Some(&session_id))?);
            }
            let result = runtime.run_tool_in_session(
                &session_id,
                ToolCall {
                    name,
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            );
            match result {
                Ok(_) => json_response(runtime.snapshot_json(Some(&session_id))?),
                Err(error) => error_response(500, &format!("tool failed: {error}")),
            }
        }
        ("POST", "/api/settings") => {
            let mut next = config.clone();
            if let Some(provider_id) = request.form_value("providerId") {
                if !provider_id.trim().is_empty() {
                    next.provider_id = Some(provider_id.trim().to_string());
                }
            }
            if let Some(provider_base_url) = request.form_value("providerBaseUrl") {
                let trimmed = provider_base_url.trim();
                next.provider_base_url = if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                };
            }
            if let Some(default_model) = request.form_value("defaultModel") {
                let trimmed = default_model.trim();
                next.default_model = if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                };
            }
            if let Some(permission_mode) = request.form_value("permissionMode") {
                next.permission_mode = match permission_mode.trim() {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => PermissionMode::DangerFullAccess,
                    _ => PermissionMode::WorkspaceWrite,
                };
            }
            if let Some(history_limit) = request.form_value("historyLimit") {
                next.history_limit = history_limit.parse::<usize>().unwrap_or(next.history_limit).max(1);
            }
            if let Some(deny_tool) = request.form_value("denyTool") {
                let dn = deny_tool.trim().to_string();
                if !dn.is_empty() && !next.denied_tools.contains(&dn) {
                    next.denied_tools.push(dn);
                }
            }
            if let Some(allow_tool) = request.form_value("allowTool") {
                let an = allow_tool.trim().to_string();
                next.denied_tools.retain(|t| *t != an);
            }
            loader.save(&next)?;
            let runtime = build_runtime(workspace_root, next)?;
            let session_id = request.form_value("sessionId");
            json_response(runtime.snapshot_json(session_id.as_deref())?)
        }
        ("POST", "/api/command") => {
            let command = request.form_value("command").unwrap_or_default().trim().to_string();
            let session_id = request.form_value("sessionId");
            handle_command(command, session_id, workspace_root, loader, config)
        }
        // 2026.4.24-B1 + mem0/simplemem: persistent structured memory
        // (multi-scope, tagged, searchable). JSONL-backed under
        // {data_home}/memory.jsonl. Deletes are tombstones; `/compact`
        // rewrites the file keeping only live records.
        ("POST", "/api/memory/add") => {
            let scope = request
                .form_value("scope")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| String::from("default"));
            let text = request.form_value("text").unwrap_or_default();
            if text.trim().is_empty() {
                return Err(Box::new(OctoError::Runtime(String::from(
                    "memory text must not be empty",
                ))));
            }
            let tags: Vec<String> = request
                .form_value("tags")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            let importance: u8 = request
                .form_value("importance")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5);
            let user_id = request.form_value("userId").filter(|v| !v.trim().is_empty());
            let session_id = request.form_value("sessionId").filter(|v| !v.trim().is_empty());
            let agent_id = request.form_value("agentId").filter(|v| !v.trim().is_empty());
            let data_home = platform.config_paths().data_home.clone();
            let id = memory_store::add(
                &data_home, &scope, &text, tags, importance, user_id, session_id, agent_id,
            )
            .map_err(|e| OctoError::Runtime(format!("memory add failed: {e}")))?;
            METRICS_MEMORY_NOTES_TOTAL.fetch_add(1, Ordering::Relaxed);
            json_response(format!(
                "{{\"ok\":true,\"id\":{id},\"scope\":{scope_json}}}",
                scope_json = serde_json::to_string(&scope).unwrap_or_else(|_| String::from("\"default\"")),
            ))
        }
        ("POST", "/api/memory/update") => {
            let id: u64 = request
                .form_value("id")
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| OctoError::Runtime(String::from("missing memory id")))?;
            let text = request.form_value("text").filter(|v| !v.trim().is_empty());
            let tags = request.form_value("tags").map(|s| {
                s.split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
            });
            let importance: Option<u8> = request
                .form_value("importance")
                .and_then(|v| v.parse().ok());
            let data_home = platform.config_paths().data_home.clone();
            let ok = memory_store::update(&data_home, id, text, tags, importance)
                .map_err(|e| OctoError::Runtime(format!("memory update failed: {e}")))?;
            json_response(format!("{{\"ok\":{ok}}}"))
        }
        ("POST", "/api/memory/delete") => {
            let id: u64 = request
                .form_value("id")
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| OctoError::Runtime(String::from("missing memory id")))?;
            let data_home = platform.config_paths().data_home.clone();
            let ok = memory_store::delete(&data_home, id)
                .map_err(|e| OctoError::Runtime(format!("memory delete failed: {e}")))?;
            json_response(format!("{{\"ok\":{ok}}}"))
        }
        ("GET", "/api/memory/list") => {
            let data_home = platform.config_paths().data_home.clone();
            let filter = memory_store::Filter {
                scope: request.query_value("scope"),
                user_id: request.query_value("userId"),
                session_id: request.query_value("sessionId"),
                agent_id: request.query_value("agentId"),
                tag: request.query_value("tag"),
                limit: request.query_value("limit").and_then(|v| v.parse().ok()),
            };
            let items = memory_store::list_json(&data_home, &filter);
            json_response(format!("{{\"items\":{items}}}"))
        }
        ("GET", "/api/memory/search") => {
            let query = request.query_value("q").unwrap_or_default();
            if query.trim().is_empty() {
                return Err(Box::new(OctoError::Runtime(String::from(
                    "memory search requires q=",
                ))));
            }
            let top_k = request
                .query_value("topK")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5usize);
            let filter = memory_store::Filter {
                scope: request.query_value("scope"),
                user_id: request.query_value("userId"),
                session_id: request.query_value("sessionId"),
                agent_id: request.query_value("agentId"),
                tag: request.query_value("tag"),
                limit: None,
            };
            let data_home = platform.config_paths().data_home.clone();
            let items = memory_store::search_json(&data_home, &query, &filter, top_k);
            json_response(format!("{{\"items\":{items}}}"))
        }
        ("POST", "/api/memory/compact") => {
            let data_home = platform.config_paths().data_home.clone();
            let (kept, dropped) = memory_store::compact(&data_home)
                .map_err(|e| OctoError::Runtime(format!("memory compact failed: {e}")))?;
            json_response(format!("{{\"ok\":true,\"kept\":{kept},\"dropped\":{dropped}}}"))
        }
        ("POST", "/api/memory/clear") => {
            let data_home = platform.config_paths().data_home.clone();
            memory_store::clear(&data_home)
                .map_err(|e| OctoError::Runtime(format!("memory clear failed: {e}")))?;
            json_response(String::from("{\"ok\":true}"))
        }
        // 2026.4.24-B2: agent long-task supervision. Process-local registry;
        // heartbeats enable external watchdogs to detect stalled agents.
        ("POST", "/api/agent/tasks/start") => {
            let id = request
                .form_value("id")
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| OctoError::Runtime(String::from("missing task id")))?;
            let title = request.form_value("title").unwrap_or_else(|| id.clone());
            let is_new = agent_tasks::start(&id, &title);
            json_response(format!(
                "{{\"ok\":true,\"id\":{id_json},\"isNew\":{is_new}}}",
                id_json = serde_json::to_string(&id).unwrap_or_else(|_| String::from("\"\"")),
            ))
        }
        ("POST", "/api/agent/tasks/heartbeat") => {
            let id = request
                .form_value("id")
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| OctoError::Runtime(String::from("missing task id")))?;
            let ok = agent_tasks::heartbeat(&id);
            json_response(format!("{{\"ok\":{ok}}}"))
        }
        ("POST", "/api/agent/tasks/finish") => {
            let id = request
                .form_value("id")
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| OctoError::Runtime(String::from("missing task id")))?;
            let status = request.form_value("status").unwrap_or_else(|| String::from("completed"));
            let ok = agent_tasks::finish(&id, &status);
            json_response(format!("{{\"ok\":{ok}}}"))
        }
        ("GET", "/api/agent/tasks/list") => {
            let items = agent_tasks::list_json();
            json_response(format!("{{\"items\":{items}}}"))
        }
        ("GET", "/metrics") => {
            let body = render_metrics_body();
            Ok(http_response(
                200,
                "OK",
                "text/plain; version=0.0.4; charset=utf-8",
                body,
            ))
        }
        _ => serve_static(request),
    }
}

fn handle_command(
    command: String,
    session_id: Option<String>,
    workspace_root: String,
    loader: ConfigLoader,
    mut config: RuntimeConfig,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut parts = command.split_whitespace();
    let action = parts.next().unwrap_or_default();
    let config_home = loader
        .config_file_path()
        .parent()
        .map(|value: &std::path::Path| value.display().to_string())
        .unwrap_or_default();
    let custom_args = parts.clone().collect::<Vec<_>>().join(" ");
    if let Some(expanded) = resolve_custom_command(
        &workspace_root,
        &config_home,
        action,
        &custom_args,
    )? {
        return handle_command(expanded, session_id, workspace_root, loader, config);
    }
    match action {
        "events" => {
            let runtime = build_runtime(workspace_root, config)?;
            return json_response(runtime.event_feed_json(session_id.as_deref())?);
        }
        "pipe" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let rest = parts.collect::<Vec<_>>().join(" ");
            let step_strs: Vec<&str> = rest.split(" | ").collect();
            let runtime = build_runtime(workspace_root, config)?;
            let mut step_summaries: Vec<String> = Vec::new();
            for step_raw in step_strs.iter() {
                let step_trim = step_raw.trim();
                if step_trim.is_empty() {
                    continue;
                }
                let mut sp = step_trim.splitn(2, ' ');
                let verb = sp.next().unwrap_or("echo");
                let input = sp.next().unwrap_or("").to_string();
                let tool_name_str = match verb {
                    "read" => "read-file",
                    "list" => "list-files",
                    "write" => "write-file",
                    "search" => "search-text",
                    _ => "echo",
                };
                let start = std::time::Instant::now();
                let _ = runtime.run_tool_in_session(
                    &eff_session,
                    ToolCall {
                        name: String::from(tool_name_str),
                        input: if input.is_empty() { String::from(".") } else { input.clone() },
                        permission: PermissionMode::ReadOnly,
                    },
                );
                let duration_ms = start.elapsed().as_millis();
                let mut step_obj = String::new();
                step_obj.push_str("{\"cmd\":\"");
                step_obj.push_str(&escape_json(step_trim));
                step_obj.push_str("\",\"tool\":\"");
                step_obj.push_str(tool_name_str);
                step_obj.push_str("\",\"durationMs\":");
                step_obj.push_str(&duration_ms.to_string());
                step_obj.push('}');
                step_summaries.push(step_obj);
            }
            let snapshot = runtime.snapshot_json(Some(&eff_session))?;
            let steps_json = format!("[{}]", step_summaries.join(","));
            let mut injected = String::with_capacity(snapshot.len() + steps_json.len() + 16);
            if snapshot.ends_with('}') {
                injected.push_str(&snapshot[..snapshot.len() - 1]);
                injected.push_str(",\"steps\":");
                injected.push_str(&steps_json);
                injected.push('}');
            } else {
                injected.push_str(&snapshot);
            }
            return json_response(injected);
        }
        "provider" => {
            if let Some(value) = parts.next() {
                config.provider_id = Some(String::from(value));
                loader.save(&config)?;
            }
        }
        "model" => {
            if let Some(value) = parts.next() {
                config.default_model = Some(String::from(value));
                loader.save(&config)?;
            }
        }
        "permission" => {
            if let Some(value) = parts.next() {
                config.permission_mode = match value {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => PermissionMode::DangerFullAccess,
                    _ => PermissionMode::WorkspaceWrite,
                };
                loader.save(&config)?;
            }
        }
        "approve" => {
            if let Some(value) = parts.next() {
                config.permission_mode = match value {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => PermissionMode::DangerFullAccess,
                    _ => PermissionMode::WorkspaceWrite,
                };
                loader.save(&config)?;
            }
        }
        "plan" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            runtime.run_tool_in_session(
                &session_id,
                ToolCall {
                    name: String::from("workflow-plan"),
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        "workflow" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let text = parts.collect::<Vec<_>>().join(" ");
            let mut runtime = build_runtime(workspace_root, config)?;
            execute_command(
                &mut runtime,
                CliCommand::Workflow {
                    session_id: session_id.clone(),
                    text,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        "agent" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let text = parts.collect::<Vec<_>>().join(" ");
            let mut runtime = build_runtime(workspace_root, config)?;
            execute_command(
                &mut runtime,
                CliCommand::Agent {
                    session_id: session_id.clone(),
                    text,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        "repl" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let text = parts.collect::<Vec<_>>().join(" ");
            let mut runtime = build_runtime(workspace_root, config)?;
            execute_command(
                &mut runtime,
                CliCommand::Repl {
                    session_id: session_id.clone(),
                    text,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        // Read-only observability commands — fall through to snapshot at end
        "snapshot" | "sessions" | "status" | "health" | "circuit-log" | "doctor" => {}
        "history" => {
            if let Some(value) = parts.next() {
                config.history_limit = value.trim().parse::<usize>().unwrap_or(config.history_limit).max(1);
                loader.save(&config)?;
            }
        }
        "read" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("read-file"),
                    input: if input.is_empty() { String::from("README.md") } else { input },
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "list" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("list-files"),
                    input: if input.is_empty() { String::from(".") } else { input },
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "write" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let remaining = parts.collect::<Vec<_>>();
            if remaining.len() < 2 {
                return error_response(400, "write requires: write <path> <content>");
            }
            let file_path = remaining[0].to_string();
            let content = remaining[1..].join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("write-file"),
                    input: format!("{file_path}|{content}"),
                    permission: PermissionMode::WorkspaceWrite,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "tool" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let tool_name = parts.next().unwrap_or("echo").to_string();
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: tool_name,
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "session-add" => {
            let new_id = parts.next().unwrap_or("session").to_string();
            let title = parts.collect::<Vec<_>>().join(" ");
            let mut runtime = build_runtime(workspace_root, config)?;
            let _ = execute_command(
                &mut runtime,
                CliCommand::SessionAdd {
                    id: new_id.clone(),
                    title: if title.is_empty() { String::from("Session") } else { title },
                },
            );
            return json_response(runtime.snapshot_json(Some(&new_id))?);
        }
        "session" => {
            let target = parts.next().map(String::from).or(session_id);
            let runtime = build_runtime(workspace_root, config)?;
            return json_response(runtime.snapshot_json(target.as_deref())?);
        }
        "search" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            runtime.run_tool_in_session(
                &session_id,
                ToolCall {
                    name: String::from("search-text"),
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        // ── iteration-1: git + context + tokens + tree slash-commands ──────
        "git" => {
            let subcommand = parts.next().unwrap_or("status");
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let tool_name_str = match subcommand {
                "diff" => "git-diff",
                "log" => "git-log",
                _ => "git-status",
            };
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from(tool_name_str),
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "context" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("read-context"),
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "tree" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("file-tree"),
                    input: if input.is_empty() { String::from(". 3") } else { input },
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "tokens" => {
            // Return token count summary for the active session
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let runtime = build_runtime(workspace_root, config)?;
            let snapshot = runtime.snapshot_json(Some(&eff_session))?;
            // Rough char-based token estimate from messages in snapshot JSON
            // Count chars between "content":"..." fields
            let total_chars: usize = {
                let mut count = 0usize;
                let mut search = snapshot.as_str();
                while let Some(pos) = search.find("\"content\":\"") {
                    let after = &search[pos + 11..];
                    if let Some(end) = after.find('"') {
                        count += end;
                        search = &after[end + 1..];
                    } else {
                        break;
                    }
                }
                count
            };
            let token_estimate = total_chars / 4;
            let token_json = format!(
                "{{\"tokenEstimate\":{},\"charCount\":{},\"session\":\"{}\"}}",
                token_estimate, total_chars, escape_json(&eff_session)
            );
            let injected = if snapshot.ends_with('}') {
                let mut s = String::with_capacity(snapshot.len() + 64);
                s.push_str(&snapshot[..snapshot.len() - 1]);
                s.push_str(",\"tokenInfo\":");
                s.push_str(&token_json);
                s.push('}');
                s
            } else {
                snapshot
            };
            return json_response(injected);
        }
        "fetch" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let url = parts.collect::<Vec<_>>().join(" ");
            if url.is_empty() {
                return error_response(400, "fetch requires a URL");
            }
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("http-get"),
                    input: url,
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "append" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let remaining = parts.collect::<Vec<_>>();
            if remaining.is_empty() {
                return error_response(400, "append requires: append <path> <content>");
            }
            let file_path = remaining[0].to_string();
            let content = remaining[1..].join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("append-file"),
                    input: format!("{file_path}|{content}"),
                    permission: PermissionMode::WorkspaceWrite,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "reload" | "refresh" | "" => {}
        "mcp" => {
            let subcommand = parts.next().unwrap_or("list");
            let workspace_root_path = workspace_root.clone();
            let platform = NativePlatform::detect(workspace_root_path);
            let config_paths = platform.config_paths();
            match octocode_mcp::McpRegistry::discover(&platform.context().root, &config_paths.config_home) {
                Ok(registry) => {
                    let items: Vec<String> = registry.servers().iter().map(|s| {
                        format!(
                            "{{\"id\":\"{}\",\"transport\":\"{}\",\"state\":\"{}\",\"detail\":\"{}\",\"trusted\":{}}}",
                            escape_json(&s.descriptor.id),
                            escape_json(s.descriptor.transport.as_str()),
                            escape_json(s.state.as_str()),
                            escape_json(&s.detail),
                            s.descriptor.trusted,
                        )
                    }).collect();
                    let body = format!("{{\"command\":\"mcp {}\",\"items\":[{}]}}", subcommand, items.join(","));
                    return json_response(body);
                }
                Err(err) => {
                    return json_response(format!("{{\"command\":\"mcp {}\",\"items\":[],\"error\":\"{}\"}}", subcommand, escape_json(&err)));
                }
            }
        }
        _ => {
            return error_response(400, &format!("unsupported command: {command}"));
        }
    }

    let runtime = build_runtime(workspace_root, config)?;
    json_response(runtime.snapshot_json(session_id.as_deref())?)
}

fn serve_static(request: &HttpRequest) -> Result<String, Box<dyn std::error::Error>> {
    let relative = match request.path.as_str() {
        "/ui-shell" | "/ui-shell/" => String::from("ui-shell/index.html"),
        path if path.starts_with("/ui-shell/") => path.trim_start_matches('/').to_string(),
        _ => return error_response(404, "not found"),
    };

    if relative.contains("..") {
        return error_response(403, "forbidden");
    }

    let file_path = if let Some(path) = resolve_static_path(&relative) {
        path
    } else {
        return error_response(404, "not found");
    };

    let mut body = {
        // Read as bytes and decode lossily so a stray non-UTF-8 byte in a
        // comment/asset does not blow up the whole WebUI with a 500.
        let bytes = fs::read(&file_path)
            .map_err(|e| OctoError::Runtime(format!("failed to read {}: {e}", file_path.display())))?;
        String::from_utf8_lossy(&bytes).into_owned()
    };
    // Inject auth token into index.html so the WebUI can authenticate API calls
    if relative == "ui-shell/index.html" {
        let token = get_server_token();
        let inject = format!(r#"<script>window.__OCTOCODE_AUTH_TOKEN__="{}";</script>"#, token);
        body = body.replacen("</head>", &format!("{inject}\n</head>"), 1);
    }
    let content_type = content_type_for(&file_path);
    Ok(http_response(200, "OK", content_type, body))
}

fn resolve_static_path(relative: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(relative);
    if direct.is_file() {
        return Some(direct);
    }

    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent().unwrap_or(Path::new("."));

    // Search next to the binary first, then walk up parent directories so a
    // target/release binary can still find the workspace ui-shell/ assets.
    for base in exe_dir.ancestors().take(6) {
        let candidate = base.join(relative);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        _ => "text/plain; charset=utf-8",
    }
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, Box<dyn std::error::Error>> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let mut header_end = None;

    while header_end.is_none() {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        header_end = find_header_end(&buffer);
    }

    let header_end = header_end.ok_or_else(|| OctoError::Runtime(String::from("invalid HTTP request")))?;
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| OctoError::Runtime(String::from("missing request line")))?;
    let mut request_line_parts = request_line.split_whitespace();
    let method = request_line_parts.next().unwrap_or_default().to_string();
    let target = request_line_parts.next().unwrap_or("/");
    let (path, query) = split_target(target);

    let mut content_length = 0usize;
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name_trimmed = name.trim().to_string();
            let value_trimmed = value.trim().to_string();
            if name_trimmed.eq_ignore_ascii_case("Content-Length") {
                content_length = value_trimmed.parse::<usize>().unwrap_or(0);
            }
            headers.insert(name_trimmed.to_ascii_lowercase(), value_trimmed);
        }
    }

    // Guard against oversized request bodies.
    if content_length > MAX_BODY_BYTES {
        return Err(Box::new(OctoError::Runtime(format!(
            "request body too large ({content_length} bytes, limit {MAX_BODY_BYTES})"
        ))));
    }

    let mut body = buffer[(header_end + 4)..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }

    Ok(HttpRequest {
        method,
        path: path.to_string(),
        query: query.to_string(),
        body: String::from_utf8_lossy(&body).to_string(),
        headers,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn split_target(target: &str) -> (&str, &str) {
    if let Some((path, query)) = target.split_once('?') {
        (path, query)
    } else {
        (target, "")
    }
}

fn http_redirect(location: &str) -> String {
    format!(
        "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        location
    )
}

fn json_response(body: String) -> Result<String, Box<dyn std::error::Error>> {
    Ok(http_response(200, "OK", "application/json; charset=utf-8", body))
}

fn error_response(status: u16, message: &str) -> Result<String, Box<dyn std::error::Error>> {
    Ok(http_response(
        status,
        if status == 404 { "Not Found" } else { "Error" },
        "application/json; charset=utf-8",
        format!("{{\"error\":\"{}\"}}", escape_json(message)),
    ))
}

fn http_response(status: u16, status_text: &str, content_type: &str, body: String) -> String {
    // T14 (release-hardening): always emit conservative security headers.
    // CSP is intentionally strict for the bundled UI shell — we serve our
    // own static assets without any third-party CDN — and X-Frame-Options
    // / X-Content-Type-Options block trivial clickjacking + MIME sniffing.
    // ACAO is restricted to localhost since the WebUI is bound to
    // 127.0.0.1; widen it via a dedicated config flag if remote access
    // is required.
    format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\n\
         X-Frame-Options: DENY\r\n\
         Referrer-Policy: no-referrer\r\n\
         Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; frame-ancestors 'none'\r\n\
         Access-Control-Allow-Origin: http://127.0.0.1\r\n\
         Vary: Origin\r\n\
         Connection: close\r\n\
         \r\n{}",
        status,
        status_text,
        content_type,
        body.len(),
        body
    )
}

fn escape_json(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            '\r' => result.push_str("\\r"),
            '\n' => result.push_str("\\n"),
            '\t' => result.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                result.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => result.push(c),
        }
    }
    result
}

fn should_suppress_request_error(error: &(dyn std::error::Error + 'static)) -> bool {
    if error_chain_contains_io_kind(
        error,
        &[
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::ConnectionAborted,
            std::io::ErrorKind::BrokenPipe,
            std::io::ErrorKind::UnexpectedEof,
        ],
    ) {
        return true;
    }

    let message = error.to_string().to_ascii_lowercase();
    message.contains("invalid http request")
        || message.contains("missing request line")
        || message.contains("timed out")
        || message.contains("connection reset")
        || message.contains("connection abort")
}

fn error_chain_contains_io_kind(
    error: &(dyn std::error::Error + 'static),
    expected: &[std::io::ErrorKind],
) -> bool {
    let mut current = Some(error);
    while let Some(err) = current {
        if let Some(io_error) = err.downcast_ref::<std::io::Error>() {
            if expected.iter().any(|kind| io_error.kind() == *kind) {
                return true;
            }
        }
        current = err.source();
    }
    false
}

#[derive(Debug, Clone)]
struct HttpRequest {
    method: String,
    path: String,
    query: String,
    body: String,
    headers: HashMap<String, String>,
}

impl HttpRequest {
    fn query_value(&self, key: &str) -> Option<String> {
        parse_pairs(&self.query)
            .into_iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    fn form_value(&self, key: &str) -> Option<String> {
        parse_pairs(&self.body)
            .into_iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }
}

fn parse_pairs(input: &str) -> Vec<(String, String)> {
    input
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (url_decode(name), url_decode(value))
        })
        .collect()
}

fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut raw: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'+' => raw.push(b' '),
            b'%' => {
                if index + 2 < bytes.len() {
                    let hex = &input[(index + 1)..(index + 3)];
                    if let Ok(value) = u8::from_str_radix(hex, 16) {
                        raw.push(value);
                        index += 2;
                    } else {
                        raw.push(byte);
                    }
                } else {
                    raw.push(byte);
                }
            }
            other => raw.push(other),
        }
        index += 1;
    }
    String::from_utf8(raw).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        create_session, error_chain_contains_io_kind, escape_json, parse_pairs,
        should_suppress_request_error, snapshot_response_from_runtime, url_decode,
        write_sse_stream_response, AppRuntime, NativePlatform,
    };
    use octocode_api::ProviderRegistry;
    use octocode_core::{ConfigPaths, PermissionMode, PlatformSupport, ProviderFactory, RuntimeConfig, SessionStore};
    use octocode_runtime::{CoordinatorEngine, FileSessionStore, RuntimeProviderRouter, TaskStore, WorkspaceToolExecutor};
    use serde_json::Value;
    use std::io::ErrorKind;

    fn build_test_runtime(label: &str) -> (AppRuntime, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "octocode_cli_server_test_{}_{}_{}",
            std::process::id(),
            label,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let paths = ConfigPaths {
            config_home: root.join("config").to_string_lossy().to_string(),
            cache_home: root.join("cache").to_string_lossy().to_string(),
            data_home: root.join("data").to_string_lossy().to_string(),
        };
        std::fs::create_dir_all(&paths.config_home).expect("create config dir");
        std::fs::create_dir_all(&paths.cache_home).expect("create cache dir");
        std::fs::create_dir_all(&paths.data_home).expect("create data dir");

        let config = RuntimeConfig {
            provider_id: Some(String::from("stub")),
            provider_base_url: None,
            default_model: Some(String::from("stub")),
            permission_mode: PermissionMode::WorkspaceWrite,
            history_limit: 24,
            denied_tools: Vec::new(),
            request_timeout_secs: 5,
            config_version: 0,
            agent_max_iterations: 0,
        };
        let platform = NativePlatform::detect(root.to_string_lossy().to_string());
        let registry = ProviderRegistry::new();
        let store = FileSessionStore::new(&paths).expect("create session store");
        let mut runtime = super::OctocodeRuntime::new(
            RuntimeProviderRouter::from_factory(&registry, &config).expect("build router"),
            store,
            WorkspaceToolExecutor::with_shell(
                platform.context().root.clone(),
                platform.context().preferred_shell.clone(),
            ),
            platform.context().clone(),
            registry.descriptors().to_vec(),
        );
        runtime.task_store = TaskStore::new();
        runtime.coordinator = CoordinatorEngine::new();
        (runtime, root)
    }

    fn response_json(response: &str) -> Value {
        let (_, body) = response
            .split_once("\r\n\r\n")
            .expect("http response body");
        serde_json::from_str(body).expect("valid json body")
    }

    #[test]
    fn url_decode_ascii() {
        assert_eq!(url_decode("hello+world"), "hello world");
        assert_eq!(url_decode("a%20b"), "a b");
    }

    #[test]
    fn url_decode_multibyte_utf8() {
        // 中 = E4 B8 AD
        assert_eq!(url_decode("%E4%B8%AD"), "中");
        // 日本語 = E6 97 A5 E6 9C AC E8 AA 9E
        assert_eq!(url_decode("%E6%97%A5%E6%9C%AC%E8%AA%9E"), "日本語");
    }

    #[test]
    fn url_decode_mixed() {
        assert_eq!(url_decode("hello+%E4%B8%96%E7%95%8C"), "hello 世界");
    }

    #[test]
    fn escape_json_control_chars() {
        let input = "hello\x00world\x1f";
        let escaped = escape_json(input);
        assert_eq!(escaped, "hello\\u0000world\\u001f");
    }

    #[test]
    fn escape_json_standard_escapes() {
        assert_eq!(escape_json("a\"b\\c\r\n\t"), "a\\\"b\\\\c\\r\\n\\t");
    }

    #[test]
    fn parse_pairs_with_utf8() {
        let pairs = parse_pairs("key=%E4%B8%AD&name=test");
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], (String::from("key"), String::from("中")));
        assert_eq!(pairs[1], (String::from("name"), String::from("test")));
    }

    #[test]
    fn suppresses_localized_connection_reset_errors_by_kind() {
        let error = std::io::Error::new(
            ErrorKind::ConnectionReset,
            "远程主机强迫关闭了一个现有的连接。",
        );
        assert!(should_suppress_request_error(&error));
        assert!(error_chain_contains_io_kind(&error, &[ErrorKind::ConnectionReset]));
    }

    #[test]
    fn does_not_suppress_unexpected_runtime_errors() {
        let error = std::io::Error::other("disk full");
        assert!(!should_suppress_request_error(&error));
    }

    #[test]
    fn state_endpoint_response_includes_turn_lifecycle_contract() {
        let (runtime, _root) = build_test_runtime("state-endpoint");
        runtime
            .prompt_in_session("demo", "confirm lifecycle")
            .expect("run prompt in session");

        let response = snapshot_response_from_runtime(&runtime, Some("demo"))
            .expect("snapshot response");
        let body = response_json(&response);
        let turn = &body["activeSession"]["turn"];

        assert_eq!(turn["phase"], "completed");
        assert!(turn["turnId"].as_str().is_some_and(|value| value.starts_with("demo-")));
        assert!(turn["startedAtMs"].is_number());
        assert!(turn["updatedAtMs"].is_number());
        assert!(turn["finishedAtMs"].is_number());
        assert_eq!(turn["activeSseClients"], 0);
    }

    #[test]
    fn sse_stream_response_emits_done_and_persists_completed_turn() {
        let (runtime, _root) = build_test_runtime("sse-endpoint");
        let mut output = Vec::new();

        write_sse_stream_response(&mut output, &runtime, "demo", "stream lifecycle")
            .expect("write sse response");

        let text = String::from_utf8(output).expect("utf8 sse output");
        assert!(text.contains("HTTP/1.1 200 OK"));
        assert!(text.contains("Content-Type: text/event-stream"));
        assert!(text.contains("data: [DONE]"));
        assert!(!text.contains("\"error\":"));

        let snapshot = response_json(
            &snapshot_response_from_runtime(&runtime, Some("demo"))
                .expect("snapshot response after sse"),
        );
        let turn = &snapshot["activeSession"]["turn"];
        assert_eq!(turn["phase"], "completed");
        assert_eq!(turn["activeSseClients"], 0);
    }

    #[test]
    fn create_session_persists_requested_title() {
        let (_runtime, root) = build_test_runtime("create-session");
        let paths = ConfigPaths {
            config_home: root.join("config").to_string_lossy().to_string(),
            cache_home: root.join("cache").to_string_lossy().to_string(),
            data_home: root.join("data").to_string_lossy().to_string(),
        };
        let store = FileSessionStore::new(&paths).expect("create store");

        let session_id = create_session(&store, Some(String::from("Browser Session")))
            .expect("create session");

        let created = store
            .list_sessions()
            .expect("list sessions")
            .into_iter()
            .find(|session| session.id == session_id)
            .expect("created session summary");
        assert_eq!(created.title, "Browser Session");
    }

    #[test]
    fn ws_magic_matches_rfc6455() {
        assert_eq!(super::WS_MAGIC, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    }

    #[test]
    fn ws_hub_tracks_connections() {
        let hub = crate::ws::WsHub::new();
        assert_eq!(hub.connection_count(), 0);
        // hub.gc() should not panic on empty
        hub.gc();
        assert_eq!(hub.connection_count(), 0);
    }

    #[test]
    fn ws_accept_key_rfc6455_example() {
        use sha1::Digest;
        // RFC 6455 §4.2.2 example
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let combined = format!("{}{}", key.trim(), "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");

        let mut hasher = sha1::Sha1::new();
        hasher.update(combined.as_bytes());
        let accept = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            hasher.finalize(),
        );
        assert_eq!(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    // P13-B: `/metrics` body smoke test. Confirms the three Prometheus
    // series operators depend on are all present and well-formed, without
    // binding a socket or going through route_request. If this breaks, an
    // external scraper will break too.
    #[test]
    fn metrics_body_contains_required_series() {
        let body = super::render_metrics_body();
        assert!(
            body.contains("# TYPE octocode_requests_total counter"),
            "requests_total TYPE missing from /metrics body:\n{body}"
        );
        assert!(
            body.contains("# TYPE octocode_errors_total counter"),
            "errors_total TYPE missing from /metrics body:\n{body}"
        );
        assert!(
            body.contains("# TYPE octocode_build_info gauge"),
            "build_info TYPE missing from /metrics body:\n{body}"
        );
        // The build_info gauge must carry the crate version as a label so
        // scrapers can correlate a running instance with a release.
        let expected_version = env!("CARGO_PKG_VERSION");
        assert!(
            body.contains(&format!(
                "octocode_build_info{{version=\"{expected_version}\"}} 1"
            )),
            "build_info gauge missing version label; body:\n{body}"
        );
    }
}
