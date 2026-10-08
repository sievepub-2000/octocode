# 下一版本修复日志：清空工作区时取消会话创建

日期：2026-10-08。源码修复，安装版尚未升级。

清空工作区会先释放并取消旧会话创建，再清空草稿。旧异步创建返回后不会重新挂接 provider 升级监听，避免清空动作被后台创建流程反转。

新增回归使用真实 `NewChatWidget` 方法、取消令牌和 disposable 生命周期，先在原实现上观察到清空时令牌未取消且监听重新挂接，再验证修复。三份相关浏览器套件共 52 项通过，两份改动 TypeScript 的 ESLint 通过，限定产品及导入依赖的编译检查为零诊断。原 provider 注册补偿与新创建取消旧创建的测试继续通过。

52项的实际 suite 是 `src/vs/sessions/contrib/chat/test/browser/newChatWidget.test.ts`、`sessionWorkspacePicker.test.ts`、`runScriptCustomTaskWidget.test.ts`。在 desktop-shell 根运行 `node test/unit/browser/index.js --browser chromium-chrome`，分别以三个 `--run` 选择上述完整路径。实际 argv、owned 网络日志 preload 和输出见审计 `workspace-picker-repair-main-20261008T090918Z/new-chat-clear-green.json`（UTC10:57:21至10:57:24、exit0）；无需因本次文字补充重跑旧成功。

源码变更为 `src/vs/sessions/contrib/chat/browser/newChatWidget.ts` 及该测试，不是审阅payload分组所暗示的仅Markdown。仓内 `node build/eslint.ts` 对两文件通过，见 new-chat-clear-lint.json。编译检查沿用五个工作区/任务产品根，增加 NewChatWidget，第六根加全部实际导入与声明；真实 compiler program 原版/修复版均零诊断，详细rootNames和选项见 new-chat-clear-production-types.json，不代表整个Desktop clean typecheck。

清空顺序是先释放旧provider-upgrade监听，再清除并取消creation disposable，然后调用 `sessionsService.unsetNewSession()`。方法没有另加session引用置空或取消日志；迟到的创建由token/creation身份检查阻止重挂监听。窗口重载、原生输入、真实安装版和冷启动仍属未执行验收。

本批不改变服务端权限或创建 API；组件方法回归不替代真实产品、正常模型、持久化及安装包验收。原失败和旧哈希补审记录保留，新源码仅以新哈希补审。
