# Easybot Platform

Easybot Platform 是基于 Cordis 的通用插件平台，优先服务插件开发者与平台运维者。QQ、Minecraft 和相关业务插件由外部项目维护，不属于平台内置模块。

## 当前实现

这是第一版的基础与加载阶段，**不是完整平台发行版**。当前 workspace 实现三个包：

- `@easybot/contracts`：插件、服务、事件、权限及 RPC 的 TypeScript 契约。
- `@easybot/core`：真实 Cordis 插件作用域、进程内插件挂载、服务注册、就绪状态、声明式访问检查、事件流水线与资源清理。
- `@easybot/loader`：本地目录/已安装 npm 包发现、manifest 与初始配置校验、依赖拓扑、生命周期状态、失败传播和显式有界重试。

仓库同时维护插件、插件组及 RPC 的 JSON Schema，并从 Schema 生成 wire 类型。所有包暂时标记为 `private`，版本为 `0.1.0`；在完整验收之前，不发布或承诺第三方 ABI 稳定。

**尚未实现**：本地/npm 安装事务、自动重启调度、子进程运行时、RPC 传输、插件组部署/回滚、配置持久化/热更新、SQLite 状态库、密钥存储、基础插件、WebUI 和 CLI。当前 npm 来源只解析已经安装的包，不自动下载或执行安装脚本。详情见 [实现计划](docs/implementation-plan.md)。

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
```

`pnpm example` 运行一个 provider 和一个 consumer，输出计数结果与变更事件。`pnpm run ci` 检查生成类型、构建、类型检查与全部行为测试。`ci` 是 pnpm 保留命令，执行仓库脚本时需要写出 `run`。

`pnpm example:loader` 从独立插件目录加载 counter/consumer，校验配置与权限，输出 `Counter result` 和 `count: 3`，随后按消费者先于提供者的顺序停机。

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

当前 kernel 仅挂载可信的进程内代码；平台 API 的访问检查**不阻止插件直接使用 Node.js API**。未来子进程提供故障隔离，但也不自动提供安全沙箱。操作系统级限制、网络/文件策略和凭据隔离必须单独实现并验收后，才能宣称可安全运行不可信插件。
