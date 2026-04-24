# Live Regression — port 990

Session hint: liveqa
Passed 33/33; failed 0.

| Case | Result | Detail |
|------|--------|--------|
| isolation.two_tabs_same_context_get_different_sessions | PASS | A=session-1776989826133852000 B=session-1776989826587184100 |
| isolation.marker_does_not_leak_to_other_tab | PASS | leaked=false |
| isolation.two_tabs_get_different_sessions | PASS | A=session-1776989826133852000 B=session-1776989826587184100 (same-context) |
| thinking.indicator_entered_thinking_phase | PASS | labels=["AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中..."] |
| thinking.indicator_not_stuck_on_generic_responding_only | PASS | labels=["AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中...","AI 思考中..."] |
| tools.create_file_ok | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":11,"providerHealth":{"providerId":"ollama", |
| tools.read_file_returns_content | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":11,"providerHealth":{"providerId":"ollama", |
| tools.list_files_contains_new_file | PASS | liveqa-1776989847715.txt |
| tools.delete_file_ok | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":11,"providerHealth":{"providerId":"ollama", |
| sys.create_file | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":11,"providerHealth":{"providerId":"ollama", |
| sys.delete_file | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":11,"providerHealth":{"providerId":"ollama", |
| sys.echo_baseline | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":11,"providerHealth":{"providerId":"ollama", |
| sys.web_search_weather | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":11,"providerHealth":{"providerId":"ollama", |
| sys.web_search_x_news | PASS | {"status":{"providerId":"ollama","activeProviderId":"ollama","providerKind":"ollama","platform":"windows","permissionMode":"dangerFullAccess","sessionCount":11,"providerHealth":{"providerId":"ollama", |
| catalog.http_200 | PASS | status=200 |
| catalog.parses_json | PASS |  |
| catalog.has_skills | PASS | count=36 |
| catalog.has_mcp_servers | PASS | count=4 |
| catalog.has_hooks | PASS | type=object |
| catalog.has_provider_profiles_field | PASS | count=0 |
| catalog.has_tools | PASS | count=58 |
| catalog.has_commands | PASS | count=29 |
| tools.inventory_size | PASS | count=58 |
| tools.contains_echo | PASS |  |
| tools.contains_read-file | PASS |  |
| tools.contains_create-file | PASS |  |
| tools.contains_delete-file | PASS |  |
| tools.contains_list-files | PASS |  |
| tools.contains_search-text | PASS |  |
| tools.contains_web-search | PASS |  |
| metrics.contains_requests_total | PASS |  |
| metrics.contains_errors_total | PASS |  |
| metrics.contains_build_info | PASS |  |
