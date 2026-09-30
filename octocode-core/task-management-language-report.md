# Manage 菜单与语言入口修复报告

## 变更范围

- `webview-ui/src/components/history/TaskNavigationView.tsx`：在左侧管理溢出菜单集中提供 Settings、Configure Display Language、Color Theme。保留现有 Settings 入口。
- `packages/types/src/vscode-extension-host.ts`：增加两个消息类型。
- `src/core/webview/webviewMessageHandler.ts`：将两个消息严格映射到 VS Code 原生命令 `workbench.action.configureLocale` 和 `workbench.action.selectTheme`。
- `webview-ui/src/components/history/__tests__/TaskNavigationView.spec.tsx`：覆盖两个菜单入口及消息。
- `webview-ui/src/i18n/locales/en/common.json`：为入口提供清晰的英文默认标签。
- 18 个 `webview-ui/src/i18n/locales/*/common.json`：为 `TaskNavigationView` 实际使用的 7 个 `octocode` 键补齐本地化标签（含 zh-CN、zh-TW），未删除既有显式语言配置。
- `src/shared/language.ts`：增加 activation 时将 `vscode.env.language` 规范化为扩展语言的纯函数。
- `src/extension.ts`：激活早期以 VS Code 原生 locale 为权威，必要时更新 `globalState.language`，再初始化 i18n；ClineProvider 随 ContextProxy 读取该值并下发 webview。
- `webview-ui/src/i18n/locales/management-language-locale.spec.ts`、`src/shared/__tests__/language.spec.ts`：覆盖 locale 目录完整性与重启同步决策。

没有修改 `WorkbenchMcpServer`、`OctoCodeRuntime`、`runtimeEvent`、`RuntimeHistoryView` 或 `index.css`。没有修改 `desktop-shell/product.json`，现有 6 张 onboarding theme cards 保持不变。`packages/types/src/vscode.ts` 的显式语言配置保持不变。

## TDD 证据

- RED（3 号机）：先上传测试，`TaskNavigationView.spec.tsx` 的新管理菜单断言失败；入口尚不存在。
- GREEN（3 号机）：实现消息、宿主原生命令映射后，focused Vitest 为 **5 passed**。
- RED（3 号机）：扩大 locale 完整性测试覆盖 `tasks`、`newTask`、`research`、`moreActions`、`settings`、`configureDisplayLanguage`、`selectColorTheme` 后，先因 `ca/common.json` 缺少 `octocode.tasks` 失败。
- GREEN（3 号机）：补齐 18 个 locale 的 7 个键后，locale + 管理菜单 focused Vitest **6 passed**；activation language focused Vitest **4 passed**。

命令：

```text
pnpm exec vitest run src/i18n/locales/management-language-locale.spec.ts src/components/history/__tests__/TaskNavigationView.spec.tsx --reporter=verbose --testTimeout=10000
```

## 类型检查

- `pnpm --filter @roo-code/vscode-webview check-types`：通过。
- `pnpm --filter @roo-code/types check-types`：通过。
- 当前 webview 全量 `check-types`：通过。
- `pnpm --filter ./src check-types`：当前通过（Task3 合并后的工作树）。

## 文件 SHA-256（3 号机）

- `TaskNavigationView.tsx`: `3CD61A6B6F479B25753A47D02AB4F02BD8A9231FBFFF24118C69233666A57FE0`
- `TaskNavigationView.spec.tsx`: `40231C5FF3C6AC39F012E15EB16C1744F762956C363AF37327256FD33115F618`
- `vscode-extension-host.ts`: `6CF2D82C0121E3042939E4FDFCB09CB0703C6E930AEF6764E68FD1111730AF91`
- `webviewMessageHandler.ts`（Task3 最新，未覆盖）: `EC318DE74349C2C47AC483B08B39A508627167CB00006F45B27AF5A4F1A6ECC8`
- `language.ts`: `13E982D5A394AAB6DE99A4A2A14F5BE3EFC9154151E3D996AD2EC8EC6BA2F6A2`
- `extension.ts`: `1E696707AA91CB439A3E00D3225149093F91B5D611A12B4873708FD144F0A850`
- `language.spec.ts`: `FA450644CC1BF2284851EA325EEA40274C5D0F1F6DD7056764EA8FC4281773D2`
- `extension.spec.ts`: `E1513801729E1CE41A91A45793E1406878E1CF1B7FC25C91C798BD8CC2835C00`
- `management-language-locale.spec.ts`: `821C2CC71BF778A16BB60B15A0B446DAD20A673A782294B7C8EF87369E0C4D09`
- `locales/ca/common.json`: `D0C61977D2589EBB9E2B927B15CB61184D0FBFDC26A45C786F3DF826E8794235`
- `locales/zh-CN/common.json`: `EDF7198759E4CCEFFCA94D5DE6E728319D72A99283F5A30DCF027378483EEF9C`
- `locales/zh-TW/common.json`: `9541D32193E095E8AAD493BE58CF4B052BFE45A843A8AF62340C69F261F2DC38`

## 残余风险

本次验证覆盖 webview 菜单、18 locale 完整性、activation 同步决策和 webview/src TypeScript；未启动完整桌面壳做人工点击验证，因此原生命令在实际发行版中的可用性仍需一次手工 smoke test。desktop-shell 已核实无用户 locale 时 `argv.json` 默认 `zh-cn`，且显式 `--locale`/用户配置优先；未改动该现有机制。远端工作树已有其他未提交改动，本次未提交或推送。
