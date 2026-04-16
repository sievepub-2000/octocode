use std::net::TcpStream;
use std::thread;
use std::time::{Duration, Instant};

use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

use crate::server;

pub fn launch_desktop(
    port: u16,
    session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let server_session = session_id.clone();
    thread::spawn(move || {
        if let Err(error) = server::run_server(port, server_session) {
            eprintln!("desktop server error: {error}");
        }
    });

    wait_for_server(port, Duration::from_secs(12))?;

    #[cfg(target_os = "linux")]
    gtk::init()?;

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Octocode")
        .with_inner_size(tao::dpi::LogicalSize::new(1440.0, 960.0))
        .build(&event_loop)?;

    let mut url = format!("http://127.0.0.1:{port}/ui-shell/");
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        url.push_str(&format!("?session={}", session_id));
    }

    let builder = WebViewBuilder::new().with_url(&url);

    #[cfg(not(target_os = "linux"))]
    let _webview = builder.build(&window)?;

    #[cfg(target_os = "linux")]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().unwrap();
        builder.build_gtk(vbox)?
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        #[cfg(target_os = "linux")]
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }

        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}

fn wait_for_server(port: u16, timeout: Duration) -> Result<(), Box<dyn std::error::Error>> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }

    Err(format!("timed out waiting for local server on port {port}").into())
}