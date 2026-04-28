use std::fs;
use std::path::Path;

use octocode_core::OctoError;

/// Maximum file size for read operations (10 MB).
pub const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

/// Maximum file size for write operations (5 MB).
pub const MAX_WRITE_SIZE: u64 = 5 * 1024 * 1024;

/// Bytes to scan for binary detection.
const BINARY_PROBE_SIZE: usize = 8192;

/// Extensions that should never be written by automated tools.
const BLOCKED_WRITE_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "bat", "cmd", "ps1", "sh", "com", "scr",
    "msi", "vbs", "wsf", "hta", "cpl", "inf", "reg", "lnk", "pif",
];

/// Check if a file is likely binary by scanning for NUL bytes in the first 8KB.
pub fn is_binary_file(path: &Path) -> Result<bool, OctoError> {
    let file = fs::File::open(path)
        .map_err(|e| OctoError::Runtime(format!("file-guard: cannot open {}: {e}", path.display())))?;
    let mut reader = std::io::BufReader::new(file);
    let mut buf = vec![0u8; BINARY_PROBE_SIZE];
    use std::io::Read;
    let n = reader.read(&mut buf).unwrap_or(0);
    Ok(buf[..n].contains(&0u8))
}

/// Enforce maximum read size.
pub fn check_read_size(path: &Path) -> Result<(), OctoError> {
    let meta = fs::metadata(path)
        .map_err(|e| OctoError::Runtime(format!("file-guard: cannot stat {}: {e}", path.display())))?;
    if meta.len() > MAX_READ_SIZE {
        return Err(OctoError::Runtime(format!(
            "file-guard: {} is {} bytes, exceeds read limit of {} bytes",
            path.display(),
            meta.len(),
            MAX_READ_SIZE
        )));
    }
    Ok(())
}

/// Enforce maximum write size.
pub fn check_write_size(content: &[u8]) -> Result<(), OctoError> {
    if content.len() as u64 > MAX_WRITE_SIZE {
        return Err(OctoError::Runtime(format!(
            "file-guard: content is {} bytes, exceeds write limit of {} bytes",
            content.len(),
            MAX_WRITE_SIZE
        )));
    }
    Ok(())
}

/// Detect symlink escape: resolve the path and ensure it stays within the workspace root.
pub fn check_symlink_escape(path: &Path, workspace_root: &Path) -> Result<(), OctoError> {
    let mut probe = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(workspace_root)
            .to_path_buf()
    };

    while !probe.exists() {
        let Some(parent) = probe.parent() else {
            break;
        };
        if parent == probe {
            break;
        }
        probe = parent.to_path_buf();
    }

    let resolved = probe.canonicalize().unwrap_or(probe);
    let root = workspace_root.canonicalize().unwrap_or_else(|_| workspace_root.to_path_buf());

    if !resolved.starts_with(&root) {
        return Err(OctoError::Runtime(format!(
            "file-guard: symlink escape detected — '{}' resolves outside workspace '{}'",
            path.display(),
            root.display()
        )));
    }
    Ok(())
}

/// Full file guard check for read operations.
pub fn guard_read(path: &Path, workspace_root: &Path) -> Result<(), OctoError> {
    check_symlink_escape(path, workspace_root)?;
    if path.exists() {
        check_read_size(path)?;
        if is_binary_file(path)? {
            return Err(OctoError::Runtime(format!(
                "file-guard: '{}' appears to be a binary file",
                path.display()
            )));
        }
    }
    Ok(())
}

/// Full file guard check for write operations.
pub fn guard_write(path: &Path, content: &[u8], workspace_root: &Path) -> Result<(), OctoError> {
    check_symlink_escape(path, workspace_root)?;
    check_write_size(content)?;
    check_blocked_extension(path)?;
    Ok(())
}

/// Reject writes to dangerous executable extensions.
fn check_blocked_extension(path: &Path) -> Result<(), OctoError> {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let lower = ext.to_ascii_lowercase();
        if BLOCKED_WRITE_EXTENSIONS.contains(&lower.as_str()) {
            return Err(OctoError::Runtime(format!(
                "file-guard: writing .{} files is blocked for security",
                lower
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn binary_detection_text_file() {
        let dir = std::env::temp_dir().join("octocode_fileguard_test");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("text.txt");
        fs::write(&file, "Hello, world!\nLine 2\n").unwrap();
        assert!(!is_binary_file(&file).unwrap());
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn binary_detection_binary_file() {
        let dir = std::env::temp_dir().join("octocode_fileguard_test");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("binary.bin");
        let mut f = fs::File::create(&file).unwrap();
        f.write_all(&[0x89, 0x50, 0x4E, 0x47, 0x00, 0x00, 0x00]).unwrap();
        assert!(is_binary_file(&file).unwrap());
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn write_size_within_limit() {
        let content = vec![b'a'; 1024];
        assert!(check_write_size(&content).is_ok());
    }

    #[test]
    fn write_size_exceeds_limit() {
        let content = vec![b'a'; (MAX_WRITE_SIZE + 1) as usize];
        assert!(check_write_size(&content).is_err());
    }

    #[test]
    fn symlink_escape_normal_path() {
        let root = std::env::current_dir().unwrap();
        let path = root.join("Cargo.toml");
        // Only check if path exists
        if path.exists() {
            assert!(check_symlink_escape(&path, &root).is_ok());
        }
    }

    #[test]
    fn symlink_escape_allows_nested_new_path_inside_workspace() {
        let root = std::env::temp_dir().join(format!("octocode-fileguard-nested-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let nested = root.join("webui-e2e").join("site").join("index.html");
        assert!(check_symlink_escape(&nested, &root).is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn blocked_extension_exe() {
        let root = std::env::temp_dir().join(format!("octocode-fileguard-ext-{}", std::process::id()));
        let _ = fs::create_dir_all(&root);
        let path = root.join("malware.exe");
        assert!(guard_write(&path, b"hello", &root).is_err());
    }

    #[test]
    fn blocked_extension_bat() {
        let root = std::env::temp_dir().join(format!("octocode-fileguard-ext-{}", std::process::id()));
        let _ = fs::create_dir_all(&root);
        let path = root.join("script.BAT");
        assert!(guard_write(&path, b"echo hi", &root).is_err());
    }

    #[test]
    fn allowed_extension_rs() {
        let root = std::env::temp_dir().join(format!("octocode-fileguard-ext-{}", std::process::id()));
        let _ = fs::create_dir_all(&root);
        let path = root.join("main.rs");
        assert!(guard_write(&path, b"fn main() {}", &root).is_ok());
    }
}
