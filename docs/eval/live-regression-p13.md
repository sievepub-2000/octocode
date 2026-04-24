# Live Regression — port 999

Session hint: liveqa
Passed 65/65; failed 0.

| Case | Result | Detail |
|------|--------|--------|
| isolation.two_tabs_same_context_get_different_sessions | PASS | A=session-1776995529359837600 B=session-1776995530417564300 (initA=demo) |
| isolation.marker_does_not_leak_to_other_tab | PASS | leaked=false |
| isolation.two_tabs_get_different_sessions | PASS | A=session-1776995529359837600 B=session-1776995530417564300 (same-context, dom) |
| thinking.indicator_entered_thinking_phase | PASS | labels=["AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中..."] |
| thinking.indicator_not_stuck_on_generic_responding_only | PASS | labels=["AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中..."] |
| tools.create_file_ok | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| tools.read_file_returns_content | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| tools.list_files_contains_new_file | PASS | liveqa-1776995570769.txt |
| tools.delete_file_ok | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| sys.create_file | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| sys.delete_file | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| sys.echo_baseline | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| sys.web_search_weather | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| sys.web_search_x_news | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| sys.empty_recycle_bin | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":39,"providerHealth":{"providerId":"ollama", |
| catalog.http_200 | PASS | status=200 |
| catalog.parses_json | PASS |  |
| catalog.has_skills | PASS | count=36 |
| catalog.has_mcp_servers | PASS | count=4 |
| catalog.has_hooks | PASS | type=object |
| catalog.has_provider_profiles_field | PASS | count=0 |
| catalog.has_tools | PASS | count=59 |
| catalog.has_commands | PASS | count=29 |
| skills.all_entries_have_id | PASS | bad=0/36 |
| skills.summary_coverage | PASS | summarized=36/36 |
| mcp.unknown.descriptor_complete | PASS | state=readyForPrompt scope=workspace |
| mcp.unknown.descriptor_complete | PASS | state=readyForPrompt scope=workspace |
| mcp.unknown.descriptor_complete | PASS | state=readyForPrompt scope=workspace |
| mcp.unknown.descriptor_complete | PASS | state=trustRequired scope=workspace |
| mcp.all_have_state | PASS | n=4 |
| hooks.object_has_keys | PASS | keys=items |
| hooks.items.well_formed | PASS | type=object |
| providers.ollama.descriptor_present | PASS | kind=ollama healthy=true |
| providers.local-openai.descriptor_present | PASS | kind=llamaCpp healthy=true |
| providers.remote-openai.descriptor_present | PASS | kind=openAiCompatible healthy=true |
| providers.linkmind.descriptor_present | PASS | kind=linkMind healthy=true |
| providers.anthropic.descriptor_present | PASS | kind=openAiCompatible healthy=false |
| providers.gemini.descriptor_present | PASS | kind=openAiCompatible healthy=true |
| providers.azure-openai.descriptor_present | PASS | kind=openAiCompatible healthy=true |
| providers.nvidia-free.descriptor_present | PASS | kind=openAiCompatible healthy=true |
| providers.xai.descriptor_present | PASS | kind=xAi healthy=true |
| providers.openrouter.descriptor_present | PASS | kind=openRouter healthy=true |
| providers.qwen.descriptor_present | PASS | kind=qwen healthy=true |
| providers.glm.descriptor_present | PASS | kind=glm healthy=true |
| providers.kimi.descriptor_present | PASS | kind=kimi healthy=true |
| providers.xiaomi.descriptor_present | PASS | kind=xiaomi healthy=true |
| providers.minimax.descriptor_present | PASS | kind=miniMax healthy=true |
| providers.openai-completion.descriptor_present | PASS | kind=openAiCompletion healthy=true |
| providers.stub.descriptor_present | PASS | kind=stub healthy=true |
| commands.all_have_name | PASS | 29/29 |
| tools.inventory_size | PASS | count=59 |
| tools.contains_echo | PASS |  |
| tools.contains_read-file | PASS |  |
| tools.contains_create-file | PASS |  |
| tools.contains_delete-file | PASS |  |
| tools.contains_list-files | PASS |  |
| tools.contains_search-text | PASS |  |
| tools.contains_web-search | PASS |  |
| tools.contains_empty-recycle-bin | PASS |  |
| metrics.contains_requests_total | PASS |  |
| metrics.contains_errors_total | PASS |  |
| metrics.contains_build_info | PASS |  |
| metrics.contains_chat_requests_total | PASS |  |
| metrics.contains_tool_invocations_total | PASS |  |
| metrics.contains_sessions_created_total | PASS |  |
