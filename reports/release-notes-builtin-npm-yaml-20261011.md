# 内置 npm 扩展 YAML 解析依赖修复（下一版本，尚未部署）

将 desktop-shell/extensions/npm/package-lock.json 中唯一 js-yaml 记录从3.15.0更新至3.15.2。只改变version、resolved与integrity，保留load-yaml-file的^3.13.0范围、argparse/esprima、brace-expansion2.1.7和其余34个记录；完整锁图35节点35边，无新增或移除节点。

当前Source preferred-pm.ts调用which-pm2.2.0；它经load-yaml-file0.2.0，以默认safeLoad选项读取项目node_modules/.modules.yaml中的packageManager。官方3.x修复涉及omap唯一性检查的重复线性扫描及空merge source未计入工作预算。这里保留完整Source调用链与官方metadata、tgz、gitHead和文件实体，不把库级输入控制当成安装版攻击面已全部验收。

正常npm12/Node24.20在owned目录生成单记录候选，未执行Source安装脚本。MAIN独立全文核1001封存产物、完整tar SRI/SHA1及成员字节、准确Source消费者和完整锁记录正逆，共1131全文绑定。npm元数据签名字段保留，尚未作公钥验签；SRI核对不等于发行包签名验收。

MAIN另在owned文件目录运行真实which-pm/load-yaml-file/js-yaml候选链：12普通解析控制、两个有界omap工作量控制和一个显式小merge预算控制，共15项通过；默认每序列100 source下，10000次访问接受、10100次访问拒绝，两项边界通过。临时计数器和workspace均为显式测试夹具，未使用用户项目、产品GUI或真实模型。

worker首轮16项中的一次错误断言和exit1完整保留：128 source先被独立序列长度守卫拒绝，不能把原失败改写成成功。MAIN保留该原脚本，仅在自己的副本排除此错误断言，并以独立100/101默认预算夹具验证目标边界。冷核读取器首轮将明确absent的旧out/npmMain.js条目当作有hash文件导致KeyError，原错误与读取器保留；准确核absence后才完成。

当前Source node_modules/js-yaml仍是3.15.0，已有dist/npmMain.js仍194c92e3旧实体；本批仅应用锁与这份日志。尚未构建bundle、ASAR、Native、VSIX或标准installer，也未升级生产1.132.2/扩展0.1.8。完整审计、每条意见、正常模型与全部运行验收仍待完成；最终仅用maintenance/install-current.ps1 -Step Upgrade原位保留数据和配置。
