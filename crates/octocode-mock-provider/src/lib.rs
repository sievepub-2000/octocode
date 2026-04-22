use std::collections::VecDeque;
use std::sync::Mutex;

use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderCapabilities,
    ProviderDescriptor, ProviderKind, TokenInfo,
};

/// A captured request-response pair for deterministic replay.
#[derive(Debug, Clone)]
pub struct MockScenario {
    /// Optional pattern to match against the prompt text.
    pub prompt_contains: Option<String>,
    /// The canned response to return.
    pub response: String,
    /// Simulated token counts.
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// Mock LLM provider for deterministic testing.
///
/// Supports two modes:
/// 1. **Queue mode**: responses are dequeued in order.
/// 2. **Pattern mode**: responses are matched by prompt content.
///
/// If no match is found, returns a default echo response.
pub struct MockProvider {
    id: String,
    queue: Mutex<VecDeque<MockScenario>>,
    patterns: Vec<MockScenario>,
    request_log: Mutex<Vec<PromptRequest>>,
}

impl MockProvider {
    /// Create a mock with a fixed response queue.
    pub fn with_queue(responses: Vec<String>) -> Self {
        let queue = responses
            .into_iter()
            .map(|response| MockScenario {
                prompt_contains: None,
                response,
                input_tokens: 10,
                output_tokens: 20,
            })
            .collect();
        Self {
            id: String::from("mock"),
            queue: Mutex::new(queue),
            patterns: Vec::new(),
            request_log: Mutex::new(Vec::new()),
        }
    }

    /// Create a mock with pattern-matched scenarios.
    pub fn with_patterns(patterns: Vec<MockScenario>) -> Self {
        Self {
            id: String::from("mock"),
            queue: Mutex::new(VecDeque::new()),
            patterns,
            request_log: Mutex::new(Vec::new()),
        }
    }

    /// Create a mock that always returns the same response.
    pub fn echo() -> Self {
        Self {
            id: String::from("mock-echo"),
            queue: Mutex::new(VecDeque::new()),
            patterns: Vec::new(),
            request_log: Mutex::new(Vec::new()),
        }
    }

    /// Create a mock that always returns an error.
    pub fn failing(error_msg: &str) -> Self {
        let msg = String::from(error_msg);
        Self {
            id: String::from("mock-fail"),
            queue: Mutex::new(VecDeque::from(vec![])),
            patterns: vec![MockScenario {
                prompt_contains: None,
                response: format!("ERROR:{msg}"),
                input_tokens: 0,
                output_tokens: 0,
            }],
            request_log: Mutex::new(Vec::new()),
        }
    }

    /// Get all captured requests for assertions.
    pub fn captured_requests(&self) -> Vec<PromptRequest> {
        self.request_log.lock().unwrap().clone()
    }

    /// Number of requests received.
    pub fn request_count(&self) -> usize {
        self.request_log.lock().unwrap().len()
    }

    fn find_response(&self, prompt: &str) -> MockScenario {
        // Try queue first.
        if let Some(scenario) = self.queue.lock().unwrap().pop_front() {
            return scenario;
        }
        // Then try pattern match.
        for pattern in &self.patterns {
            if let Some(needle) = &pattern.prompt_contains {
                if prompt.contains(needle.as_str()) {
                    return pattern.clone();
                }
            } else {
                // Catch-all pattern.
                return pattern.clone();
            }
        }
        // Default echo.
        MockScenario {
            prompt_contains: None,
            response: format!("[mock-echo] {}", &prompt[..prompt.len().min(200)]),
            input_tokens: (prompt.len() / 4) as u32,
            output_tokens: 10,
        }
    }
}

impl ModelProvider for MockProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: self.id.clone(),
            display_name: String::from("Mock Provider"),
            kind: ProviderKind::Stub,
            supports_tools: true,
            supports_streaming: true,
            capabilities: ProviderCapabilities::compatible(true, true),
        }
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        self.request_log.lock().unwrap().push(request.clone());

        let scenario = self.find_response(&request.text);

        if scenario.response.starts_with("ERROR:") {
            return Err(OctoError::Provider(
                scenario.response[6..].to_string(),
            ));
        }

        Ok(PromptResponse {
            output: scenario.response,
            tokens: Some(TokenInfo::new(scenario.input_tokens, scenario.output_tokens)),
        })
    }

    fn prompt_stream(
        &self,
        request: PromptRequest,
        on_token: &mut dyn FnMut(&str) -> bool,
    ) -> Result<PromptResponse, OctoError> {
        let response = self.prompt(request)?;
        // Simulate streaming by emitting word-by-word.
        for word in response.output.split_whitespace() {
            if !on_token(word) || !on_token(" ") {
                return Err(OctoError::Runtime(String::from("stream cancelled")));
            }
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_mode_fifo() {
        let mock = MockProvider::with_queue(vec![
            String::from("first"),
            String::from("second"),
        ]);
        let r1 = mock.prompt(PromptRequest {
            text: String::from("a"),
            model: None,
            system_prompt: None,
            history: vec![],
        }).unwrap();
        assert_eq!(r1.output, "first");

        let r2 = mock.prompt(PromptRequest {
            text: String::from("b"),
            model: None,
            system_prompt: None,
            history: vec![],
        }).unwrap();
        assert_eq!(r2.output, "second");

        // Exhausted queue falls back to echo.
        let r3 = mock.prompt(PromptRequest {
            text: String::from("c"),
            model: None,
            system_prompt: None,
            history: vec![],
        }).unwrap();
        assert!(r3.output.contains("mock-echo"));
    }

    #[test]
    fn pattern_mode_match() {
        let mock = MockProvider::with_patterns(vec![
            MockScenario {
                prompt_contains: Some(String::from("fix bug")),
                response: String::from("I'll fix the bug"),
                input_tokens: 5,
                output_tokens: 10,
            },
            MockScenario {
                prompt_contains: Some(String::from("deploy")),
                response: String::from("Deploying now"),
                input_tokens: 5,
                output_tokens: 10,
            },
        ]);

        let r = mock.prompt(PromptRequest {
            text: String::from("please fix bug #123"),
            model: None,
            system_prompt: None,
            history: vec![],
        }).unwrap();
        assert_eq!(r.output, "I'll fix the bug");
    }

    #[test]
    fn echo_mode() {
        let mock = MockProvider::echo();
        let r = mock.prompt(PromptRequest {
            text: String::from("hello world"),
            model: None,
            system_prompt: None,
            history: vec![],
        }).unwrap();
        assert!(r.output.contains("hello world"));
    }

    #[test]
    fn failing_provider() {
        let mock = MockProvider::failing("service unavailable");
        let r = mock.prompt(PromptRequest {
            text: String::from("hello"),
            model: None,
            system_prompt: None,
            history: vec![],
        });
        assert!(r.is_err());
    }

    #[test]
    fn request_capture() {
        let mock = MockProvider::echo();
        mock.prompt(PromptRequest {
            text: String::from("test1"),
            model: None,
            system_prompt: None,
            history: vec![],
        }).unwrap();
        mock.prompt(PromptRequest {
            text: String::from("test2"),
            model: None,
            system_prompt: None,
            history: vec![],
        }).unwrap();
        assert_eq!(mock.request_count(), 2);
        assert_eq!(mock.captured_requests()[0].text, "test1");
    }

    #[test]
    fn streaming_emits_tokens() {
        let mock = MockProvider::with_queue(vec![String::from("hello world")]);
        let mut tokens = Vec::new();
        mock.prompt_stream(
            PromptRequest {
                text: String::from("hi"),
                model: None,
                system_prompt: None,
                history: vec![],
            },
            &mut |token| {
                tokens.push(String::from(token));
                true
            },
        ).unwrap();
        assert!(!tokens.is_empty());
    }

    #[test]
    fn descriptor_has_capabilities() {
        let mock = MockProvider::echo();
        let desc = mock.descriptor();
        assert!(desc.supports_tools);
        assert!(desc.supports_streaming);
        assert_eq!(desc.kind, ProviderKind::Stub);
    }
}
