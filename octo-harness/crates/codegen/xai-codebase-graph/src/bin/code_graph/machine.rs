//! Narrow local extension API over the existing code graph cache.

use std::collections::HashSet;
use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde_json::{Value, json};
use xai_codebase_graph::{
    IndexBuilder, IndexOperation, LockResult, get_cache_path, load_index, save_index, try_lock,
};

#[derive(Subcommand)]
pub enum Operation {
    /// Rebuild the workspace's existing .goto_index.bin cache.
    Index { path: PathBuf },
    /// Load statistics without creating or rebuilding a cache.
    Status { path: PathBuf },
    /// Search symbol names (case insensitive, lexical, no network).
    Search {
        path: PathBuf,
        #[arg(long)]
        query: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        directory: Option<PathBuf>,
    },
    /// Remove only this workspace's code graph cache.
    Clear { path: PathBuf },
}

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn root(path: &Path) -> Result<PathBuf> {
    let root = dunce::canonicalize(path)?;
    if !root.is_dir() {
        return Err("Workspace is not a directory".into());
    }
    Ok(root)
}

fn check_cache(path: &Path) -> Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Index cache must not be a link".into());
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Index cache must be a regular file".into());
    }
    Ok(true)
}

pub fn run(operation: Operation) -> Result<()> {
    let path = match &operation {
        Operation::Index { path }
        | Operation::Clear { path }
        | Operation::Status { path }
        | Operation::Search { path, .. } => path,
    };
    let root = root(path)?;
    let cache = get_cache_path(&root);
    // Existing native actors also take this workspace's exclusive file lock.
    let _guard = match try_lock(&root, IndexOperation::Build) {
        LockResult::Acquired(guard) => guard,
        LockResult::Busy { operation, .. } => {
            return Err(format!("Workspace index is busy ({operation})").into());
        }
    };
    let exists = check_cache(&cache)?;
    let output: Value = match operation {
        Operation::Index { .. } => {
            let index = IndexBuilder::new().build(&root)?;
            // A cancelled build must preserve the last complete cache.
            save_index(&cache, &index)?;
            let (files, definitions, references) = index.stats();
            json!({"indexed": true, "files": files, "definitions": definitions, "references": references, "mode": "lexical-symbols"})
        }
        Operation::Status { .. } => {
            if exists {
                let index = load_index(&cache)?;
                let (files, definitions, references) = index.stats();
                json!({"indexed": true, "files": files, "definitions": definitions, "references": references, "mode": "lexical-symbols"})
            } else {
                json!({"indexed": false, "files": 0, "definitions": 0, "references": 0, "mode": "lexical-symbols"})
            }
        }
        Operation::Search {
            query,
            limit,
            directory,
            ..
        } => {
            if !exists {
                return Err("Workspace index is absent; build it before searching".into());
            }
            if query.len() > 4096 {
                return Err("Query is too long".into());
            }
            let prefix = if let Some(directory) = directory {
                let prefix = dunce::canonicalize(root.join(directory))?;
                if !prefix.starts_with(&root) || !prefix.is_dir() {
                    return Err("Search directory is outside the workspace".into());
                }
                Some(prefix)
            } else {
                None
            };
            // Recheck ignore rules and real paths after loading: a stale or copied
            // cache must not expose a deleted, newly ignored or outside file.
            let allowed: HashSet<_> = IndexBuilder::new()
                .workspace_files(&root)?
                .into_iter()
                .filter(|path| {
                    prefix
                        .as_ref()
                        .is_none_or(|prefix| path.starts_with(prefix))
                })
                .filter_map(|path| {
                    path.strip_prefix(&root)
                        .ok()
                        .map(|path| path.to_string_lossy().replace('\\', "/"))
                })
                .collect();
            let index = load_index(&cache)?;
            let results: Vec<_> = index.search_symbols(&query, limit.clamp(1, 200), |path| allowed.contains(&path.replace('\\', "/"))).into_iter()
                .map(|(symbol, path, line, score)| json!({"symbol": symbol, "path": path, "line": line, "score": score}))
                .collect();
            json!({"mode": "lexical-symbols", "results": results})
        }
        Operation::Clear { .. } => {
            if exists {
                fs::remove_file(&cache)?;
            }
            json!({"indexed": false, "files": 0, "definitions": 0, "references": 0, "mode": "lexical-symbols"})
        }
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
