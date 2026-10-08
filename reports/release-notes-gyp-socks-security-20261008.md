# 下一版本修复日志：gyp SOCKS 兼容链

日期：2026-10-08 UTC。此前的gyp ip-address范围HOLD已在源码锁中解决。

保持socks-proxy-agent8.0.5的原^2.8.3范围，更新同一socks2主线至2.8.10，采用该官方版本的ip-address^10.1.1依赖并锁10.7.3。仅改两个记录，移除旧IP独占而已孤立的jsbn/sprintf-js节点；smart-buffer4.2.0和根node-gyp范围保持，未加override或放宽清单。

完整官方元数据与新旧tarball hash、全部incoming约束、原文件正逆字节核验通过。新完整gyp图98节点/127边、零故障。39项隔离消费者与协议检查通过，覆盖SOCKS实际使用的Address4/6及binary helper、受控本地握手和finally清理；IP9/10并非全部API等价，未用“同major”替代消费者核查。

gyp实际node_modules未安装，没有运行Native构建或产品代理。本机根preinstall要求npm低于12；指定npm12只用于owned且ignore-scripts的锁生成，没有绕过或改该守卫。完整证据在审计 `owned/20261008-gyp-socks-compat-worker`。整树安装、编译、真实TLS/代理、产品和平台验收仍待完成。
