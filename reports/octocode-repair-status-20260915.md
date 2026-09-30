# OctoCode 修复与当前状态报告

- 生成时间：2026-09-15
- 目标主机：192.168.10.3
- 运行用户：Administrator
- 开发/编译目录：D:\gpt-workspace\octocode\source
- 安装目录：D:\Program Files\OctoCode
- 运行数据目录：D:\gpt-workspace\octocode\runtime

## 本次已处理

1. 修复自定义模型名称被内置模型目录覆盖的问题。
   - 文件：source\octocode-core\src\api\providers\openai-native.ts
   - 自定义模型 ID 会原样保留，内置模型表只提供元数据 fallback。
   - 当前使用的模型 ID：qwen38-flash-next:instruct

2. 修复桌面安装器在 product.json 缺少 win32ContextMenu 时崩溃的问题。
   - 文件：source\desktop-shell\build\gulpfile.vscode.ts
   - 文件：source\desktop-shell\build\gulpfile.vscode.win32.ts
   - 无上下文菜单 CLSID 时跳过可选 AppX 上下文菜单生成。

3. 关闭无法访问 Open VSX 时产生的自动检查告警。
   - 文件：D:\Program Files\OctoCode\data\user-data\User\settings.json
   - extensions.autoUpdate=false
   - extensions.autoCheckUpdates=false
   - 更新仍可手动执行。

4. 处理远程桌面硬件渲染告警。
   - 文件：D:\Program Files\OctoCode\data\argv.json
   - 已启用 disable-hardware-acceleration=true。
   - 原配置已备份到：
     D:\gpt-workspace\octocode\runtime\data\backups\alert-fix-20260915

## 构建与安装证据

- 针对性测试：1个测试文件，77/77 通过。
- 源码扩展与已安装扩展 SHA-256 一致：
  59D29B3331F83EBC2647F01D22B3D5B9918DDAA1F9D937EF060A5657BDE347D7
- 安装程序：
  D:\gpt-workspace\octocode\source\desktop-shell\.build\win32-x64\system-setup\OctoCodeSetup.exe
- 安装主程序：
  D:\Program Files\OctoCode\OctoCode.exe
- 开发、安装、运行目录已验证隔离。
- 安装目录的 data、workspace、environments 分别联接到 runtime 下对应目录。

## 重启后状态

- 已实际重启 192.168.10.3。
- 模型端点 http://192.168.10.4:8000/v1/models 返回 HTTP 200。
- 可见模型：
  - qwen38-flash-next
  - qwen38-flash-next:instruct
- 从安装目录手动启动后，OctoCode 多进程族均来自 D:\Program Files\OctoCode\OctoCode.exe。
- 重启后未配置为 Windows 登录自启动；本次通过安装目录手动拉起。

## 告警分类与结论

### 已消除的应用级告警

- Open VSX 自动检查失败：通过关闭自动检查消除，保留手动更新。
- 应用日志中的 GPU/DirectComposition 持续错误：已启用软件渲染；最新应用日志未再记录该类错误。
- 最新启动日志未发现新的 OctoCode 业务异常、curator 异常或未捕获异常。

### 环境级或测试过程告警

- os_crypt DPAPI 解密失败、native-keymap 无法创建 ITfThreadMgr：
  出现在通过 SSH/RDP 非标准桌面会话启动时，属于 Windows 用户会话/远程桌面环境能力限制，不能通过修改 OctoCode 业务代码真实修复。
- veto.backups：
  只在强制终止/关闭窗口时出现的生命周期等待告警，属于备份操作的退出等待；不是持续运行告警。
- 强制关闭产生的告警不能作为正常用户退出行为的失败依据。

## Agent 功能当前状态

- OctoCode 主程序、扩展加载、模型列表获取、源码测试和目录隔离均正常。
- 使用安装目录内置 harness 执行真实系统信息采集任务时，模型反复输出“准备调用工具”文本，没有产生真正的 terminal/tool call。
- 冒烟日志：
  D:\gpt-workspace\octocode\runtime\data\agent-smoke-post-reboot-20260915.txt
- 因此 agent 工具执行和模型中文语义输出仍未通过验收。
- 当前剩余根因位于4号机 oMLX/Qwen 的工具调用协议或模板兼容性，不能通过继续修改 OctoCode 模型列表解决。

## 总体评价

- OctoCode 安装、运行、扩展加载、目录隔离：通过。
- 自定义模型 ID 处理：通过。
- 安装器构建和部署：通过。
- 应用级自动更新/GPU告警：已处理并验证。
- agent 工具调用：未通过，等待 oMLX 协议问题修复后再回归验证。
