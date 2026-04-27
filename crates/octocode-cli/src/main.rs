mod desktop;
mod server;
mod agent_loop_cli;
mod continuation;
mod sub_loop;
mod resource_governor;

use octocode_commands::{execute_command, parse_cli_args, render_json, render_text, CliCommand};
use octocode_core::{OutputMode, PlatformSupport};
use octocode_runtime::{ConfigLoader, NativePlatform};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // 🔥 Enhanced agent-loop CLI
    if args.first().map(String::as_str) == Some("agent-loop") {
        let session_id = args.get(1).cloned().unwrap_or_else(|| String::from("demo"));
        let goal = if args.len() > 2 {
            args[2..].join(" ")
        } else {
            String::from("continue current task")
        };

        let platform = NativePlatform::detect(String::from("."));
        let config = ConfigLoader::new(platform.config_paths()).load()?;
        let mut runtime = server::build_runtime(platform.context().root.clone(), config)?;

        let data_home = runtime.config_paths().data_home;
        let workspace_root = platform.context().root.clone();

        // 🔥 Continuation + file memory
        let continuation_ctx = continuation::prepare_continuation_context(
            &data_home,
            &workspace_root,
            &session_id,
            &goal,
        )?;

        let goal = continuation::augment_goal_with_continuation(&goal, &continuation_ctx);

        // 🔥 Parallel planning (safe)
        let plans = sub_loop::run_parallel_planning(&goal);
        for p in &plans {
            println!("sub-plan => {}", p);
        }

        // 🔥 Main agent loop
        let summary = agent_loop_cli::run_agent_loop_cli(&mut runtime, &session_id, &goal)?;
        println!("{}", summary);

        // 🔥 Save continuation summary
        continuation::save_continuation_summary(&data_home, &session_id, &goal, &summary)?;

        // 🔥 Resource control (CRITICAL)
        resource_governor::enforce_agent_resource_budget(&data_home)?;

        return Ok(());
    }

    let parsed = parse_cli_args(args.into_iter());
    if let CliCommand::Serve { port, session_id } = parsed.command.clone() {
        server::run_server(port, session_id)?;
        return Ok(());
    }
    if let CliCommand::Desktop { port, session_id } = parsed.command.clone() {
        desktop::launch_desktop(port, session_id)?;
        return Ok(());
    }

    let platform = NativePlatform::detect(String::from("."));
    let config = ConfigLoader::new(platform.config_paths()).load()?;
    let mut runtime = server::build_runtime(platform.context().root.clone(), config)?;
    let output = execute_command(&mut runtime, parsed.command)?;

    if parsed.output_mode == OutputMode::Json {
        println!("{}", render_json(&output));
    } else {
        println!("{}", render_text(&output));
    }

    Ok(())
}
