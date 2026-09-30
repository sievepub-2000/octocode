use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub api_provider: Option<String>,
    pub api_model_id: Option<String>,
    pub api_key: Option<String>,
    pub tool_protocol: Option<String>,
    pub api_format: Option<String>,
    pub auto_context_window: Option<bool>,
    pub model_context_window: Option<u32>,
    pub model_max_tokens: Option<u32>,
    pub open_ai_native_base_url: Option<String>,
    pub open_ai_native_api_key: Option<String>,
    pub open_ai_model_id: Option<String>,
    pub open_ai_base_url: Option<String>,
    pub open_ai_api_key: Option<String>,
    pub open_ai_custom_model_info: Option<CustomModelInfo>,
    pub anthropic_base_url: Option<String>,
    pub open_router_model_id: Option<String>,
    pub deep_seek_base_url: Option<String>,
    pub deep_seek_api_key: Option<String>,
    pub gemini_api_key: Option<String>,
    pub google_gemini_base_url: Option<String>,
    pub qwen_code_base_url: Option<String>,
    pub qwen_code_api_key: Option<String>,
    pub kimi_code_base_url: Option<String>,
    pub kimi_code_api_key: Option<String>,
    pub moonshot_base_url: Option<String>,
    pub moonshot_api_key: Option<String>,
    pub minimax_base_url: Option<String>,
    pub minimax_api_key: Option<String>,
    pub zai_api_key: Option<String>,
    pub zai_api_line: Option<String>,
    pub mistral_codestral_url: Option<String>,
    pub mistral_api_key: Option<String>,
    pub xai_api_key: Option<String>,
    pub ollama_model_id: Option<String>,
    pub ollama_num_ctx: Option<u32>,
    pub lm_studio_model_id: Option<String>,
    pub lm_studio_base_url: Option<String>,
    pub vs_code_lm_model_selector: Option<VsCodeLmModelSelector>,
    /// Thinking tier chosen in the chat bar (`disable`, `none`, `minimal` … `max`).
    pub reasoning_effort: Option<String>,
    pub enable_reasoning_effort: Option<bool>,
    pub model_max_thinking_tokens: Option<u32>,
    /// How the selected model is told to think, detected by the extension:
    /// `effort` (a `reasoning_effort` field) or `template` (chat-template switch
    /// such as Qwen/GLM/DeepSeek hybrids on vLLM, oMLX, LM Studio).
    pub reasoning_style: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModelInfo {
    pub context_window: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VsCodeLmModelSelector {
    pub vendor: Option<String>,
    pub family: Option<String>,
    pub version: Option<String>,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiBackend {
    ChatCompletions,
    Responses,
    Messages,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelProfile {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub api_backend: ApiBackend,
    pub context_window: u32,
    pub max_completion_tokens: u32,
    /// `reasoning_effort` sent with every request (effort-style models).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// JSON object merged into chat/completions bodies (template-style models).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_body: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct ProviderRoute {
    pub model: ModelProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vs_code_lm_model_selector: Option<VsCodeLmModelSelector>,
}

/// Thinking tiers a template-style model gets as a `thinking_budget` (tokens).
/// `high` and above leave the budget open.
fn template_budget(tier: &str) -> Option<u32> {
    match tier {
        "minimal" => Some(512),
        "low" => Some(2_048),
        "medium" => Some(8_192),
        _ => None,
    }
}

/// Request controls for the chat-bar thinking tier. `(reasoning_effort, extra_body)`;
/// both `None` leaves the model's own default untouched.
pub fn thinking_controls(input: &ProviderInput) -> (Option<String>, Option<serde_json::Value>) {
    let tier = match (input.enable_reasoning_effort, input.reasoning_effort.as_deref()) {
        (Some(false), _) => "disable",
        (_, Some(tier)) => tier,
        (_, None) => return (None, None),
    };
    if !matches!(tier, "disable" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") {
        return (None, None);
    }
    let off = matches!(tier, "disable" | "none");
    match input.reasoning_style.as_deref() {
        Some("effort") => match tier {
            "disable" => (None, None),
            tier => (Some(tier.to_owned()), None),
        },
        Some("template") => {
            let mut body = serde_json::json!({"chat_template_kwargs": {"enable_thinking": !off}});
            if !off
                && let Some(budget) = input.model_max_thinking_tokens.filter(|b| *b > 0).or_else(|| template_budget(tier))
            {
                body["thinking_budget"] = budget.into();
            }
            (None, Some(body))
        }
        _ => (None, None),
    }
}

pub fn resolve(input: ProviderInput) -> anyhow::Result<ProviderRoute> {
    let (reasoning_effort, extra_body) = thinking_controls(&input);
    let output_tokens = input.model_max_tokens.unwrap_or(32_768);
    let explicit_context = if input.auto_context_window == Some(false) { input.model_context_window.or(match input.api_provider.as_deref() {
        Some("openai") => input.open_ai_custom_model_info.as_ref().and_then(|info| info.context_window),
        Some("ollama") => input.ollama_num_ctx,
        _ => None,
    }) } else { None };
    let api_format = input.api_format.clone();
    if api_format.as_deref().is_some_and(|value| !matches!(value, "chat_completions" | "responses" | "messages")) {
        anyhow::bail!("Unsupported API format");
    }
    let adapter_provider = input.api_provider.as_deref().filter(|provider| matches!(*provider,
        "bedrock" | "vertex" | "openai-codex" | "openrouter" | "requesty" | "unbound" | "litellm" |
        "sambanova" | "fireworks" | "friendli" | "vercel-ai-gateway" | "opencode-go" | "kenari" |
        "nanogpt" | "octocode-gateway" | "baseten" | "mimo" | "poe" | "ollama"
    )).map(str::to_owned);
    let mut vs_code_lm_model_selector = None;
    let mut model = match input.api_provider.as_deref() {
        Some(_) if adapter_provider.is_some() => ModelProfile {
            reasoning_effort: None,
            extra_body: None,
            model: input.api_model_id.or(input.open_router_model_id).or(input.ollama_model_id).unwrap_or_else(|| "provider-default".into()),
            base_url: "models-api://provider".into(),
            api_key: None,
            api_backend: ApiBackend::ChatCompletions,
            context_window: 131_072,
            max_completion_tokens: output_tokens,
        },
        Some("openai-native") => {
            let model = required_model(input.api_model_id)?;
            let base_url = input
                .open_ai_native_base_url
                .unwrap_or_else(|| "https://api.openai.com/v1".into());
            ModelProfile {
                reasoning_effort: None,
                extra_body: None,
                context_window: 131_072,
                model,
                api_key: local_key(input.open_ai_native_api_key, &base_url),
                api_backend: backend(input.tool_protocol.as_deref(), &base_url),
                base_url,
                max_completion_tokens: output_tokens,
            }
        }
        Some("openai") => {
            let model = required_model(input.open_ai_model_id)?;
            let base_url = input
                .open_ai_base_url
                .unwrap_or_else(|| "https://api.openai.com/v1".into());
            ModelProfile {
                reasoning_effort: None,
                extra_body: None,
                model,
                api_key: local_key(input.open_ai_api_key, &base_url),
                api_backend: backend(input.tool_protocol.as_deref(), &base_url),
                context_window: 131_072,
                base_url,
                max_completion_tokens: output_tokens,
            }
        }
        Some("anthropic") => ModelProfile {
            reasoning_effort: None,
            extra_body: None,
            model: required_model(input.api_model_id)?,
            base_url: input
                .anthropic_base_url
                .unwrap_or_else(|| "https://api.anthropic.com/v1".into()),
            api_key: input.api_key.filter(|key| !key.trim().is_empty()),
            api_backend: ApiBackend::Messages,
            context_window: 131_072,
            max_completion_tokens: output_tokens,
        },
        Some("deepseek") => compatible(
            required_model(input.api_model_id)?,
            input
                .deep_seek_base_url
                .unwrap_or_else(|| "https://api.deepseek.com/v1".into()),
            input.deep_seek_api_key,
            input.tool_protocol.as_deref(),
            128_000,
            output_tokens,
        ),
        Some("gemini") => compatible(
            required_model(input.api_model_id)?,
            input.google_gemini_base_url.unwrap_or_else(|| {
                "https://generativelanguage.googleapis.com/v1beta/openai".into()
            }),
            input.gemini_api_key,
            input.tool_protocol.as_deref(),
            1_000_000,
            output_tokens,
        ),
        Some("qwen-code") | Some("qwen") => compatible(
            required_model(input.api_model_id)?,
            input
                .qwen_code_base_url
                .unwrap_or_else(|| "https://dashscope.aliyuncs.com/compatible-mode/v1".into()),
            input.qwen_code_api_key,
            input.tool_protocol.as_deref(),
            1_000_000,
            output_tokens,
        ),
        Some("kimi-code") | Some("kimi") => compatible(
            required_model(input.api_model_id)?,
            input
                .kimi_code_base_url
                .unwrap_or_else(|| "https://api.moonshot.ai/v1".into()),
            input.kimi_code_api_key,
            input.tool_protocol.as_deref(),
            256_000,
            output_tokens,
        ),
        Some("moonshot") => compatible(
            required_model(input.api_model_id)?,
            input
                .moonshot_base_url
                .unwrap_or_else(|| "https://api.moonshot.ai/v1".into()),
            input.moonshot_api_key,
            input.tool_protocol.as_deref(),
            256_000,
            output_tokens,
        ),
        Some("minimax") => compatible(
            required_model(input.api_model_id)?,
            input
                .minimax_base_url
                .unwrap_or_else(|| "https://api.minimax.io/v1".into()),
            input.minimax_api_key,
            input.tool_protocol.as_deref(),
            204_800,
            output_tokens,
        ),
        Some("zai") | Some("glm") => compatible(
            required_model(input.api_model_id)?,
            zai_base_url(input.zai_api_line.as_deref()).into(),
            input.zai_api_key,
            input.tool_protocol.as_deref(),
            200_000,
            output_tokens,
        ),
        Some("mistral") => compatible(
            required_model(input.api_model_id)?,
            input
                .mistral_codestral_url
                .unwrap_or_else(|| "https://api.mistral.ai/v1".into()),
            input.mistral_api_key,
            input.tool_protocol.as_deref(),
            128_000,
            output_tokens,
        ),
        Some("xai") => compatible(
            required_model(input.api_model_id)?,
            "https://api.x.ai/v1".into(),
            input.xai_api_key,
            input.tool_protocol.as_deref(),
            256_000,
            output_tokens,
        ),
        Some("lmstudio") => compatible(
            required_model(input.lm_studio_model_id)?,
            input
                .lm_studio_base_url
                .unwrap_or_else(|| "http://127.0.0.1:1234/v1".into()),
            None,
            input.tool_protocol.as_deref(),
            128_000,
            output_tokens,
        ),
        Some("vscode-lm") => {
            let selector = input
                .vs_code_lm_model_selector
                .ok_or_else(|| anyhow::anyhow!("VS Code LM model selector is required"))?;
            let model = required_model(selector.id.clone().or(selector.family.clone()))?;
            vs_code_lm_model_selector = Some(selector);
            ModelProfile {
                reasoning_effort: None,
                extra_body: None,
                model,
                base_url: "vscode-lm://provider".into(),
                api_key: None,
                api_backend: ApiBackend::ChatCompletions,
                context_window: 200_000,
                max_completion_tokens: output_tokens,
            }
        }
        provider => anyhow::bail!(
            "provider {} is not supported by the OctoCode harness",
            provider.unwrap_or("unknown")
        ),
    };
    model.context_window = explicit_context.unwrap_or(131_072);
    if !(4_096..=100_000_000).contains(&model.context_window) || model.max_completion_tokens == 0 {
        anyhow::bail!("Context window or output token budget is invalid");
    }
    model.max_completion_tokens = model.max_completion_tokens.min(model.context_window - 1_024);
    if adapter_provider.is_none() {
        if let Some(format) = api_format.as_deref() {
            model.api_backend = match format {
                "responses" => ApiBackend::Responses,
                "messages" => ApiBackend::Messages,
                _ => ApiBackend::ChatCompletions,
            };
        }
    }
    model.reasoning_effort = reasoning_effort;
    model.extra_body = extra_body;
    validate(&model)?;
    Ok(ProviderRoute {
        model,
        adapter_provider,
        vs_code_lm_model_selector,
    })
}

fn compatible(
    model: String,
    base_url: String,
    api_key: Option<String>,
    protocol: Option<&str>,
    context_window: u32,
    max_completion_tokens: u32,
) -> ModelProfile {
    ModelProfile {
        reasoning_effort: None,
        extra_body: None,
        model,
        api_key: local_key(api_key, &base_url),
        api_backend: backend(protocol, &base_url),
        base_url,
        context_window,
        max_completion_tokens,
    }
}

fn backend(protocol: Option<&str>, _base_url: &str) -> ApiBackend {
    if protocol == Some("responses") {
        ApiBackend::Responses
    } else {
        ApiBackend::ChatCompletions
    }
}

fn zai_base_url(line: Option<&str>) -> &'static str {
    match line {
        Some("china_coding") => "https://open.bigmodel.cn/api/coding/paas/v4",
        Some("international_coding") => "https://api.z.ai/api/coding/paas/v4",
        Some("china_api") => "https://open.bigmodel.cn/api/paas/v4",
        _ => "https://api.z.ai/api/paas/v4",
    }
}

fn required_model(model: Option<String>) -> anyhow::Result<String> {
    let model = model.unwrap_or_default();
    if model.trim().is_empty() || model.contains(['\r', '\n']) {
        anyhow::bail!("model id is invalid");
    }
    Ok(model)
}

fn local_key(key: Option<String>, base_url: &str) -> Option<String> {
    key.filter(|value| !value.trim().is_empty()).or_else(|| {
        base_url
            .starts_with("http://")
            .then(|| "not-provided".into())
    })
}

fn validate(model: &ModelProfile) -> anyhow::Result<()> {
    if matches!(model.base_url.as_str(), "vscode-lm://provider" | "models-api://provider") {
        return Ok(());
    }
    if !model.base_url.starts_with("http://") && !model.base_url.starts_with("https://") {
        anyhow::bail!("model base_url must use http or https");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(provider: &str) -> ProviderInput {
        serde_json::from_value(serde_json::json!({"apiProvider": provider})).unwrap()
    }

    fn local(tier: Option<&str>, style: Option<&str>) -> ModelProfile {
        let mut settings = serde_json::json!({
            "apiProvider":"openai","openAiModelId":"qwen38-flash-next","openAiBaseUrl":"http://2.2.2.2:8000/v1"
        });
        if let Some(tier) = tier { settings["reasoningEffort"] = tier.into(); }
        if let Some(style) = style { settings["reasoningStyle"] = style.into(); }
        resolve(serde_json::from_value(settings).unwrap()).unwrap().model
    }

    #[test]
    fn thinking_tier_maps_to_the_models_own_switch() {
        // Template-style hybrids (Qwen/GLM/DeepSeek on vLLM, oMLX, LM Studio).
        let off = local(Some("disable"), Some("template"));
        assert_eq!(off.extra_body, Some(serde_json::json!({"chat_template_kwargs":{"enable_thinking":false}})));
        assert!(off.reasoning_effort.is_none());
        let low = local(Some("low"), Some("template"));
        assert_eq!(low.extra_body, Some(serde_json::json!({"chat_template_kwargs":{"enable_thinking":true},"thinking_budget":2048})));
        let high = local(Some("high"), Some("template"));
        assert_eq!(high.extra_body, Some(serde_json::json!({"chat_template_kwargs":{"enable_thinking":true}})));
        // Effort-style models get the field itself.
        assert_eq!(local(Some("medium"), Some("effort")).reasoning_effort.as_deref(), Some("medium"));
        assert!(local(Some("disable"), Some("effort")).reasoning_effort.is_none());
        // No tier, no detected style, or an unknown value: leave the model's default alone.
        for model in [local(None, Some("template")), local(Some("high"), None), local(Some("turbo"), Some("template"))] {
            assert!(model.reasoning_effort.is_none() && model.extra_body.is_none());
        }
    }

    #[test]
    fn explicit_thinking_budget_wins_and_disabled_switch_overrides_tier() {
        let mut settings: ProviderInput = serde_json::from_value(serde_json::json!({
            "apiProvider":"openai","openAiModelId":"q","reasoningEffort":"low","reasoningStyle":"template","modelMaxThinkingTokens":1234
        })).unwrap();
        assert_eq!(thinking_controls(&settings).1.unwrap()["thinking_budget"], 1234);
        settings.enable_reasoning_effort = Some(false);
        assert_eq!(thinking_controls(&settings).1.unwrap()["chat_template_kwargs"]["enable_thinking"], false);
    }

    #[test]
    fn cloud_adapters_are_explicit_and_never_return_credentials() {
        for provider in ["bedrock", "vertex", "openai-codex", "openrouter", "requesty", "litellm", "poe"] {
            let route = resolve(serde_json::from_value(serde_json::json!({
                "apiProvider":provider,"apiModelId":"test-model","apiKey":"secret",
                "openRouterApiKey":"secret","openRouterModelId":"test-model"
            })).unwrap()).unwrap();
            assert_eq!(route.adapter_provider.as_deref(), Some(provider));
            assert_eq!(route.model.base_url, "models-api://provider");
            assert!(route.model.api_key.is_none());
            assert_eq!(route.model.context_window, 131_072);
        }
        assert!(resolve(input("unrecognized-provider")).is_err());
    }

    #[test]
    fn automatic_context_ignores_stale_model_defaults_and_manual_context_is_validated() {
        let settings = serde_json::json!({"apiProvider":"openai", "openAiModelId":"qwen", "openAiCustomModelInfo":{"contextWindow":1_000_000}});
        assert_eq!(resolve(serde_json::from_value(settings.clone()).unwrap()).unwrap().model.context_window, 131_072);
        let mut manual = settings;
        manual["autoContextWindow"] = serde_json::json!(false);
        manual["modelContextWindow"] = serde_json::json!(8192);
        let model = resolve(serde_json::from_value(manual.clone()).unwrap()).unwrap().model;
        assert_eq!(model.context_window, 8192);
        assert!(model.max_completion_tokens < model.context_window);
        manual["modelContextWindow"] = serde_json::json!(0);
        assert!(resolve(serde_json::from_value(manual).unwrap()).is_err());
    }

    #[test]
    fn local_qwen_uses_tool_calls_without_login() {
        let route = resolve(
            serde_json::from_value(serde_json::json!({
                "apiProvider": "openai-native",
                "apiModelId": "qwen3.8-flash-next",
                "openAiNativeBaseUrl": "http://192.168.10.2:8000/v1"
            }))
            .unwrap(),
        )
        .unwrap();
        let model = route.model;
        assert!(matches!(model.api_backend, ApiBackend::ChatCompletions));
        assert_eq!(model.api_key.as_deref(), Some("not-provided"));
        assert_eq!(model.context_window, 131_072);

        let local_responses = resolve(
            serde_json::from_value(serde_json::json!({
                "apiProvider": "openai-native",
                "apiModelId": "qwen3.8-flash-next",
                "openAiNativeBaseUrl": "http://192.168.10.2:8000/v1",
                "toolProtocol": "responses"
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            local_responses.model.api_backend,
            ApiBackend::Responses
        ));

        let explicit = resolve(
            serde_json::from_value(serde_json::json!({
                "apiProvider": "openai-native",
                "apiModelId": "gpt-5",
                "openAiNativeBaseUrl": "https://api.openai.com/v1",
                "toolProtocol": "responses"
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(explicit.model.api_backend, ApiBackend::Responses));
    }

    #[test]
    fn providers_choose_a_single_harness_backend_without_agent_fallback() {
        let mut openai = input("openai");
        openai.open_ai_model_id = Some("gpt".into());
        openai.tool_protocol = Some("responses".into());
        assert!(matches!(
            resolve(openai).unwrap().model.api_backend,
            ApiBackend::Responses
        ));

        let mut anthropic = input("anthropic");
        anthropic.api_model_id = Some("claude".into());
        assert!(matches!(
            resolve(anthropic).unwrap().model.api_backend,
            ApiBackend::Messages
        ));

        let mut openrouter = input("openrouter");
        openrouter.open_router_model_id = Some("qwen/qwen3".into());
        assert!(matches!(
            resolve(openrouter).unwrap().model.api_backend,
            ApiBackend::ChatCompletions
        ));
        assert!(resolve(input("unsupported")).is_err());
    }

    #[test]
    fn xml_is_adapted_to_the_compatible_chat_completions_backend() {
        let route = resolve(
            serde_json::from_value(serde_json::json!({
                "apiProvider": "openai-native",
                "apiModelId": "qwen3.8-27b",
                "openAiNativeBaseUrl": "http://192.168.10.2:8000/v1",
                "toolProtocol": "xml"
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(matches!(
            route.model.api_backend,
            ApiBackend::ChatCompletions
        ));
    }

    #[test]
    fn openai_compatible_vendors_share_one_route() {
        for (provider, input) in [
            (
                "deepseek",
                serde_json::json!({"apiProvider":"deepseek","apiModelId":"deepseek-chat"}),
            ),
            (
                "mistral",
                serde_json::json!({"apiProvider":"mistral","apiModelId":"mistral-large-latest"}),
            ),
            (
                "xai",
                serde_json::json!({"apiProvider":"xai","apiModelId":"grok-4"}),
            ),
            (
                "ollama",
                serde_json::json!({"apiProvider":"ollama","ollamaModelId":"qwen3"}),
            ),
            (
                "lmstudio",
                serde_json::json!({"apiProvider":"lmstudio","lmStudioModelId":"local-model"}),
            ),
        ] {
            let route = resolve(serde_json::from_value(input).unwrap())
                .unwrap_or_else(|error| panic!("{provider}: {error}"));
            assert!(matches!(
                route.model.api_backend,
                ApiBackend::ChatCompletions
            ));
        }
    }

    #[test]
    fn approved_provider_matrix_uses_direct_login_free_routes() {
        let fixtures = [
            serde_json::json!({"apiProvider":"anthropic","apiModelId":"claude-sonnet-5","apiKey":"key"}),
            serde_json::json!({"apiProvider":"openai-native","apiModelId":"gpt-5.4","openAiNativeApiKey":"key"}),
            serde_json::json!({"apiProvider":"xai","apiModelId":"grok-4.5","xaiApiKey":"key"}),
            serde_json::json!({"apiProvider":"gemini","apiModelId":"gemini-3.7-flash","geminiApiKey":"key"}),
            serde_json::json!({"apiProvider":"deepseek","apiModelId":"deepseek-v4-flash","deepSeekApiKey":"key"}),
            serde_json::json!({"apiProvider":"qwen-code","apiModelId":"qwen3-coder-plus","qwenCodeApiKey":"key"}),
            serde_json::json!({"apiProvider":"kimi-code","apiModelId":"kimi-k2.5","kimiCodeApiKey":"key"}),
            serde_json::json!({"apiProvider":"minimax","apiModelId":"MiniMax-M2.7","minimaxApiKey":"key"}),
            serde_json::json!({"apiProvider":"zai","apiModelId":"glm-5.1","zaiApiKey":"key"}),
            serde_json::json!({"apiProvider":"openai-native","apiModelId":"qwen3.8-27b","openAiNativeBaseUrl":"http://192.168.10.2:8000/v1"}),
        ];

        for fixture in fixtures {
            let route = resolve(serde_json::from_value(fixture).unwrap()).unwrap();
            assert_ne!(route.model.base_url, "vscode-lm");
        }
    }

    #[test]
    fn vscode_lm_is_a_first_class_models_api_route() {
        let route = resolve(
            serde_json::from_value(serde_json::json!({
                "apiProvider": "vscode-lm",
                "vsCodeLmModelSelector": {
                    "vendor": "local",
                    "family": "qwen",
                    "id": "qwen3.8-27b"
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(route.model.model, "qwen3.8-27b");
        assert_eq!(route.model.base_url, "vscode-lm://provider");
        assert_eq!(
            route.vs_code_lm_model_selector.unwrap().vendor.as_deref(),
            Some("local")
        );
        assert!(matches!(
            route.model.api_backend,
            ApiBackend::ChatCompletions
        ));
    }

    #[test]
    fn tool_format_does_not_change_wire_transport() {
        let route = resolve(
            serde_json::from_value(serde_json::json!({
                "apiProvider":"openai-native",
                "apiModelId":"qwen3.8-27b",
                "openAiNativeBaseUrl":"http://192.168.10.2:8000/v1",
                "toolProtocol":"xml"
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            route.model.api_backend,
            ApiBackend::ChatCompletions
        ));
    }
}
