use octocode_host::{agent::AgentRun, store::Store, supervisor::{self, Advisor}, worktree};
use serde_json::json;
use std::{fs, path::Path, process::Command};

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git").args(args).current_dir(repo).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn repository(path: &Path) {
    fs::create_dir(path).unwrap();
    git(path, &["init", "-q"]);
    git(path, &["-c", "user.name=Audit", "-c", "user.email=audit@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
}

#[test]
fn native_remote_branches_keep_head_substrings_and_exclude_symbolic_refs() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    repository(&repo);
    for name in ["refs/remotes/origin/HEAD-fix", "refs/remotes/origin/featureHEAD", "refs/remotes/origin/main", "refs/remotes/other/HEAD"] {
        git(&repo, &["update-ref", name, "HEAD"]);
    }
    git(&repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    let branches = worktree::branches(&repo).unwrap();
    assert_eq!(branches.remote_branches, ["origin/HEAD-fix", "origin/featureHEAD", "origin/main", "other/HEAD"]);
}

#[test]
fn native_relative_worktree_delete_uses_supplied_cwd_and_keeps_other_repos() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let other = temp.path().join("other");
    repository(&repo);
    repository(&other);
    let target = repo.join("task");
    let other_target = other.join("task");
    worktree::create(&repo, &target, None, None, false).unwrap();
    worktree::create(&other, &other_target, None, None, false).unwrap();
    fs::write(other_target.join("keep.txt"), "original data").unwrap();
    assert!(worktree::remove(&repo, &other_target, true).is_err());
    assert_eq!(fs::read_to_string(other_target.join("keep.txt")).unwrap(), "original data");
    assert_ne!(fs::canonicalize(&repo).unwrap(), fs::canonicalize(std::env::current_dir().unwrap()).unwrap());
    worktree::remove(&repo, Path::new("task"), false).unwrap();
    assert!(!target.exists());
    assert!(other_target.exists());
    let nested_target = repo.join("second-task");
    worktree::create(&repo, &nested_target, None, None, false).unwrap();
    let subdir = repo.join("subdir");
    fs::create_dir(&subdir).unwrap();
    worktree::remove(&subdir, Path::new("../second-task"), false).unwrap();
    assert!(!nested_target.exists());
    assert_eq!(worktree::list(&repo).unwrap().len(), 1);
    worktree::remove(&other, &other_target, true).unwrap();
}

fn project_failure(trigger: &str, assign: bool) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let db = temp.path().join("test.db");
    let store = Store::open(&db).unwrap();
    store.create_session("a", "fixture", root.to_str()).unwrap();
    let original = store.create_project("original", &["a".into()], None).unwrap();
    let original_index = fs::read(Path::new(&original.directory).join("artifacts.json")).unwrap();
    let parent = Path::new(&original.directory).parent().unwrap();
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection.execute_batch(trigger).unwrap();
    let sessions = if assign { vec!["a".to_owned()] } else { vec![] };
    assert!(store.create_project("must roll back", &sessions, root.to_str()).is_err());
    assert_eq!(store.projects().unwrap().len(), 1);
    assert_eq!(store.session("a").unwrap().unwrap().project_id.as_deref(), Some(original.id.as_str()));
    assert_eq!(fs::read_dir(parent).unwrap().count(), 1, "failed creation must not leave a project directory/index");
    assert_eq!(fs::read(Path::new(&original.directory).join("artifacts.json")).unwrap(), original_index);
    drop(connection);
    drop(store);
    let restarted = Store::open(&db).unwrap();
    assert_eq!(restarted.projects().unwrap().len(), 1);
    assert_eq!(restarted.session("a").unwrap().unwrap().project_id.as_deref(), Some(original.id.as_str()));
}

#[test]
fn native_project_insert_failure_leaves_no_index() {
    project_failure("CREATE TRIGGER reject_project BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'controlled insert failure'); END;", false);
}

#[test]
fn native_project_membership_failure_rolls_back_index_and_original_assignment() {
    project_failure("CREATE TRIGGER reject_membership BEFORE UPDATE OF project_id ON sessions BEGIN SELECT RAISE(ABORT, 'controlled membership failure'); END;", true);
}

#[test]
fn native_project_commit_failure_rolls_back_index_and_assignment() {
    project_failure(
        "CREATE TABLE deferred_failure(project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
         CREATE TRIGGER reject_commit AFTER INSERT ON projects BEGIN INSERT INTO deferred_failure VALUES('missing-project'); END;",
        true,
    );
}

#[test]
fn native_project_filesystem_failure_does_not_commit_database_changes() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::open(":memory:").unwrap();
    store.create_session("a", "fixture", temp.path().to_str()).unwrap();
    fs::create_dir(temp.path().join(".octocode")).unwrap();
    let blocker = temp.path().join(".octocode/projects");
    fs::write(&blocker, "existing user file").unwrap();
    assert!(store.create_project("blocked", &["a".into()], None).is_err());
    assert!(store.projects().unwrap().is_empty());
    assert!(store.session("a").unwrap().unwrap().project_id.is_none());
    assert_eq!(fs::read_to_string(&blocker).unwrap(), "existing user file");
    fs::remove_file(&blocker).unwrap();
    let created = store.create_project("retry", &["a".into()], None).unwrap();
    assert_eq!(store.session("a").unwrap().unwrap().project_id, Some(created.id));
}

fn model() -> serde_json::Value {
    json!({"model":"fixture", "base_url":"http://127.0.0.1:9/v1", "api_backend":"chat_completions", "context_window":65536, "max_completion_tokens":1000})
}

#[tokio::test]
async fn native_malformed_advisor_template_returns_error_instead_of_panicking() {
    for value in [json!("invalid"), json!([]), json!(7), json!(true)] {
        let mut advisor_model = model();
        advisor_model["extra_body"] = json!({"chat_template_kwargs":value});
        let advisor: Advisor = serde_json::from_value(json!({"model":advisor_model})).unwrap();
        let error = supervisor::review(&advisor, "fixture", &[], "done").await.unwrap_err();
        assert!(error.to_string().contains("chat_template_kwargs"), "{error}");
    }
}

#[test]
fn native_omitted_supervision_matches_empty_object_and_keeps_explicit_opt_out() {
    let mut request = json!({"task_id":"fixture", "session_id":"fixture", "executable":"fixture", "harness_home":"fixture", "cwd":"fixture", "prompt":"fixture", "model":model()});
    let omitted: AgentRun = serde_json::from_value(request.clone()).unwrap();
    request["supervision"] = json!({});
    let empty: AgentRun = serde_json::from_value(request.clone()).unwrap();
    for run in [&omitted, &empty] {
        assert_eq!(run.supervision.max_interventions, 3);
        assert_eq!(run.supervision.endpoint_retry_secs, 30);
        assert!(run.supervision.fallbacks.is_empty());
        assert!(run.supervision.advisor.is_none());
        assert!(run.supervision.stream_rules.is_none());
    }
    request["supervision"] = json!({"max_interventions":0, "endpoint_retry_secs":0, "stream_rules":[]});
    let disabled: AgentRun = serde_json::from_value(request).unwrap();
    assert_eq!(disabled.supervision.max_interventions, 0);
    assert_eq!(disabled.supervision.endpoint_retry_secs, 0);
    assert!(disabled.supervision.stream_rules.unwrap().is_empty());
}
