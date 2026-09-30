# OctoCode Harness

OctoCode 的任务执行器，负责代码检索、文件读写、命令执行、工具调用、会话检查点和上下文压缩。桌面端通过 ACP/headless 接口调用 `octocode-harness`，会话、消息、权限和任务生命周期由 OctoCode Host 统一管理。

这是 OctoCode 对现有开源执行器的集成与改造。OctoCode 自研部分包括 Host、统一数据接口、桌面交互和任务接续改造；本仓库中的上游执行器及第三方实现仍保留原许可证和贡献归属，不宣称全部代码为原创。

## 构建

使用根目录 `rust-toolchain.toml` 指定的 Rust 工具链。协议生成需要 `protoc`（或仓库已有的 DotSlash 工具）。

```sh
cargo build -p xai-grok-pager-bin --release --bin octocode-harness
cargo test -p xai-grok-sampler --lib stream::
```

`xai-grok-*` crate 名称、配置兼容字段和协议标识为构建兼容标识。发行程序名称唯一为 `octocode-harness`，不再重复生成同一入口的旧名称 binary。

## 运行与数据

由 OctoCode Host 为每个会话配置独立执行器目录、工作目录和任务令牌。同一会话续跑保持 sessionId；显式“新对话接续”创建新 sessionId，携带任务记忆及最近三轮对话。不要将一个正在运行的会话目录共享给另一个任务进程。

产品发布以 OctoCode 的安装说明和项目评估报告为准。源树不提供指向外部品牌安装器的产品安装命令。桌面端不在后台自动更新执行器。

## 许可证与来源

本仓库按 [Apache License 2.0](LICENSE) 及所包含的第三方许可分发。上游版权、依赖包名、协议字段和技术标识保持原样。`SOURCE_REV` 记录导入源码的上游版本。

- [第三方许可](THIRD-PARTY-NOTICES)
- [工具源码许可说明](crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md)
- [内置第三方资源许可](third_party/NOTICE)
