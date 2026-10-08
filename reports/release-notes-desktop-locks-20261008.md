# 下一版本修复日志：桌面及独立工具锁文件

日期：2026-10-08。源码锁文件更新，尚未构建或升级安装版。

六份独立 npm 锁文件定向更新现有父约束内的 shell-quote 1.11.0、proxy-addr 2.0.8、xmldom 0.8.15，合计九个目标 package 记录。覆盖 desktop 根锁、remote、build、automation、MCP 与 smoke。相邻清单、顶层锁元数据、父依赖约束和无关 package 记录保持原样；不新增服务或修改代理信任与授权。

完整核对 registry 的 resolved/integrity、依赖和父 semver，并保留锁更新前后的完整字节。smoke 首个 npm lock-only 命令及后续独立验证已实际成功，其余候选经相同范围核对后写回。部分 npm 离线解析命令因缺少缓存失败，原命令和输出保留；候选不是依赖实际安装、构建、所有宿主或已安装 ASAR 的验收。

核心仓相同库版本的实际 Git、HTTP/IP、XML/DOCX、checkpoint/MCP/解析检查见另一分组日志；不将这些结果称为六个独立组件已运行的完整测试。最终需要按新锁重建实际分发并核回读依赖版本。
