# 内置 npm 扩展的 brace-expansion 安全更新

日期：2026-10-09。下一次构建使用的源码依赖更新；本机安装版仍为 desktop 1.132.2、扩展 0.1.8。

内置 npm 扩展的工作区排除模式会经过实际 `isExcluded`、minimatch 5.1.8 与 brace-expansion。原锁定 2.1.2 在有界检查中存在重复 rewrite、输出长度、中间数组、嵌套深度及 parser 递归问题。本批将其更新为覆盖五条官方修补下限的最小 2.x 版本 2.1.7，保持父范围 `^2.0.1` 和 balanced-match 1.0.0。

仅修改 `desktop-shell/extensions/npm/package-lock.json` 中一个 package record 的 version、resolved、integrity 三个字段。真实 npm lock-only producer 生成候选；35 个节点和 35 条边、其余 34 个记录、清单及非目标原字节保持。MAIN 全文核对原 558 文件冻结和随后 571 文件封存、四个完整官方包的 SHA512/SRI 与成员字节、完整 Source 消费者及 whole-file literal 正逆。证据位于 `audit/fresh-review-after-history-20261001/desktop-brace-217-main-20261009T0220`。

旧实体的 18 个正常控制通过、6 个修复检查失败；MAIN 对候选真实实体与准确源函数独立运行 24 项，全部通过。重复 rewrite 的两个用例经过实际 consumer 默认参数；其余危险边界以小限制或有界 stack 采样验证，未执行 OOM、真实崩溃或用户任务。

此扩展会把依赖内嵌到 `dist/npmMain.js`，仅修改锁不会替换旧 bundle。当前 Source node_modules 及已安装产品仍是旧基线；完整冻结安装、bundle 重建、ASAR、真实 extension host/GUI、平台和最终安装验收待全部审计后的构建执行。本批不代表全仓、全部告警或生产安全验收完成。完整 GitHub live 告警查询曾 EOF，旧 231 项仅作历史参考，不 dismiss 或推算实时关闭数。
