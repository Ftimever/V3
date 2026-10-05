# 架构与边界

本文解释第一版设计与边界。实际实现状态以 [实现计划](implementation-plan.md) 为准。

## 平台职责

平台提供插件容器，而不是机器人或游戏业务框架。核心概念仅包括插件、实例、服务、事件、资源作用域、能力授权与运行协议。QQ、Minecraft、账号和玩家等领域概念全部留在外部生态。

## 依赖边界

箭头表示依赖方指向被依赖方，而不是严格的构建流水线：

```text
core -> contracts + Cordis
rpc -> contracts
config -> contracts
runtime-process -> rpc + contracts
plugin-group -> contracts + config
loader -> core + runtime-process + plugin-group
base / WebUI / CLI -> public management contracts
```

`core` 不依赖 loader、CLI、WebUI、Node 文件系统或具体领域插件。Node.js provider 位于宿主层。workspace 内使用 `workspace:*` 依赖和公开导出，不引用其他包的私有源码路径。

## Cordis 集成

当前 kernel 实际创建 Cordis `Context`，每个挂载实例拥有 Cordis plugin fiber。服务通过 Cordis `provide` 注册，通知通过 Cordis 的监听及分发机制执行；平台作用域在 fiber 清理时释放资源。

默认插件上下文不暴露 Cordis 原始对象。`@easybot/cordis-compat` 仅提供显式、experimental、受限的 Cordis 风格 API；它不等于给所有插件开放宿主内部 registry，也不暴露原始 Cordis Context。

## 公开层级

设计将 API 分为 stable、experimental 和 internal。当前 `0.1.0` 是尚未发布的基础实现，不代表 stable ABI 已冻结。Cordis 原始上下文、代码热替换、自定义前端代码、容器沙箱和二进制 RPC 都不属于第一阶段。

## 外部验证

平台使用无领域语义的 fake provider、consumer 与失败场景测试。领域项目单独维护业务协议与验收，并在平台发布 contract-test 工具后调用通用兼容套件。真实领域项目不能成为平台构建或发布的必要依赖。
