# 安装器 PATH 提示的命令解释器重启限定（2026-10-11，第三十三批）

英文权威 AddToPath 文案明确要求 shell restart，非英语内置资源此前只笼统提示重启后生效。恢复全部十二个非英语资源中的命令解释器/命令殼層限定，保持原 key、BOM、换行、占位符、品牌与所有其他字节。西语、法语使用已封存的两个 exact literal；另外十个语言值由 MAIN 按同根遗漏独立修正，不能说 worker 原来交付了全部十二个。

实际 code.iss 的 addtopath task 直接使用 {cm:AddToPath}，环境注册表分支和 ChangesEnvironment=true 保持。没有改安装行为，也不新增“每个新终端都会立即继承 PATH”的保证。修改后文案仍要求重启命令解释器；英文原文和翻译导出源已具备此限定，未改。

MAIN 独立全文冷核 163 个封存物理文件、1037 个绑定和 17 个原 comment/report/session/proof/payload。完整当前消费者、语言 key/参数以及 importer 的 UTF-8 BOM 和 TextModel 去 BOM 合同均核回。十二个源/发布候选每个文件只改变 AddToPath 的 value，完整正逆恢复、严格 UTF-8、key 集合、占位符及其他字节核验通过。

这是文案修复。本批没有执行 Inno 编译、installer GUI、注册表/生产升级或新 runtime/types/lint 控制，未重跑已成功同 SHA；原材料化编译器语言与读取失败按限定范围保留，不作为有效生产编译器验收。旧 de/es/fr whole proof 因新 SHA 不再覆盖当前文件，en 保持；旧 proof/report 原字节保存，新 SHA 后续须独立补审。

仅发布十二个 locale 文件及本日志到 private master，保留组件 HEAD/staged entries 和用户 dirty，未 component commit/push 或生产部署。完整历史、权限/生命周期、Native175117、最终标准 installer 与唯一原位 Upgrade 尚未完成。
