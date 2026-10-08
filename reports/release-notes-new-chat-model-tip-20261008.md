# 下一版本修复日志：首次模型到位时刷新新会话提示

日期：2026-10-08 UTC。源码修复，安装版尚未升级。

新会话模型尚未解析时，旧观察器把 `undefined` 同时当作当前模型和“尚未观察”的标记。首次模型到位，以及模型清空后再次到位，都没有重新检查提示卡。现只比较前后模型标识，保留相同标识不重复刷新及释放后停止响应的行为。

永久回归位于 `desktop-shell/src/vs/sessions/contrib/chat/test/browser/newChatWidget.test.ts`。测试运行真实 NewChatWidget 构造器、依赖注入、observable 和 disposable；模型状态及服务使用测试适配，提示刷新入口记录调用，未执行安装版提示卡的视觉或正常模型验收。原源码实际为六项通过、一项失败：首次和再次到位的两个调用均遗漏。单行修复后七项全部通过，含四项原会话创建/取消控制、同标识控制和释放控制。

在 desktop-shell 根使用仓内 Chromium runner：`node test/unit/browser/index.js --browser chromium-chrome --run src/vs/sessions/contrib/chat/test/browser/newChatWidget.test.ts`。实际 argv、preload、完整前后源码、RED/GREEN 和网络记录绑定于审计 `new-chat-model-tip-main-20261008T2110`。两次浏览器日志的 404 均定位到本地测试 runner 的 `/favicon.ico`；没有按产品失败处理，也没有过滤或修改原日志。

仓内 `node build/eslint.ts` 对两份改动文件通过。产品检查以 NewChatWidget 为唯一显式产品根，包含 2001 份实际导入源码及仓内声明，原版/修复版均零诊断。独立测试编译在补入已安装的 Node 声明后保留 35 条相同的 Node/browser 定时器类型冲突，改动文件零诊断、新增零；不是整个 Desktop 或该测试编译图无错误。最初缺少 assert 声明的失败、随后 35 条诊断及所有检查配置均保留。

本批不修改模型选择、权限、服务端配置或用户数据。源码新 SHA 需独立补审，旧成功不继承；真实 GUI、提示卡可视效果、模型/日志、冷启动和标准安装程序验收仍待完成。
