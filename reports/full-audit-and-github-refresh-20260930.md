# OctoCode 1.132.1 发布与全系统验收报告

本报告仅记录本轮实际完成并读回确认的项目。Windows 3 号机 `192.168.10.3` 是构建与安装目标；2 号机本地 Qwen 接口仅用于 Open Code Review。Linux、macOS、Docker、外部模型和完整 UI 人工操作不在本轮已验证范围内。

## 一、权威代码与运行目录

源码为 `D:\gpt-workspace\octocode\source` 下的根仓库及 `desktop-shell`、`octo-harness`、`octocode-core` 三个组件仓库。可执行程序的唯一正式目录为 `D:\Program Files\OctoCode`；运行数据的物理目录为 `D:\gpt-workspace\octocode\runtime`。安装目录的 `data`、`workspace`、`environments` 为指向运行目录的 junction。旧路径仅作参考，不能混作权威数据源。

本轮在 3 号机经公钥 SSH 执行 Windows 构建，实际使用项目捆绑的 Node `v24.20.0`、pnpm `11.25.0`、Rust/Cargo `1.98.0`。构建前仍安装的是 `OctoCode.exe` `1.132.0`（2026-09-23），与当前源码版本不同，不能把该进程或磁盘文件当作本次发布的验证结果。安装前备份清单的 SQLite 隔离恢复与凭据恢复均通过；当前配置文件和工作区产物以哈希快照作为卸载与安装前后保全基线。正式运行依附于当前 Administrator 桌面用户；本轮没有证明其他 Windows 用户身份或 ACL 下的完整操作闭环。

## 二、源码检查与修复

- 核心：一次性任务批准与任务身份复核、DeepSeek 密钥输入校验与取消传播、显式关闭 max tokens 的请求参数、Swift tree-sitter 查询修复。DeepSeek 相关修复已提交 `ee27a5e`；核心提交钩子的 11 项 lint/类型检查通过，定向 DeepSeek 测试 33/33 通过。`PermissionPolicy` 经全仓跟踪引用搜索确认只被自身测试引用；真实 Workbench MCP 写入权限由 `services/workbench-mcp/toolPermissions.ts` 控制，要求 full 且非只读。已删除未接入且存在边界缺陷的重复策略与测试（`bf10ee9`）；Workbench 修复为 `f2914e1`。最终代码的核心全量测试为 6047 通过、23 跳过，386 个测试文件通过、6 个跳过，Turbo 10/10 成功；定向 Workbench 31/31 通过。
- 桌面：协议脚本与过期测试配置清理、构建范围修复、Node 版本配置回退、Kerberos 测试在无域账号下跳过。既有 Node 测试 7890 通过、121 pending，构建脚本测试 235 通过。完整 ESLint 曾因 4 GiB 内存限制退出，本轮没有据此宣称通过。新发现安装初始化仅更新扩展登记，却留下旧版本包目录；已在 `build/win32/octocode-initialize.ps1` 加入新扩展登记成功后的定向清理。清理只匹配 OctoCode 版本目录，并校验目录非链接、包身份及目录内无重解析点后才删除。修复提交 `e8579ee4ef57`，复装验证见下文。
- 发布仓库体积核查发现桌面仓库错误跟踪 `work/verification` 下的 352 份自动生成 `.log`，当前工作区合计约 1.33 GB。目录本已被 `.gitignore` 排除，但历史跟踪仍会污染全新 GitHub 快照。现仅从 Git 索引取消跟踪；逐个确认实体日志仍在磁盘，提交 `3cd6f9ffd352` 已完成，发布树不再包含它们。最终导出树仍需复核。
- 桌面产品构建脚本还先运行传统 `compile-build-without-mangling`，再运行 `vscode-win32-x64`。前者的 gulp-tsb 逐文件编译会长时间处理测试文件；本轮在旧日志的 `compile-src` 零错误输出后停留很久。Node Inspector 的调用栈明确落在 TypeScript 的 `getEmitOutput`/条件类型展开，活动文件为 `src/vs/workbench/contrib/notebook/test/browser/notebookTextModel.test.ts`。对照旧成功日志发现该阶段原来也要约 11 分钟，不能把“零错误”误当整项完成。`useEsbuildTranspile=true` 时后一个产品任务自行生成 `out-build`、执行 esbuild bundling，且打包清单排除 `**/test/**`；因此传统预编译并不供发布产物使用。根构建脚本现保留 TypeScript 原生 `tsgo --noEmit` 全源码检查，并仅执行正式 `vscode-win32-x64` 产品任务。此变更须经产品打包及安装验收确认。
- Rust：检查原有格式差异后统一格式；修复 Windows 路径、条件编译、符号链接测试和已删除文档引用。定向 hunk-tracker 测试 184/184 通过，`cargo fmt --all -- --check` 通过。修复提交 `6dedbbe`。全工作区结果须单独记录。

DeepSeek 六条模型审查意见逐项处理：取消信号向 SDK 传播；显式 `includeMaxTokens=false` 保留；删除不可达分支；统一 V4 判定；将响应 usage 字段改为具体类型；注释思考模式中 temperature 无效的上游约束。未采纳把本 provider 的 token 上限改成通用 `addMaxTokensIfNeeded`，因为通用函数取元数据的 384k，而当前 DeepSeek 实现按实际上下文的 20% 设置 200k 上限，直接替换会改变请求行为。也未根据模型元数据放宽 V4 思考开关，因为支持性未验证。这两条属于有依据的审查意见驳回，不是漏修。

## 三、Open Code Review 覆盖边界

官方 Open Code Review 1.12.10 已安装到项目工具目录，二进制校验与官方包一致。预览统计共 18874 个 Git 跟踪文件、14399 个可审文件，预览不能算作 LLM 完成审查。此前多文件任务因模型上下文压缩与检索超时未完成。单文件 DeepSeek 扫描完成 1 文件、6 条意见，已分别验证与处理；PermissionPolicy 扫描完成 1 文件、5 条意见，核查引用后删除了未接入的重复实现；WorkbenchMcpServer 扫描完成 1 文件、12 条意见，逐条对照实际调用链。实际完成的 LLM 审查覆盖率为 3/14399，不能宣称全量 AI 审查通过。

Workbench MCP 的真实缺陷包括：JSON-RPC 批量 body 原本绕开单次批准检查；文件展示未在执行时复核活动任务，相对路径在没有工作区时落到进程 cwd；`dispose()` 后还可返回已关闭端口；部分无需 payload 的查询在 Zod schema 阶段被拒；浏览器动作权限映射对新动作默认落到较宽松的 browser 权限；基础设施错误被误报为用户拒绝。以上已改为批量请求拒绝、任务身份校验和明确的绝对工作区根、disposed 状态拒绝复用、可缺省 payload、穷举动作权限映射，以及仅对真实批准拒绝使用对应响应。Workbench 定向 31 项测试通过、核心类型检查 11/11 通过，最终全量复测结果见验收部分。

OCR 中将 `openWorkbenchBrowser` 指为绕过模型权限的意见，经调用链核查不成立：它仅由用户侧 webview 菜单动作调用，MCP 浏览器工具仍经 `dispatchWorkbenchBrowser`。绝对路径打开文件是当前允许读取的任务权限，不据此引入未经用户要求的全局读取禁令。`run_playwright_code` 在评价清单含 URL 封锁前缀时仍可能通过脚本导航到受限页；当前只在 MCP 调度层检查显式 `payload.url`，完整封锁须在底层浏览器的每次导航统一执行。此项未解决，不能把评价清单封锁称为完整闭环。

## 四、构建、安装与发布验收

当前四个源码 HEAD 为：根仓库 `12d25d920774`（报告提交后更新），桌面 `e8579ee4ef57`，Rust harness `6dedbbe70cf4`，核心 `f2914e1a1a8e`。核心最终全量测试以最后的 Workbench 修改后代码运行，10/10 Turbo 任务成功，6047 通过、23 跳过；桌面已有 7890 通过、121 pending 的 Node 测试和 235 项构建脚本测试。最终扩展阶段在同一源码上连续通过 `check-types`、`lint`、`build`、`vsix`，生成 `octocode-0.1.7.vsix`，81,841,881 字节，SHA-256 `8c1d0a0ed9947f7a35fb0e10232727815a110875e576002a3786167760b42110`。压缩包内 `octocode-host.exe` 和 `octocode-harness.exe` 分别与刚构建的发布二进制 SHA-256 完全一致。VSIX 已复制至项目 `updates/stable` 并逐字节哈希比对；`latest.json` 已更新至此最终哈希。

Rust 全工作区 `cargo test --jobs 1 --workspace --all-targets` 曾对 97 个工作区包、278 个构建目标运行，但在大型 `xai-grok-shell` 编译阶段占用约 7 GiB；16 GiB 的 3 号机同时运行 release 编译时空闲内存降至约 1.3 GiB。本轮为优先完成发布构建，已仅终止该全量测试 cargo 及其编译子进程，保留此前通过的 Rust 定向测试。全工作区测试**未完成、未通过验收**；不得把主动停止写作测试失败或成功。Rust release harness 从当前 `6dedbbe70cf4` 源码完成编译，自报 `octocode-harness 1.0.16 (6dedbbe70cf4)`，新二进制 146,136,064 字节，SHA-256 `915c61a807cb1bfdbd43263e712b791f6a52cb30320a2c9c981d243d3141ba1c`。Host release 二进制 5,632,512 字节，SHA-256 `5ac031b83b7538285dddc8572fc63e5f97d9b80458ba24edb1db1ef3efd4a125`。

首次最终核心 VSIX 在 harness release 完成前生成，所以即使源码检查通过，里面可能封装旧二进制；桌面阶段已及时中断。随后按正式扩展阶段重打 VSIX，逐项校验压缩包内 host/harness 哈希、更新稳定清单，再重建桌面包。前述 `cd27a38...` 仅为中间产物，不属于发布。不得以先前的 `1.132.0` 安装程序、旧扩展包或源码测试代替安装验收。

正式桌面产品构建于本轮 15.8 分钟完成。独立 TypeScript 原生检查通过，esbuild 的 20 个 bundle 完成语法检查并从 1577 个模块抽取 19,835 条本地化消息，产物 `OctoCode.exe` 自报 1.132.1；数据目录内仅有 `octocode.octocode-0.1.7`。产品 VSIX 哈希为 `8c1d0a0e...42110`，host 与 harness 逐字节哈希与最终构建二进制相同。初次安装器任务因配置所需的 Inno Setup 7 编译器目录为空而在打包前停止。按官方 7.1.0 x64 发布资产重新下载安装：大小 14,304,168 字节，SHA-256 `0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f` 与官方 GitHub Release 资产 digest 一致，Windows Authenticode 状态 Valid、签名主体 Pyrsys B.V.；标准静默安装退出码 0，`D:\Program Files\develop\Inno Setup 7\ISCC.exe` 已实际加载且签名有效。

首版安装器虽以 736,751,493 字节、SHA-256 `CB55E1545B25E6440E04A86A52FBF55D9E0C901CDE4A8918D1370F403DF7777C` 成功编译并静默安装到正式路径，但现场验收发现物理运行目录同时残留 `octocode.octocode-0.1.6` 和 `0.1.7`；扩展登记文件只指向 `0.1.7`，host/harness 哈希也正确，但“一套唯一扩展结构”未满足。因此**首版安装包作废，不得上传 Release**。旧版卸载清除了正式安装目录、快捷方式与注册项，当前七份保全文件哈希未变；首版安装显示程序版本 1.132.1、扩展 0.1.7、工作区文件创建/读取/更新/删除通过，唯一失败项是旧扩展包目录。此问题促成上述初始化脚本修复和安装器重打包；最终结果需以第二次复装与完整验收为准。首版 EXE 当前未签名，若最终重包仍无签名应列为发布限制。

修复后的最终安装器由 Inno Setup 7.1.0 成功编译，大小 **736,842,327 字节**，SHA-256 **`7EB061762F6A08CA018829F23DC62732641918BF93FDA08EBDF660AA0FDB5FD9`**。`OctoCodeSetup-1.132.1.exe` 与 `OctoCodeSetup-latest.exe` 两份发布文件均与构建产物哈希一致，发布清单记录桌面提交 `e8579ee4ef57`、扩展 VSIX 哈希与安装器哈希。最终 EXE 无 Authenticode 代码签名，发布时必须明确这一限制。

第二次安装前重新生成七份用户文件保全基线；卸载脚本确认安装目录、快捷方式、注册项、PATH 残留均为零，文件哈希未变。重新静默安装至 `D:\Program Files\OctoCode` 后：程序版本为 1.132.1，注册项 146 个，桌面及开始菜单快捷方式和 PATH 项正常，`data`/`workspace`/`environments` 均为指向项目物理运行目录的 junction，七份文件哈希仍然一致。`final-acceptance.ps1` 结果 `Pass=true`、零失败：仅一份 `octocode.octocode-0.1.7`，harness 自报 `1.0.16 (6dedbbe70cf4)`，已安装 host/harness 哈希分别为 `5AC031B83B7538285DDDC8572FC63E5F97D9B80458BA24EDB1DB1EF3EFD4A125` 与 `915C61A807CB1BFDBD43263E712B791F6A52CB30320A2C9C981D243D3141BA1C`；工作区创建、读取、更新、删除通过，最新日志未检出 `[error]`/`[warning]`。安装目录 `test/self-test.ps1` 成功检验捆绑 Node 24.20.0、npm 12.0.2、pnpm 11.25.0、Python 3.14.7、Code Review Graph 2.3.8 等已安装组件；其余按需组件明确标记未 provision。`test/mcp-self-test.ps1` 对 code-review-graph、llm-wiki、scrapling 三个本地 stdio 服务分别发现 30、14、4 项工具并通过握手。

以上是磁盘、静默安装脚本和本地服务实测，不等于完整的 GUI 人工操作或系统重启。管理员 console 会话在本轮 SSH 检查时处于断开状态，因此本轮没有可验证的可视桌面点击记录，也未重启共享的 3 号机。冷启动、菜单逐项对应、跨会话任务接续、压缩/排队等真实交互仍需交互会话和独立验收；不得把自检脚本结果扩写为这些功能已通过。

## 五、剩余风险与下一步

- 用可稳定完成代码搜索和上下文压缩的模型按模块批次完成剩余 OCR 审查，记录每个文件完成状态、缺陷与修复。
- 将桌面全仓 ESLint 和 Rust 工作区测试纳入资源可控的 Windows CI；实际未跑通的检查应明确保留为风险。
- 补全真实桌面 UI 各管理入口、任务跨会话、压缩、权限生命周期的自动化交互；只有真实执行的操作才能标记通过。
- 若计划跨平台发布，另行在 Linux、macOS 和 Docker Engine 实测安装、权限、冷启动与卸载；本次 Windows 验收不能替代这些平台。
