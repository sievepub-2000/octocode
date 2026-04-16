use octocode_api::StubProvider;
use octocode_core::{ModelProvider, PromptRequest, SessionStore};
use octocode_runtime::MemorySessionStore;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let provider = StubProvider;
    let store = MemorySessionStore::new();

    let response = provider
        .prompt(PromptRequest {
            text: String::from("hello octocode"),
            model: None,
        })
        ?;

    println!("{}", response.output);

    for session in store.list_sessions()? {
        println!("session {} {}", session.id, session.title);
    }

    Ok(())
}