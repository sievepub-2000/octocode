# Windows 安装、卸载和更新

更新时间：2026-10-01（Asia/Shanghai）。

2 号机迁移后的模型地址为 `http://192.168.10.4:8000/v1`，模型仍为 `qwen38-flash-next`；下文的 `2.2.2.2` 是原 3 号机配置记录，不应重新写入 2 号机。2 号机与 3 号机的管理地址分别为 `192.168.10.2`、`192.168.10.3`。

默认安装位置：`D:\Program Files\OctoCode`。安装向导始终显示目录选择页，升级默认沿用注册的原安装位置。系统级安装需要管理员权限；Windows“已安装的应用”、开始菜单卸载项及安装目录 `unins000.exe` 使用同一个 Inno Setup 卸载程序。

## 安装和离线升级

双击项目 `releases\OctoCodeSetup-latest.exe`。覆盖安装同样使用此安装包：先保存并关闭应用，再运行安装包。不要先删除数据目录。静默部署示例：

```powershell
$installer = 'D:\gpt-workspace\octocode\releases\OctoCodeSetup-latest.exe'
$process = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="D:\Program Files\OctoCode" /TASKS="desktopicon,addtopath,associatewithfiles" /LOG="D:\gpt-workspace\octocode\verification\installation.log"' -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "安装未通过，退出码：$($process.ExitCode)" }
```

安装器使用 Windows Restart Manager 请求正常关闭程序，不强制丢弃未保存内容。本版本在安装目录恰为 `D:\Program Files\OctoCode` 时，由原生安装器运行 `octocode-storage-layout.ps1`，校验并建立 data、workspace、environments 到 `D:\gpt-workspace\octocode\runtime` 的联接。2、3 号机遵循该项目布局；其他自选路径使用本地目录，不能将这一行为泛化为所有安装路径。已有数据与目标目录冲突时安装器拒绝覆盖；不要把已有数据根目录选为程序安装目录。

Windows 检出仓库前启用 Git 长路径支持，避免深层测试文件在下载对象后仍无法写入工作区：

```powershell
git config --global core.longpaths true
git clone https://github.com/sievepub-2000/octocode.git
```

在新的空目录执行检出，不覆盖现有开发工作区。文档示例图以普通 Git 文件保存，新检出不再依赖缺失的 Git LFS 对象。

## 卸载

先保存并关闭应用，再通过 Windows 应用列表或开始菜单卸载。自动化可运行原生卸载程序：

```powershell
Start-Process -FilePath 'D:\Program Files\OctoCode\unins000.exe' -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -WindowStyle Hidden -Wait
```

卸载移除程序文件、注册信息、快捷方式、PATH、安装锁文件和程序日志，并移除 data、workspace、environments 联接本身，保留联接指向的用户数据。3 号机的标准布局应在卸载后不存在安装目录；必须检查目录、注册信息、快捷方式及 PATH，退出码 0 本身不构成验收。若自定义目录内直接存放真实用户数据，则保留这些非空目录。不要递归跟随联接清理。卸载仅停止本产品所属 WSL 环境，不执行 `wsl --unregister`。

工作区唯一来源是 `octocode.workspace.path`：用户设置优先；未设置时使用安装目录下的 workspace。快捷方式、历史会话和当前编辑器文件不作为第二套工作区来源。路径不可用时应报错，不得静默切换。主程序必须正常显示窗口；隐藏窗口启动仅适用于后台辅助进程。

当前唯一模型为 `qwen38-flash-next`，默认思考模式，地址 `http://2.2.2.2:8000/v1`；不再使用 instruct 分支。3 号机有线源地址为 `2.2.2.1`。4 号机温度 0.85、MTP 深度 3。低/中档默认预算为 2048/8192；用户显式思考预算优先，高档未额外传预算不代表突破输出或服务端上限。凭据保存在客户端加密存储及服务端受限配置中，不打入通用安装包。

`backups/current-config` 是受限访问的当前配置快照；SQLite 备份与隔离恢复由 `maintenance/verification/backup-current.py` 验证。原安装目录卸载干净与保留外部当前用户数据是两项独立检查。过期回退版本仅在当前安装验收后清理。

## 在线更新占位配置

源码 `desktop-shell/product.json` 中的 `updateUrl` 当前为 `https://updates.octocode.invalid`。这是明确的占位符，应用识别该值后停用联网检查，避免反复请求无效地址。上线时将其替换为实际 HTTPS 更新服务基地址并重新构建、发布安装包。

系统级 x64 更新请求协议：`GET <updateUrl>/api/update/win32-x64/stable/<当前commit>`，允许附加查询参数。无更新返回 204；有更新返回 JSON：

```json
{
  "url": "https://YOUR-RELEASE-HOST/OctoCodeSetup.exe",
  "version": "UNIQUE-RELEASE-ID",
  "productVersion": "1.0.0",
  "sha256hash": "REPLACE_WITH_64_HEX_DIGIT_SHA256"
}
```

发布端必须比较版本，不能总是把当前版本当作新版本。`version` 为安全的唯一版本标识；安装包地址必须 HTTPS，校验和必须为安装包真实 SHA-256。新下载及已有缓存均验证校验和；被篡改的缓存先删除后重新下载。不同产品使用各自缓存目录。

保留现有标准更新状态机，包括手动检查、后台检查、策略禁用、计量网络处理、取消和重启安装。系统级更新通过 Windows Shell 启动安装器，使其管理员权限清单正常触发 UAC；用户级更新沿用静默安装流程。升级安装器记住原路径。

当前占位配置不代表已部署在线发布服务。生产上线前仍需用实际 HTTPS 服务与有效发布签名完成端到端更新及普通用户 UAC 验证；不能把单元测试或离线覆盖安装当作该验证。

## 构建与验证

桌面构建后运行项目 `source\build-desktop-installer.ps1`，该脚本从权威源同步安装、卸载和自检脚本，并拒绝将用户数据库或日志打包。产物应为一个完整 EXE。每次发布保存安装包 SHA-256。

回归测试位于 `desktop-shell/src/vs/platform/update/test/electron-main`，覆盖安装类型识别、更新状态机、占位源、下载元数据和包篡改。真实安装生命周期记录位于项目 `verification\model-log-20260920\windows-*.log` 及相应结果 JSON。
