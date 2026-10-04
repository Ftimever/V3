# 第一版实现计划

本文跟踪实现状态，不以空目录或类型声明冒充运行功能。

## 已实现

- pnpm workspace、严格 TypeScript 配置、锁文件、Changesets 基础配置。
- `@easybot/contracts`，包括从插件与组 Schema 生成的 wire 类型。
- `@easybot/core`，包括真实 Cordis fiber、服务、就绪状态、权限访问与资源清理。
- 事件 payload 快照、middleware 排序/环检测、停止与重试策略校验。
- 插件、插件组和 RPC Schema，以及 provider/consumer 行为测试。
- `@easybot/loader`：本地/已安装 npm 发现、入口 realpath 边界、语义校验、初始配置校验与依赖拓扑。
- 实例状态、服务就绪变化通知、必需失败停机、可选降级、逆依赖清理与显式重试/隔离。

## 实现顺序

| 模块 | 当前状态 | 下一步验收 |
| --- | --- | --- |
| contracts / core | 基础实现及 API 类型兼容测试 | 补齐跨进程服务方法契约与 Cordis 兼容层 |
| loader | 进程内加载闭环 | 安装事务、显式服务绑定、自动重启、进程运行时接入 |
| config | 未实现 | JSON Schema、CAS、持久化、运行配置确认与回滚 |
| rpc | 仅契约 | stdio framing、调用、流、取消、认证身份、背压 |
| runtime-process | 未实现 | 握手、超时、重启策略、退出清理、故障隔离 |
| plugin-group | 仅 manifest | 锁文件、部署事务、服务绑定、升级与恢复 |
| base plugins | 未实现 | HTTP、WebSocket、logger、存储与密钥 provider |
| management / WebUI / CLI | 未实现 | 共享管理协议、认证、声明式贡献与生命周期控制 |
| plugin-contract-tests | 仓库内 fake 测试 | 发布可供外部插件使用的合规测试工具 |
| release | 仅 Changesets 配置 | 分包版本、发布产物检查、文档与迁移演练 |

每个模块先跑通纵向闭环，再扩展完整能力。这是实现策略，不恢复已经取消的 MVP 发布目标。整个第一版完成全部平台验收后才发布。

## 不纳入本仓库

QQ/Minecraft 实现、协议端适配器、领域 contracts、桥接业务与真实业务验收由外部仓库负责。代码热替换、自定义前端代码、容器沙箱、二进制 RPC 作为后续能力，不以无实现的接口占位宣称支持。
