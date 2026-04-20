use std::net::TcpStream;
use std::thread;
use std::time::{Duration, Instant};

use octocode_commands::{is_allowed_web_port, WEB_PORT_MAX, WEB_PORT_MIN};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::{Icon, WindowBuilder};
use wry::WebViewBuilder;

use crate::server;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn launch_desktop(
    port: u16,
    session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    if !is_allowed_web_port(port) {
        return Err(format!(
            "port {} is out of allowed range {}-{}",
            port, WEB_PORT_MIN, WEB_PORT_MAX
        )
        .into());
    }

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
        .with_title(format!("Octocode {}", APP_VERSION))
        .with_window_icon(Some(octocode_window_icon()?))
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

fn octocode_window_icon() -> Result<Icon, Box<dyn std::error::Error>> {
    const SIZE: usize = 128;
    let mut rgba = vec![0_u8; SIZE * SIZE * 4];

    paint_star(&mut rgba, SIZE, 64, 16, 13, [247, 168, 58, 255]);
    paint_star(&mut rgba, SIZE, 32, 36, 10, [247, 168, 58, 255]);
    paint_star(&mut rgba, SIZE, 96, 36, 10, [247, 168, 58, 255]);
    paint_circle(&mut rgba, SIZE, 48, 22, 4, [249, 194, 100, 255]);
    paint_circle(&mut rgba, SIZE, 80, 22, 4, [249, 194, 100, 255]);

    let ink = [215, 86, 79, 255];
    paint_circle(&mut rgba, SIZE, 64, 66, 28, ink);
    paint_rounded_bar(&mut rgba, SIZE, 18, 74, 28, 16, 8, ink);
    paint_rounded_bar(&mut rgba, SIZE, 82, 74, 28, 16, 8, ink);
    paint_rounded_bar(&mut rgba, SIZE, 46, 88, 12, 26, 6, ink);
    paint_rounded_bar(&mut rgba, SIZE, 58, 90, 12, 30, 6, ink);
    paint_rounded_bar(&mut rgba, SIZE, 70, 88, 12, 26, 6, ink);

    paint_circle(&mut rgba, SIZE, 52, 62, 10, [255, 248, 240, 255]);
    paint_circle(&mut rgba, SIZE, 76, 62, 10, [255, 248, 240, 255]);
    paint_circle(&mut rgba, SIZE, 52, 62, 4, ink);
    paint_circle(&mut rgba, SIZE, 76, 62, 4, ink);

    Ok(Icon::from_rgba(rgba, SIZE as u32, SIZE as u32)?)
}

fn paint_star(rgba: &mut [u8], size: usize, cx: i32, cy: i32, radius: i32, color: [u8; 4]) {
    for y in (cy - radius)..=(cy + radius) {
        for x in (cx - radius)..=(cx + radius) {
            if (x - cx).abs() + (y - cy).abs() <= radius {
                paint_pixel(rgba, size, x, y, color);
            }
        }
    }
}

fn paint_circle(rgba: &mut [u8], size: usize, cx: i32, cy: i32, radius: i32, color: [u8; 4]) {
    let radius_sq = radius * radius;
    for y in (cy - radius)..=(cy + radius) {
        for x in (cx - radius)..=(cx + radius) {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= radius_sq {
                paint_pixel(rgba, size, x, y, color);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_rounded_bar(
    rgba: &mut [u8],
    size: usize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    radius: i32,
    color: [u8; 4],
) {
    for yy in y..(y + height) {
        for xx in x..(x + width) {
            let left = x + radius;
            let right = x + width - radius - 1;
            let top = y + radius;
            let bottom = y + height - radius - 1;
            let inside_core = (xx >= left && xx <= right) || (yy >= top && yy <= bottom);
            let inside_corner = {
                let corner_x = if xx < left { left } else if xx > right { right } else { xx };
                let corner_y = if yy < top { top } else if yy > bottom { bottom } else { yy };
                let dx = xx - corner_x;
                let dy = yy - corner_y;
                dx * dx + dy * dy <= radius * radius
            };
            if inside_core || inside_corner {
                paint_pixel(rgba, size, xx, yy, color);
            }
        }
    }
}

fn paint_pixel(rgba: &mut [u8], size: usize, x: i32, y: i32, color: [u8; 4]) {
    if x < 0 || y < 0 || x >= size as i32 || y >= size as i32 {
        return;
    }
    let index = ((y as usize * size) + x as usize) * 4;
    rgba[index..(index + 4)].copy_from_slice(&color);
}