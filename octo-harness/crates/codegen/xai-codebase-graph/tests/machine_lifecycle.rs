use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

fn run(root: &Path, operation: &str, arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_code-graph"))
        .args(["machine", operation])
        .arg(root)
        .args(arguments)
        .output()
        .unwrap()
}

fn success(root: &Path, operation: &str, arguments: &[&str]) -> Value {
    let output = run(root, operation, arguments);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("stdout must contain only one JSON document")
}

#[test]
fn native_index_closed_lifecycle_and_project_boundaries() {
    let project = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = project.path();
    // A tracked hidden file and a tracked newly ignored file must not bypass
    // the scanner. Untracked source must be included on the first build.
    let repo = git2::Repository::init(root).unwrap();
    std::fs::write(root.join("main.rs"), "pub fn lifecycleAlpha() {}\n").unwrap();
    std::fs::write(root.join(".hidden.rs"), "pub fn secretHidden() {}\n").unwrap();
    std::fs::write(root.join("ignored.rs"), "pub fn secretIgnored() {}\n").unwrap();
    let mut git_index = repo.index().unwrap();
    for file in ["main.rs", ".hidden.rs", "ignored.rs"] {
        git_index.add_path(Path::new(file)).unwrap();
    }
    git_index.write().unwrap();
    std::fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
    std::fs::write(root.join(".rooignore"), "private.rs\n").unwrap();
    std::fs::write(root.join("private.rs"), "pub fn secretPrivate() {}\n").unwrap();
    std::fs::write(
        root.join("untracked.rs"),
        "pub fn lifecycleUntracked() {}\n",
    )
    .unwrap();
    std::fs::create_dir(root.join("node_modules")).unwrap();
    std::fs::write(
        root.join("node_modules/dep.rs"),
        "pub fn secretDependency() {}\n",
    )
    .unwrap();
    assert_eq!(success(root, "status", &[])["indexed"], false);
    assert!(!root.join(".goto_index.bin").exists());
    let built = success(root, "index", &[]);
    assert_eq!(built["indexed"], true);
    assert_eq!(built["files"], 2);
    assert_eq!(
        success(root, "search", &["--query", "lifecycleAlpha"])["results"][0]["symbol"],
        "lifecycleAlpha"
    );
    assert_eq!(
        success(root, "search", &["--query", "UNTRACKED"])["results"][0]["symbol"],
        "lifecycleUntracked"
    );
    assert_eq!(
        success(root, "search", &["--query", "secret"])["results"],
        json!([])
    );
    // Every call is a fresh process: persistence cannot be supplied by hot state.
    assert_eq!(success(root, "status", &[])["files"], 2);
    assert!(
        !run(
            root,
            "search",
            &[
                "--query",
                "lifecycle",
                "--directory",
                other.path().to_str().unwrap()
            ]
        )
        .status
        .success()
    );
    assert!(
        !run(other.path(), "search", &["--query", "lifecycle"])
            .status
            .success()
    );
    std::fs::write(root.join("main.rs"), "pub fn lifecycleBeta() {}\n").unwrap();
    success(root, "index", &[]);
    assert_eq!(
        success(root, "search", &["--query", "lifecycleAlpha"])["results"],
        json!([])
    );
    assert_eq!(
        success(root, "search", &["--query", "lifecycleBeta"])["results"][0]["line"],
        1
    );
    // New exclusions apply immediately even before a rebuild of the old cache.
    std::fs::write(root.join(".rooignore"), "main.rs\nprivate.rs\n").unwrap();
    assert_eq!(
        success(root, "search", &["--query", "lifecycleBeta"])["results"],
        json!([])
    );
    std::fs::write(other.path().join("keep.rs"), "pub fn otherProject() {}\n").unwrap();
    success(other.path(), "index", &[]);
    success(root, "clear", &[]);
    assert!(!root.join(".goto_index.bin").exists());
    assert_eq!(success(root, "status", &[])["indexed"], false);
    assert!(
        !run(root, "search", &["--query", "lifecycle"])
            .status
            .success()
    );
    assert_eq!(
        success(other.path(), "search", &["--query", "otherProject"])["results"][0]["symbol"],
        "otherProject"
    );
    success(other.path(), "clear", &[]);
}

#[test]
fn native_api_rejects_invalid_cache_without_mutating_it() {
    let project = tempfile::tempdir().unwrap();
    let cache = project.path().join(".goto_index.bin");
    std::fs::create_dir(&cache).unwrap();
    assert!(!run(project.path(), "status", &[]).status.success());
    assert!(!run(project.path(), "clear", &[]).status.success());
    assert!(cache.is_dir());
}
