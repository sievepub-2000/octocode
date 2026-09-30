use octocode_host::store::Store;
use serde_json::Value;
use std::fs;

#[test]
fn logical_project_lifecycle_preserves_original_files_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_str().unwrap();
    let db = temp.path().join("runtime.db");
    let a = temp.path().join(".octocode/sessions/YQ/report.txt");
    let b = temp.path().join(".octocode/sessions/Yg/report.txt");
    for path in [&a,&b] { fs::create_dir_all(path.parent().unwrap()).unwrap(); }
    fs::write(&a,"first session output").unwrap();
    fs::write(&b,"second session output").unwrap();
    let before = (fs::metadata(&a).unwrap().modified().unwrap(),fs::metadata(&b).unwrap().modified().unwrap());
    let project;
    {
        let store = Store::open(&db).unwrap();
        for id in ["a","b"] { assert!(store.create_session(id,id,Some(root)).unwrap().project_id.is_none()); }
        project = store.create_project("中文项目 / logical name", &["a".into(),"b".into()],None).unwrap();
        assert!(store.refresh_project_indexes().unwrap()["warnings"].as_array().unwrap().is_empty());
        let index = store.project_index(&project.id).unwrap();
        assert_eq!(index["sessions"].as_array().unwrap().len(),2);
        let paths: Vec<_> = index["sessions"].as_array().unwrap().iter().map(|s| s["artifacts"][0]["path"].as_str().unwrap()).collect();
        let paths: Vec<_> = paths.into_iter().map(|path| fs::canonicalize(path).unwrap()).collect();
        assert!(paths.contains(&fs::canonicalize(&a).unwrap()) && paths.contains(&fs::canonicalize(&b).unwrap()));
        assert_eq!(fs::read_dir(&project.directory).unwrap().count(),1,"project stores only the text index");
        assert!(store.assign_project(&["a".into(),"missing".into()],None).is_err());
        assert_eq!(store.session("a").unwrap().unwrap().project_id.as_deref(),Some(project.id.as_str()),"failed batch must not partially detach");
        store.rename_project(&project.id,"renamed").unwrap();
        store.refresh_project_indexes().unwrap();
    }
    {
        let store = Store::open(&db).unwrap();
        assert_eq!(store.project(&project.id).unwrap().name,"renamed");
        assert_eq!(store.session("b").unwrap().unwrap().project_id.as_deref(),Some(project.id.as_str()));
        store.assign_project(&["a".into()],None).unwrap();
        assert!(store.session("a").unwrap().unwrap().project_id.is_none());
        store.delete_project(&project.id).unwrap();
        assert!(store.session("b").unwrap().unwrap().project_id.is_none());
        assert!(store.projects().unwrap().is_empty());
        let index: Value = serde_json::from_slice(&fs::read(std::path::Path::new(&project.directory).join("artifacts.json")).unwrap()).unwrap();
        assert_eq!(index["archived"],true);
    }
    assert_eq!(fs::read_to_string(&a).unwrap(),"first session output");
    assert_eq!(fs::read_to_string(&b).unwrap(),"second session output");
    assert_eq!(before,(fs::metadata(&a).unwrap().modified().unwrap(),fs::metadata(&b).unwrap().modified().unwrap()));
}

#[test]
fn project_created_empty_is_filed_under_the_caller_workspace() {
    // Made from the sidebar before there is anything to group: no session can say
    // where it belongs, so the caller's workspace does, and without one it fails
    // rather than landing somewhere arbitrary.
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(":memory:").unwrap();
    assert!(store.create_project("no workspace", &[], None).is_err());
    let project = store.create_project("空项目", &[], root.path().to_str()).unwrap();
    assert_eq!(project.name, "空项目");
    assert_eq!(fs::canonicalize(&project.workspace).unwrap(), fs::canonicalize(root.path()).unwrap());
    assert_eq!(store.project_index(&project.id).unwrap()["sessions"].as_array().unwrap().len(), 0);
    // Sessions can join it afterwards the same way they join any other project.
    store.create_session("a", "a", root.path().to_str()).unwrap();
    store.assign_project(&["a".into()], Some(&project.id)).unwrap();
    assert_eq!(store.session("a").unwrap().unwrap().project_id.as_deref(), Some(project.id.as_str()));
}

#[test]
fn project_validation_and_derived_index_failure_do_not_corrupt_membership() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let store = Store::open(":memory:").unwrap();
    store.create_session("a","a",root.path().to_str()).unwrap();
    store.create_session("b","b",other.path().to_str()).unwrap();
    assert!(store.create_project(" ",&["a".into()],None).is_err());
    assert!(store.create_project("bad",&["a".into(),"b".into()],None).is_err());
    assert!(store.projects().unwrap().is_empty());
    let p=store.create_project("valid",&["a".into()],None).unwrap();
    assert!(store.assign_project(&["b".into()],Some(&p.id)).is_err());
    let index = std::path::Path::new(&p.directory).join("artifacts.json");
    fs::remove_file(&index).unwrap();
    fs::create_dir(&index).unwrap();
    assert_eq!(store.refresh_project_indexes().unwrap()["warnings"].as_array().unwrap().len(),1);
    assert_eq!(store.session("a").unwrap().unwrap().project_id,Some(p.id));
    fs::remove_dir(&index).unwrap();
    assert!(store.refresh_project_indexes().unwrap()["warnings"].as_array().unwrap().is_empty());
}
