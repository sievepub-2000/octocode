use super::*;

/// Poll `t.is_finished()` until it returns `true` or the deadline elapses.
/// Returns `true` if the thread finished in time.
/// This replaces a fixed `sleep` so these tests don't flake under heavy CPU contention (e.g. `bazel test --runs_per_test 50`).
fn wait_for_finish(t: &SessionThread, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while !t.is_finished() {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    true
}

const FINISH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[test]
fn session_thread_detects_normal_exit() {
    let t = SessionThread::from_handle(std::thread::spawn(|| {}));
    assert!(
        wait_for_finish(&t, FINISH_TIMEOUT),
        "thread did not finish within {FINISH_TIMEOUT:?}"
    );
    assert!(t.join().is_ok());
}

#[test]
fn session_thread_detects_panic() {
    let t = SessionThread::from_handle(std::thread::spawn(|| {
        panic!("intentional test panic");
    }));
    assert!(
        wait_for_finish(&t, FINISH_TIMEOUT),
        "thread did not finish within {FINISH_TIMEOUT:?}"
    );
    assert!(t.join().is_err(), "finished is not proof of success");
}

#[derive(Clone, Copy)]
enum ActorExitCase {
    Shutdown,
    DropMailbox,
    PanicAfterTeardown,
    Abort,
}

/// The real run_session loop and the production completion bridge, on a real OS thread.
fn actor_exit_thread(case: ActorExitCase) -> SessionThread {
    let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let thread_completed = Arc::clone(&completed);
    let handle = std::thread::spawn(move || {
        let owned = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            let (gateway_tx, mut gateway_rx) = mpsc::unbounded_channel();
            tokio::task::spawn_local(async move {
                while let Some(message) = gateway_rx.recv().await {
                    if let xai_acp_lib::AcpClientMessage::SessionNotification(args) = message {
                        let _ = args.response_tx.send(Ok(()));
                    }
                }
            });
            let (persistence_tx, mut persistence_rx) = mpsc::unbounded_channel();
            tokio::task::spawn_local(async move {
                while let Some(message) = persistence_rx.recv().await {
                    if let PersistenceMsg::FlushAndAck { respond_to } = message {
                        let _ = respond_to.send(Ok(()));
                    }
                }
            });
            let (mut actor, event_rx) =
                support::create_test_actor_ex(0, 256_000, 85, gateway_tx, persistence_tx).await;
            actor.session_info.cwd = owned.path().to_string_lossy().into_owned();
            actor.events = crate::session::events::EventTracker::new(owned.path());
            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            let (_chat_tx, chat_rx) = mpsc::unbounded_channel();
            let (done_tx, done_rx) = tokio::sync::oneshot::channel();
            let task = tokio::task::spawn_local(async move {
                run_session(
                    Arc::new(actor),
                    cmd_rx,
                    chat_rx,
                    event_rx,
                    None,
                    Arc::new(parking_lot::Mutex::new(CodebaseIndexManager::new())),
                    owned.path().to_path_buf(),
                    fs_watch::FsWatchCapabilities::none(),
                )
                .await;
                if matches!(case, ActorExitCase::PanicAfterTeardown) {
                    panic!("injected actor failure after real teardown");
                }
                let _ = done_tx.send(());
            });
            // Let the real loop initialize before exercising termination.
            tokio::task::yield_now().await;
            match case {
                ActorExitCase::Shutdown | ActorExitCase::PanicAfterTeardown => {
                    cmd_tx
                        .send(SessionCommand::Shutdown(
                            crate::session::ShutdownKind::Graceful,
                        ))
                        .unwrap();
                }
                ActorExitCase::DropMailbox => drop(cmd_tx),
                ActorExitCase::Abort => task.abort(),
            }
            let exit =
                tokio::time::timeout(FINISH_TIMEOUT, SessionThread::wait_for_actor_exit(done_rx))
                    .await
                    .expect("actor exit pipeline must finish");
            thread_completed.store(exit.is_ok(), std::sync::atomic::Ordering::Release);
        });
    });
    SessionThread::from_actor_handle(handle, completed)
}

#[test]
#[serial_test::serial]
fn session_thread_real_actor_shutdown_exits_cleanly() {
    let thread = actor_exit_thread(ActorExitCase::Shutdown);
    assert!(wait_for_finish(&thread, FINISH_TIMEOUT));
    assert!(thread.join().is_ok());
}

#[test]
#[serial_test::serial]
fn session_thread_real_actor_mailbox_drop_exits_cleanly() {
    let thread = actor_exit_thread(ActorExitCase::DropMailbox);
    assert!(wait_for_finish(&thread, FINISH_TIMEOUT));
    assert!(thread.join().is_ok());
}

#[test]
#[serial_test::serial]
fn session_thread_real_actor_panic_is_not_normal_os_thread_exit() {
    let thread = actor_exit_thread(ActorExitCase::PanicAfterTeardown);
    assert!(wait_for_finish(&thread, FINISH_TIMEOUT));
    assert!(thread.join().is_err());
}

#[test]
#[serial_test::serial]
fn session_thread_real_actor_abort_is_not_normal_os_thread_exit() {
    let thread = actor_exit_thread(ActorExitCase::Abort);
    assert!(wait_for_finish(&thread, FINISH_TIMEOUT));
    assert!(thread.join().is_err());
}

#[test]
fn session_thread_not_finished_while_running() {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let t = SessionThread::from_handle(std::thread::spawn(move || {
        let _ = rx.recv(); // Block until signaled
    }));
    assert!(!t.is_finished());
    drop(tx); // Signal thread to exit
    assert!(
        wait_for_finish(&t, FINISH_TIMEOUT),
        "thread did not finish within {FINISH_TIMEOUT:?} after dropping tx"
    );
}

/// Regression test: per-session threads run independently.
///
/// Spawns two session threads, each with their own tokio runtime and LocalSet.
/// Thread A blocks for 3 seconds (simulating a long tool call).
/// Thread B completes a quick task.
/// Asserts that B finishes within 1 second, proving A's blocking work does not stall B.
///
/// On the old single-LocalSet architecture, both tasks would share one thread and B would be blocked until A's sleep yields.
/// With per-session threads, they run on separate OS threads with true parallelism.
#[test]
fn sessions_on_separate_threads_do_not_block_each_other() {
    let (result_tx, result_rx) = std::sync::mpsc::channel::<&str>();

    let result_tx_a = result_tx.clone();
    let _thread_a = SessionThread::from_handle(std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            // Simulate a long-running tool call (e.g., bash sleep)
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let _ = result_tx_a.send("A done");
        });
    }));

    let result_tx_b = result_tx;
    let _thread_b = SessionThread::from_handle(std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            // A quick task that completes immediately
            tokio::task::yield_now().await;
            let _ = result_tx_b.send("B done");
        });
    }));

    // B should finish well before A's 3-second sleep.
    let first = result_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("Neither session completed within 1 second — threads may be blocked");
    assert_eq!(
        first, "B done",
        "Expected B to finish first (A sleeps 3s), but got: {first}"
    );
}
