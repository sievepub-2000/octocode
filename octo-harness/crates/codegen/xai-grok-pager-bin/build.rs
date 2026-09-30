use std::path::Path;
use std::process::Command;

fn git_stdout(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
}

/// Reserve a larger main-thread stack for the Windows binaries.
///
/// The agent's config and session code recurses deeply enough that a debug
/// build overflows the 8 MB the MSVC linker reserves by default, and the
/// process dies with STATUS_STACK_OVERFLOW (0xC00000FD) before printing
/// anything -- `RUST_MIN_STACK` cannot help, since it only sizes threads
/// spawned by `std::thread`, never the main thread, whose stack the PE header
/// fixes at link time.
///
/// `rustc-link-arg-bins` scopes this to this package's own binaries, so it does
/// not invalidate the build of any dependency. The reserve is address space,
/// not committed memory; pages are committed on demand.
fn reserve_main_thread_stack() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bins=/STACK:33554432");
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=GROK_VERSION");
    reserve_main_thread_stack();

    // Watch the git files that change on commit/checkout so the version stamp refreshes
    // Never emit a missing path: cargo treats it as always dirty and rebuilds this crate every build
    let mut watch_paths = Vec::new();
    watch_paths.extend(git_stdout(&["rev-parse", "--git-path", "HEAD"]));
    watch_paths.extend(git_stdout(&["rev-parse", "--git-path", "logs/HEAD"]));
    if let Some(head_ref) = git_stdout(&["symbolic-ref", "-q", "HEAD"]) {
        watch_paths.extend(git_stdout(&["rev-parse", "--git-path", &head_ref]));
    }
    for path in watch_paths.iter().filter(|p| Path::new(p).exists()) {
        println!("cargo:rerun-if-changed={path}");
    }

    let commit = git_stdout(&["rev-parse", "HEAD"])
        .map(|s| s.chars().take(12).collect::<String>())
        .filter(|s| s.len() == 12)
        .unwrap_or_else(|| "unknown".to_string());

    let version = std::env::var("GROK_VERSION")
        .or_else(|_| std::env::var("CARGO_PKG_VERSION"))
        .unwrap_or_else(|_| "0.0.0".to_string());

    println!("cargo:rustc-env=VERSION_WITH_COMMIT={version} ({commit})");
}
