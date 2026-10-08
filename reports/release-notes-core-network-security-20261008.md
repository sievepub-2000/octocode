# 下一版本修复日志：核心网络与解析依赖

日期：2026-10-08。本批更新源码依赖，尚未构建或升级安装版。

在现有主版本内更新五个安全版本：fast-uri 3.1.8、ip-address 10.7.1、hono 4.13.7、undici 6.28.1、brace-expansion 5.0.12。只更新既有 workspace override、相应锁节点和依赖引用；清单与产品消费者字节保持，全部非目标解析不变。没有修改代理信任、模型配置或服务端权限。

真实隔离旧库回归分别观察到端口字段替换 URI authority、跨地址族子网误判及 IPv6 link-local 漏判、Hono 普通字符串原样输出 HTML、WebSocket 未请求子协议导致子进程异常退出。3500 层含逗号的嵌套 brace 输入也在旧库得到栈溢出，新库通过。最初不含逗号的 brace 输入没有复现，该结果保留，不称旧库失败。

五个补丁版本均通过相应隔离回归，且实际 SDK→Ajv→fast-uri、SDK→express-rate-limit→ip-address、SDK→Hono 与产品 Undici import 均解析到新版本。官方 registry 的五份元数据和完整 tarball SHA-512 integrity 与锁文件相符。

验证范围与可重复命令（在 octocode-core/src 执行）：

- `pnpm exec vitest run services/mcp/__tests__/McpHub.spec.ts services/mcp/__tests__/McpHub.retry.spec.ts services/mcp/__tests__/mcpStderr.spec.ts utils/__tests__/json-schema.spec.ts`：四文件99项通过。
- `pnpm exec vitest run utils/__tests__/dependency-security.spec.ts`：新增四项 URI/IP/HTML/WebSocket 安全边界通过，使用实际依赖解析；WebSocket 为限时、限内存的自有回环子进程。
- 实际 SDK Ajv 的本地 `$ref` 与错误类型验证、Hono JSON 请求、Undici Agent 的同源跳转/流式 JSON/取消检查通过；Agent 销毁，server 和自有 sockets 关闭。
- `pnpm exec tsc --noEmit` 与新增测试 ESLint 通过。锁更新4.630秒，frozen安装12.522秒，均禁用安装脚本；原下载慢速警告保留。

完整 before、原失败和实际命令/输出保存在本机审计目录 `core-network-parser-security-main-20261008T1520`。库级复现不等同于产品攻击可达或实际模型验证；其他独立桌面锁、已打包 ASAR、平台、持久化和安装程序验收仍需分别完成。
