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
- 配置持久化、JSON Schema 校验、CAS、热更新/重连/重启/人工确认及失败回滚。
- 有界 stdio RPC、身份握手、方法白名单、截止时间、取消、流式背压及子进程故障隔离。
- 插件组快照、完整性校验、部署事务、版本升级、恢复与回滚；本地目录和 npm 来源安装默认禁用脚本。
- 基础存储、密钥、HTTP、WebSocket、日志和声明式 WebUI registry；管理 API 与 CLI 共用认证协议。
- 管理 API 的状态、配置、组部署/启停/回滚和 WebUI 只读接口；固定 loopback、Bearer token、Host、Origin 与请求体边界。
- `@easybot/contract-tests` 外部插件合规检查包与实验性的受限 `@easybot/cordis-compat` 适配层。
- `release:check` 发布验收：所有 workspace 包构建、类型、生成物和 `pack --dry-run`。

## 实现顺序

| 模块 | 当前状态 | 下一步验收 |
| --- | --- | --- |
| contracts / core | 已完成 | 后续可扩展稳定 ABI；Cordis 原始 Context 仍不作为公共契约 |
| loader | 已完成 | 后续再扩展更多安装源和 OS 级沙箱 |
| config | 已完成 | 后续增加更丰富的迁移与 UI schema 能力 |
| rpc / runtime-process | 已完成 | 当前提供故障隔离，不宣称恶意代码沙箱 |
| plugin-group | 已完成 | 外部不可逆副作用仍需领域项目自行补偿 |
| base plugins | 已完成 | WebUI 保持声明式，不允许任意插件脚本注入 |
| management / WebUI / CLI | 已完成基础闭环 | 后续可增加更细粒度管理授权与完整前端应用 |
| plugin-contract-tests | 已完成基础包 | 外部项目可直接引入并扩展领域特定断言 |
| release | 已完成验收脚本 | 发布前仍需 Changesets 版本决策和人工迁移审查 |

每个模块先跑通纵向闭环，再扩展完整能力。这是实现策略，不恢复已经取消的 MVP 发布目标。整个第一版完成全部平台验收后才发布。

## 不纳入本仓库

QQ/Minecraft 实现、协议端适配器、领域 contracts、桥接业务与真实业务验收由外部仓库负责。代码热替换、自定义前端代码、容器沙箱、二进制 RPC 作为后续能力，不以无实现的接口占位宣称支持。
