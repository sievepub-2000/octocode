use super::{Store, Session};
use std::{collections::BTreeSet, fs, io::Write, path::{Path, PathBuf}};
use anyhow::{Context, ensure};
use chrono::Utc;
use rusqlite::params;
use serde::{Serialize, Deserialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub directory: String,
    pub created_at: i64,
}

impl Store {
    pub fn projects(&self) -> rusqlite::Result<Vec<Project>> {
        self.conn.prepare("SELECT id,name,workspace,directory,created_at FROM projects ORDER BY created_at DESC")?
            .query_map([], |r| Ok(Project { id:r.get(0)?,name:r.get(1)?,workspace:r.get(2)?,directory:r.get(3)?,created_at:r.get(4)? }))?.collect()
    }

    pub fn project(&self, id: &str) -> anyhow::Result<Project> {
        self.projects()?.into_iter().find(|p| p.id == id).context("项目不存在，请刷新列表")
    }

    /// Creates a project, optionally with nothing in it yet.
    ///
    /// A project is filed under one workspace, and until now that could only be
    /// read off the sessions being grouped. Making one from the sidebar happens
    /// before there is anything to group, so the caller passes the workspace the
    /// window is open on; with sessions present they still decide, and they must
    /// agree with each other as before.
    pub fn create_project(&self, name: &str, ids: &[String], workspace: Option<&str>) -> anyhow::Result<Project> {
        let name = valid_name(name)?;
        let sessions = if ids.is_empty() { Vec::new() } else { self.project_sessions(ids)? };
        let workspace = match sessions.first() {
            Some(session) => session.workspace.as_deref().context("会话没有工作区")?,
            None => workspace.context("请先打开工作区")?,
        };
        let root = fs::canonicalize(workspace).context("工作区不可访问")?;
        ensure!(root.is_dir(), "工作区不是目录");
        for s in &sessions {
            ensure!(fs::canonicalize(s.workspace.as_deref().context("会话没有工作区")?)? == root, "只能归集同一工作区的会话");
        }
        let id = uuid::Uuid::now_v7().to_string();
        let directory_name = format!("{}-{}", Utc::now().format("%Y%m%d-%H%M%S"), id);
        let directory = root.join(".octocode").join("projects").join(&directory_name);
        ensure_owned_path(&root, &directory)?;
        let parent = directory.parent().context("项目索引目录无效")?;
        fs::create_dir_all(parent)?;
        // This guard owns only the newly created UUID directory. Any index or
        // database failure removes it; existing project/session files are untouched.
        let directory_guard = tempfile::Builder::new()
            .prefix(&directory_name).rand_bytes(0).tempdir_in(parent)?;
        let p = Project { id, name:name.to_owned(),workspace:workspace.to_owned(),directory:directory.to_string_lossy().into_owned(),created_at:Utc::now().timestamp_millis() };
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("INSERT INTO projects(id,name,workspace,directory,created_at) VALUES(?1,?2,?3,?4,?5)", params![p.id,p.name,p.workspace,p.directory,p.created_at])?;
        for s in sessions { tx.execute("UPDATE sessions SET project_id=?2 WHERE id=?1", params![s.id,p.id])?; }
        // Read back the pending transaction so the initial derived index already
        // reflects its assignments. Commit only after the index is written.
        write_index(&p, &self.project_index(&p.id)?)?;
        tx.commit()?;
        let _ = directory_guard.keep();
        Ok(p)
    }

    fn project_sessions(&self, ids: &[String]) -> anyhow::Result<Vec<Session>> {
        ensure!(!ids.is_empty() && ids.len() <= 1000, "请选择 1 到 1000 个会话");
        ids.iter().map(|id| self.session(id)?.context("会话不存在，请刷新列表")).collect()
    }

    pub fn assign_project(&self, ids: &[String], project_id: Option<&str>) -> anyhow::Result<()> {
        let sessions = self.project_sessions(ids)?;
        if let Some(id) = project_id {
            let p = self.project(id)?;
            let root = fs::canonicalize(&p.workspace)?;
            for s in &sessions {
                ensure!(fs::canonicalize(s.workspace.as_deref().context("会话没有工作区")?)? == root, "只能归集同一工作区的会话");
            }
        }
        let tx = self.conn.unchecked_transaction()?;
        for s in sessions { tx.execute("UPDATE sessions SET project_id=?2 WHERE id=?1", params![s.id,project_id])?; }
        tx.commit()?;
        Ok(())
    }

    pub fn rename_project(&self, id: &str, name: &str) -> anyhow::Result<()> {
        let name = valid_name(name)?;
        ensure!(self.conn.execute("UPDATE projects SET name=?2 WHERE id=?1",params![id,name])? == 1, "项目不存在");
        Ok(())
    }

    pub fn delete_project(&self, id: &str) -> anyhow::Result<()> {
        let p = self.project(id)?;
        // Preserve the last index for locating outputs after the grouping is removed.
        let mut index = self.project_index(id)?;
        index["archived"] = json!(true);
        write_index(&p, &index)?;
        ensure!(self.conn.execute("DELETE FROM projects WHERE id=?1", [id])? == 1, "项目不存在");
        Ok(())
    }

    pub fn project_index(&self, id: &str) -> anyhow::Result<Value> {
        let p = self.project(id)?;
        let mut sessions = Vec::new();
        for s in self.sessions()?.into_iter().filter(|s| s.project_id.as_deref() == Some(id)) {
            let directory = session_directory(s.workspace.as_deref().context("会话没有工作区")?, &s.id);
            let mut paths = BTreeSet::new();
            let mut warnings = Vec::new();
            if directory.exists() {
                if let Err(e) = collect_files(&directory, &mut paths) { warnings.push(e.to_string()); }
            }
            let registered: Vec<String> = self.conn.prepare("SELECT path FROM artifacts WHERE session_id=?1")?
                .query_map([&s.id], |row| row.get(0))?.collect::<Result<_, _>>()?;
            for path in registered {
                let path = PathBuf::from(path);
                paths.insert(if path.is_absolute() { path } else { directory.join(path) });
            }
            let artifacts: Vec<_> = paths.into_iter().map(|path| json!({"name":path.file_name().map(|s| s.to_string_lossy()),"path":path.to_string_lossy(),"exists":path.exists()})).collect();
            sessions.push(json!({"session_id":s.id,"title":s.title,"directory":directory.to_string_lossy(),"artifacts":artifacts,"warnings":warnings}));
        }
        Ok(json!({"schema_version":1,"project":p,"generated_at":Utc::now().to_rfc3339(),"sessions":sessions}))
    }

    pub fn refresh_project_indexes(&self) -> anyhow::Result<Value> {
        let mut warnings = Vec::new();
        for p in self.projects()? {
            match self.project_index(&p.id).and_then(|index| { write_index(&p,&index)?; Ok(index) }) {
                Ok(index) => for s in index["sessions"].as_array().into_iter().flatten() {
                    for warning in s["warnings"].as_array().into_iter().flatten() { warnings.push(json!({"project_id":p.id,"session_id":s["session_id"],"error":warning})); }
                },
                Err(e) => warnings.push(json!({"project_id":p.id,"error":e.to_string()})),
            }
        }
        Ok(json!({"warnings":warnings}))
    }
}

fn valid_name(name: &str) -> anyhow::Result<&str> {
    let name = name.trim();
    ensure!(!name.is_empty() && name.chars().count() <= 100 && !name.chars().any(char::is_control), "项目名须为 1 到 100 个非控制字符");
    Ok(name)
}

pub fn session_directory(workspace: &str, id: &str) -> PathBuf {
    // Same UTF-8 base64url encoding used by the extension's SID isolation path.
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut encoded = String::new();
    for chunk in id.as_bytes().chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for shift in [18,12,6,0].into_iter().take(chunk.len()+1) { encoded.push(ALPHABET[((n >> shift) & 63) as usize] as char); }
    }
    Path::new(workspace).join(".octocode").join("sessions").join(encoded)
}

fn collect_files(directory: &Path, paths: &mut BTreeSet<PathBuf>) -> anyhow::Result<()> {
    ensure!(!fs::symlink_metadata(directory)?.file_type().is_symlink(), "不遍历符号链接目录: {}", directory.display());
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_name() == ".octocode-isolated" { continue; }
        let ty = entry.file_type()?;
        if ty.is_dir() && !ty.is_symlink() { collect_files(&entry.path(), paths)?; }
        else { paths.insert(entry.path()); }
    }
    Ok(())
}

fn ensure_owned_path(root: &Path, target: &Path) -> anyhow::Result<()> {
    ensure!(target.starts_with(root) && target != root, "项目索引目录越界");
    let mut cursor = root.to_path_buf();
    for component in target.strip_prefix(root)?.components() {
        ensure!(matches!(component, std::path::Component::Normal(_)), "项目索引目录无效");
        cursor.push(component);
        if cursor.exists() { ensure!(fs::canonicalize(&cursor)?.starts_with(root), "项目索引目录链接越界"); }
    }
    Ok(())
}

fn write_index(p: &Project, index: &Value) -> anyhow::Result<()> {
    let root = fs::canonicalize(&p.workspace)?;
    let directory = Path::new(&p.directory);
    ensure_owned_path(&root, directory)?;
    fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer_pretty(&mut file, index)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    file.persist(directory.join("artifacts.json")).map_err(|e| e.error)?;
    Ok(())
}
