//! Index caching for fast loading.
//!
//! Uses a custom binary format with magic bytes "SGIX" for the new interned format.
//! Automatically detects and skips legacy bincode format (returns error so caller can rebuild).

use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::scope_graph::ScopeGraphIndex;

/// Default cache file name.
pub const CACHE_FILE_NAME: &str = ".goto_index.bin";

/// Revision used to reject writes from an actor whose cache was cleared or
/// replaced by another process. Read and compare while holding workspace lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CacheRevision {
    modified: SystemTime,
    size: u64,
}

impl CacheRevision {
    pub(crate) fn read(path: &Path) -> std::io::Result<Option<Self>> {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(std::io::Error::other(
                    "Index cache must not be a reparse point",
                ));
            }
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(std::io::Error::other("Index cache must be a regular file"));
        }
        Ok(Some(Self {
            modified: metadata.modified()?,
            size: metadata.len(),
        }))
    }
}

/// Error type for cache operations.
#[derive(Debug)]
pub enum CacheError {
    /// IO error.
    IoError(std::io::Error),
    /// Serialization error.
    SerializeError(String),
    /// Deserialization error.
    DeserializeError(String),
    /// Legacy format detected (caller should rebuild).
    LegacyFormat,
}

impl std::fmt::Display for CacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CacheError::IoError(e) => write!(f, "IO error: {}", e),
            CacheError::SerializeError(msg) => write!(f, "Serialization error: {}", msg),
            CacheError::DeserializeError(msg) => write!(f, "Deserialization error: {}", msg),
            CacheError::LegacyFormat => write!(f, "Legacy cache format detected"),
        }
    }
}

impl std::error::Error for CacheError {}

impl From<std::io::Error> for CacheError {
    fn from(e: std::io::Error) -> Self {
        CacheError::IoError(e)
    }
}

/// Result type for cache operations.
pub type Result<T> = std::result::Result<T, CacheError>;

/// Get the default cache path for a repository.
pub fn get_cache_path(root_path: &Path) -> std::path::PathBuf {
    root_path.join(CACHE_FILE_NAME)
}

/// Load an index from cache.
///
/// Uses the new binary format with magic bytes "SGIX".
/// Returns `CacheError::LegacyFormat` if the file uses the old bincode format,
/// signaling to the caller that a rebuild is needed.
pub fn load_index(cache_path: &Path) -> Result<ScopeGraphIndex> {
    if !cache_path.exists() {
        return Err(CacheError::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Cache file not found",
        )));
    }

    // Use ScopeGraphIndex::load which handles format detection
    match ScopeGraphIndex::load(cache_path) {
        Ok(Some(index)) => Ok(index),
        Ok(None) => {
            // None means legacy format was detected
            tracing::info!(
                cache_path = %cache_path.display(),
                "Legacy cache format detected, will rebuild"
            );
            Err(CacheError::LegacyFormat)
        }
        Err(e) => Err(CacheError::IoError(e)),
    }
}

/// Atomically replace a complete cache. Writers must hold the workspace lock.
pub fn save_index(cache_path: &Path, index: &ScopeGraphIndex) -> Result<()> {
    CacheRevision::read(cache_path)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_nanos();
    let temporary = cache_path.with_extension(format!("bin.{}.{nonce}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        index.write_to(&mut file)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        CacheRevision::read(cache_path)?;
        std::fs::rename(&temporary, cache_path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(CacheError::IoError)
}

/// Save an index to cache asynchronously (in a background thread).
///
/// Returns immediately and spawns a thread to do the actual saving.
/// Useful for saving the index without blocking the main thread.
pub fn save_index_async(cache_path: std::path::PathBuf, index: ScopeGraphIndex) {
    std::thread::spawn(move || {
        let Some(workspace) = cache_path.parent() else {
            return;
        };
        let _guard = match super::try_lock(workspace, super::IndexOperation::Save) {
            super::LockResult::Acquired(guard) => guard,
            super::LockResult::Busy { .. } => return,
        };
        if let Err(e) = save_index(&cache_path, &index) {
            tracing::warn!("Failed to save index cache: {}", e);
        }
    });
}

/// Check if a cache exists and return its metadata.
pub fn cache_exists(cache_path: &Path) -> bool {
    cache_path.exists()
}

/// Get cache file size in bytes.
pub fn cache_size(cache_path: &Path) -> Option<u64> {
    std::fs::metadata(cache_path).ok().map(|m| m.len())
}
