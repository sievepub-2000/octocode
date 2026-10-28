# Windows 安装、卸载和更新

更新时间：2026-10-29（Asia/Shanghai）。目标版本：桌面 2.0.2 / 核心扩展 0.1.15。

本次升级修复模型配置保存和续接问题。在线升级必须验证真实下载、安装后版本、
重启后的配置与会话保留，不能仅以更新检查结果作为验收依据。

本轮正式客户端只通过“检查更新”及更新模块完成升级，不手动执行维护安装命令。下列离线方式仅供首次安装和独立恢复使用，不计入在线更新验收。2.0.2 交换两种浅色配色，未设置时默认 Light，已有主题选择不变。

2 号机迁移后的模型地址为 `http://192.168.10.4:8000/v1`，模型仍为 `qwen38-flash-next`；下文的 `2.2.2.2` 是原 3 号机配置记录，不应重新写入 2 号机。2 号机与 3 号机的管理地址分别为 `192.168.10.2`、`192.168.10.3`。

默认安装位置：`E:\Program Files\octocode`。安装向导始终显示目录选择页，升级默认沿用注册的原安装位置。系统级安装需要管理员权限；Windows“已安装的应用”、开始菜单卸载项及安装目录 `unins000.exe` 使用同一个 Inno Setup 卸载程序。

## 安装和离线升级

首次安装可双击项目 `releases\OctoCodeSetup-latest.exe`。本机已有安装的后续代码更新使用维护脚本的 `Upgrade`：先保存并正常关闭应用和所属任务，再验证并应用具体版本安装包；不卸载、不删除数据目录。维护脚本在运行前校验 `releases\release-manifest.json` 指定的安装包文件名、SHA-256、字节数和产品版本，并记录用户数据保留基线。使用独立 PowerShell 或 Python/SSH 编排，避免安装目录内的运行时锁定自身。原位更新命令：

```powershell
& 'D:\gpt-workspace\octocode\source\maintenance\install-current.ps1' -Step Upgrade
```

安装器使用 Windows Restart Manager 请求正常关闭程序，不强制丢弃未保存内容。正式安装的 `data`、`workspace`、`environments` 均为 `E:\Program Files\octocode` 下的真实目录；D 盘仅用于开发。旧安装仍有指向 D 盘的联接时，必须在退出所有所属进程后进行保全迁移、逐文件验证，再解除联接。新安装不创建 D 盘运行目录。不得用空目录覆盖已有项目、配置和凭据。

Windows 检出仓库前启用 Git 长路径支持，避免深层测试文件在下载对象后仍无法写入工作区：

```powershell
git config --global core.longpaths true
git clone https://github.com/sievepub-2000/octocode.git
```

在新的空目录执行检出，不覆盖现有开发工作区。文档示例图以普通 Git 文件保存，新检出不再依赖缺失的 Git LFS 对象。

## 卸载

先保存并关闭应用，再通过 Windows 应用列表或开始菜单卸载。自动化可运行原生卸载程序：

```powershell
Start-Process -FilePath 'E:\Program Files\octocode\unins000.exe' -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -WindowStyle Hidden -Wait
```

卸载移除程序文件、注册信息、快捷方式、PATH、安装锁文件和程序日志。当前 E 盘标准布局中的 data、workspace、environments 是实际目录，卸载保留其中的用户数据，因此安装根目录可能仍然存在。旧版联接布局只移除联接本身，保留其目标数据，不递归跟随联接清理。必须分别检查程序文件、用户数据、注册信息、快捷方式及 PATH，退出码 0 本身不构成验收。卸载仅停止本产品所属 WSL 环境，不执行 `wsl --unregister`。

工作区唯一来源是 `octocode.workspace.path`：用户设置优先；未设置时使用安装目录下的 workspace。快捷方式、历史会话和当前编辑器文件不作为第二套工作区来源。路径不可用时应报错，不得静默切换。主程序必须正常显示窗口；隐藏窗口启动仅适用于后台辅助进程。

2 号机当前模型为 `qwen38-flash-next`，地址 `http://192.168.10.4:8000/v1`，默认思考模式，不再使用 instruct 分支。原 3 号机曾使用模型地址 `http://2.2.2.2:8000/v1` 和有线源地址 `2.2.2.1`，这两项仅作历史记录，不适用于当前 2 号机配置。4 号机温度 0.85、MTP 深度 3。低/中档默认预算为 2048/8192；用户显式思考预算优先，高档未额外传预算不代表突破输出或服务端上限。凭据保存在客户端加密存储及服务端受限配置中，不打入通用安装包。

`backups/current-config` 是受限访问的当前配置快照；SQLite 备份与隔离恢复由 `maintenance/verification/backup-current.py` 验证。原安装目录卸载干净与保留外部当前用户数据是两项独立检查。过期回退版本仅在当前安装验收后清理。

## 私有 GitHub 在线更新

2.0 源码将桌面更新源配置为私有仓库 `sievepub-2000/octocode` 的 GitHub Releases API。仓库和发布资产保持私有。命令面板中的 **Use GitHub Token for Updates** 可录入有 `repo` 权限的 classic PAT，Token API 优先；**Sign in to GitHub for Updates** 提供官方设备码登录。已有两类会话可明确选择，后台检查不会自动弹出授权。细粒度 PAT 当前不走这个 classic PAT 入口。

两种凭据均复用 GitHub Authentication 和系统加密的 SecretStorage，不保存在设置、源码或 URL 中；Token 输入框遮蔽内容，主进程只接收内存凭据。设备码在 `https://github.com/login/device` 由用户批准，轮询遵守 GitHub 返回的有效期和间隔。自定义 `octocode` 协议不会被伪装成 VS Code 回调，也不写入新的 OAuth 密钥。本机退出与服务端授权撤销不同，后者可在 GitHub Settings → Applications 管理。

正式标签使用 `v2.0.1`，产品版本按 `2.0.1` 比较。系统级 x64 安装包固定为 `OctoCodeSetup.exe`；未发布用户级安装包时不能列出该平台。发布还必须提供原始 UTF-8 `octocode-release.json` 和 64 字节 Ed25519 签名 `octocode-release.json.sig`。客户端先验签，再将仓库、标签、产品版本、唯一资产名称、大小和 SHA256 与 API 元数据绑定；API 自带摘要如存在也必须一致。未签名、草稿、预发布、降级或平台不匹配的发布不会安装。

原生更新器和扩展恢复程序固化同一发布公钥，DER SPKI 的 SHA256 指纹为 `d50724b04147e8fa6682f0ac7bb8132d297eaf2988e06168ac2d856dffc3adf3`。这是发布签名公钥指纹。私钥仅以 DPAPI 加密形式保存于受限运行数据目录，不能进入安装包或报告；生成和签名步骤见 `maintenance/release-signing/README.md`。

客户端通过仓库资产 API 认证下载。GitHub 的 HTTPS 下载跳转逐跳校验，账户 Authorization 不会转发到下载域，签名下载地址不会进入请求日志。新下载、缓存恢复及安装前均核对签名证明、大小和 SHA256；损坏缓存会移除再下载。版本比较使用产品版本，与 VS Code API 兼容版本分开。

原生程序是主更新器。显式检查或下载失败时提供 **Use Backup Update**，调用 `octocode.recoverDesktopUpdate`；扩展恢复程序独立读取 API 和下载完整安装包，使用同一固定公钥校验，不依赖原生更新服务。两类凭据不等于两个更新器。恢复操作须保留活动任务和文档的正常退出保护，不得绕过校验或强行关闭应用。

保留现有手动和后台检查、策略禁用、计量网络处理、下载取消、重启安装和原安装路径。系统级更新通过 Windows Shell 启动安装器，使其管理员权限清单正常触发 UAC；用户级更新沿用静默安装流程。原位升级仅更新核实归属的程序文件，保留 MCP 配置、技能、钩子和知识数据。VSIX 扩展更新与完整桌面安装包更新分别处理。

源码接入和隔离测试不代表新安装包已经发布或安装。生产验收仍须对实际发布完成客户端登录、检查、下载、校验、原位安装、重启和版本读回，并验证普通用户 UAC 与数据保留。

### 发布后清理本地开发副本

用户要求最终仅保留远端仓库和正式安装。清理按以下顺序进行：先读回实际推送的提交与发布标签，从 GitHub 取回最终安装包并核对字节数和 SHA-256；再验证正式安装的进程、程序文件、模块、脚本和配置来源，确认程序不依赖本地源码目录或指向源码的联接。运行数据目录的解析目标须独立于待删除的开发目录。

上述门槛通过后，按已核实的路径清单删除本产品全部本地源码副本和开发临时产物，不保留源码或软件备份；运行数据、用户项目和正式身份认证数据必须保留。随后检查源码及临时产物已不存在，并再次从正式安装冷启动、执行版本和关键功能读回。远端提交、发布取回、安装独立性或数据保留有一项尚未验证，就不能把本地开发副本清理视为完成。

## 构建与验证

本机已有 OctoCode 的后续代码发布均使用原位升级：停止运行任务并正常退出后，将已校验安装包应用到现有 `E:\Program Files\octocode`。维护脚本默认 `Upgrade`，要求现有程序存在；不得以卸载、清空 runtime、迁走用户数据或干净重装代替代码更新。首次安装与明确授权的恢复演练另行执行，不属于正常更新流程。

桌面构建后运行项目 `source\build-desktop-installer.ps1`，该脚本从权威源同步安装、卸载和自检脚本，并拒绝将用户数据库或日志打包。产物应为一个完整 EXE。每次发布保存安装包 SHA-256。

回归测试位于 `desktop-shell/src/vs/platform/update/test/electron-main`，覆盖安装类型识别、更新状态机、占位源、下载元数据和包篡改。历史安装生命周期证据与限制见已纳入版本控制的 [0.1.8 / desktop 1.132.2 验收报告](reports/machine2-release-0.1.8-acceptance.md#follow-up-acceptance-and-investigation)，该报告记录既有部署和隔离演练。

历史报告不构成本轮部署验收；本轮安装、升级、卸载和重启结果须以对应版本的实际验收记录为准。
