use octocode_api::ProviderRegistry;
use octocode_commands::{execute_command, parse_cli_args, render_json, render_text};
use octocode_core::{OutputMode, PlatformSupport};
use octocode_runtime::{
    ConfigLoader, FileSessionStore, NativePlatform, OctocodeRuntime, WorkspaceToolExecutor,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let platform = NativePlatform::detect(String::from("."));
    let config = ConfigLoader::new(platform.config_paths()).load()?;
    let registry = ProviderRegistry::new();
    let provider = config
        .provider_id
        .as_deref()
        .and_then(|provider_id| registry.create_by_id(provider_id))
        .unwrap_or_else(|| registry.create_default());
    let store = FileSessionStore::new(&platform.config_paths())?;
    let mut runtime = OctocodeRuntime::new(
        provider,
        store,
        WorkspaceToolExecutor::new(platform.context().root.clone()),
        platform.context().clone(),
        registry.all().to_vec(),
    );

    let parsed = parse_cli_args(std::env::args().skip(1));
    let output = execute_command(&mut runtime, parsed.command)?;

    if parsed.output_mode == OutputMode::Json {
        println!("{}", render_json(&output));
    } else {
        println!("{}", render_text(&output));
    }

    Ok(())
}
