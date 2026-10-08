# 下一版本修复日志：MCP OAuth 凭据绑定

日期：2026-10-08 UTC。源码修复，安装版仍待构建和实际升级验收。

MCP SDK 更新到1.31.0，同时修复产品自行登记、交换和刷新令牌的路径。发现到的授权服务器必须与 metadata 的 issuer 一致；新 token/client information 保留 issuer，复用时同时核对完整 MCP URL。三个跨窗口快捷重连分支也执行同一绑定检查，避免仍有效但属于不同服务器的凭据触发重连。

OAuth SecretStorage 使用完整规范 URL 的 SHA-256 隔离键，区分协议、路径和 query，键名不包含 URL 中可能携带的凭据。旧 namespace 中的数据保留，但不自动迁移或推断 issuer；升级后这些 MCP OAuth 连接需要重新登录。没有清空生产凭据、修改模型 provider key 或关闭 TLS 检查。

刷新请求使用原 token 对应的 client information，包括正确的 client secret；交换、刷新和登记请求拒绝跟随重定向。刷新失败保留记录并停止该 provider 的重复刷新，错误信息不附带远端响应正文。OAuth discovery 在 finally 清除原五秒 deadline timer，预算保持不变。

验证：旧实现下十一项定向边界先失败，再完成五份套件148项通过；核心 src 的完整 TypeScript 检查零诊断。八个修改文件原有174条 lint错误，修复后仍174、没有新增，不能称整文件 lint通过。SDK 官方完整 tarball integrity 与锁相符；锁仅改变SDK版本及其引用，最初自动变化的三个无关依赖边已保全并恢复。

真实回环使用实际产品 OAuth/SecretStorage 类、SDK和Undici，执行正常 initialize/list/call、授权服务器变更阻断、307 token跳转阻断、隔离数据删除后回读和finally关闭。没有真实凭据、GUI或系统浏览器；VS Code接口使用隔离适配，不能代替实际SecretStorage持久化或正常模型验收。

McpHub 的发布候选只包含本批三处 OAuth guard。Source中原先未提交的 stdio恢复修改保持原样，另行核验，不混入这批。候选按真实加载字节单独执行同样148项测试。完整证据在本机审计 `mcp-oauth-issuer-security-main-20261008T1540`；原失败、旧源码、旧守卫及未验证的模型/权限/平台边界保留。
