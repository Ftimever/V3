# Easybot Platform

Easybot Platform 是基于 Cordis 的通用插件平台，优先服务插件开发者与平台运维者。QQ、Minecraft 和相关业务插件由外部项目维护，不属于平台内置模块。

## 当前实现

这是第一版平台实现，workspace 包按职责拆分：

- `@easybot/contracts`：插件、服务、事件、权限及 RPC 的 TypeScript 契约。
- `@easybot/core`：真实 Cordis 插件作用域、进程内插件挂载、服务注册、就绪状态、声明式访问检查、事件流水线与资源清理。
- `@easybot/loader`：本地目录/已安装 npm 包发现、manifest 与初始配置校验、依赖拓扑、生命周期状态、失败传播和显式有界重试。
- `@easybot/config` / `@easybot/state`：JSON Schema 配置、CAS、SQLite 持久化、密钥加密存储和运行配置回滚。
- `@easybot/rpc` / `@easybot/runtime-process`：有界 stdio RPC、流式背压、取消、身份握手和子进程故障隔离。
- `@easybot/plugin-group`：本地/npm 快照、完整性校验、组部署、升级、恢复和回滚。
- `@easybot/base`：存储、密钥、HTTP、WebSocket、日志和声明式 WebUI 基础服务。
- `@easybot/management` / `@easybot/cli`：loopback 管理 API、配置与组控制、WebUI 宿主和 CLI。
- `@easybot/host`：自持启动入口，负责数据目录、密钥、token、插件组恢复、管理 API 和信号关闭。
- `@easybot/contract-tests`：外部插件 manifest 与生命周期合规测试工具。
- `@easybot/cordis-compat`：实验性、受限的 Cordis 风格 API；不暴露原始 Cordis Context。

仓库同时维护插件、插件组及 RPC 的 JSON Schema，并从 Schema 生成 wire 类型。所有包暂时标记为 `private`，版本为 `0.1.0`；公开发布前仍需完成版本决策、迁移审查和领域项目验收。`pnpm run release:check` 验证构建、类型、生成物和每个包的 `pack --dry-run`。

## 开发环境

- Node.js 22.18 或更高版本。
- pnpm 10.28.0，版本记录在 `packageManager` 中。
- Cordis 固定为 `4.0.0-rc.10`，升级时运行兼容测试。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm example
pnpm example:loader
pnpm run release:check
pnpm start
```

`pnpm example` 运行一个 provider 和一个 consumer，输出计数结果与变更事件。`pnpm run ci` 检查生成类型、构建、类型检查与全部行为测试。`ci` 是 pnpm 保留命令，执行仓库脚本时需要写出 `run`。

`pnpm example:loader` 从独立插件目录加载 counter/consumer，校验配置与权限，输出 `Counter result` 和 `count: 3`，随后按消费者先于提供者的顺序停机。

`pnpm start` 启动自持宿主。默认管理 API 监听 `127.0.0.1:27800`，首次启动在 `data/management.token` 生成 Bearer token，并在控制台显示一次。详细配置、恢复和关闭顺序见[自持启动](docs/host.md)。

修改 `schemas/` 后运行 `pnpm generate`。不要直接修改 `packages/contracts/src/*.v1.ts` 或 `schemas.ts`；`pnpm check:generated` 检测 wire 类型与运行时 Schema 是否过期。

## 文档

- [架构与边界](docs/architecture.md)
- [插件身份与契约](docs/plugin-model.md)
- [生命周期与资源清理](docs/lifecycle.md)
- [加载本地或 npm 插件](docs/loader.md)
- [权限和隔离边界](docs/permissions.md)
- [插件组](docs/plugin-groups.md)
- [RPC 协议](docs/rpc.md)
- [WebUI 扩展](docs/webui-extensions.md)
- [故障排查](docs/troubleshooting.md)
- [第一版实现计划](docs/implementation-plan.md)

## 安全边界

平台同时支持受控子进程，但子进程只提供故障隔离和 RPC 边界；平台 API 的访问检查**不阻止插件直接使用 Node.js API**。它不是恶意代码沙箱。操作系统级限制、网络/文件策略和凭据隔离必须由外部部署层实现并单独验收。
