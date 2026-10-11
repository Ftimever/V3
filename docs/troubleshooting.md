# 故障排查

## 找不到 workspace 导出

先运行 `pnpm install --frozen-lockfile` 和 `pnpm build`。包导出指向 `dist`，不是源码路径；不要通过私有 `src/` 路径绕过包边界。

## 生成类型过期

修改 `schemas/` 后运行 `pnpm generate`，再运行 `pnpm check:generated`。提交 Schema 与生成结果，不直接编辑 `*.v1.ts` 或生成的 `schemas.ts`。

## 服务访问被拒绝

检查 consumer 的 required/optional 服务依赖、manifest 权限、组 policy 和绑定到当前 `instanceId` 的 grant。`SERVICE_NOT_READY` 是注册成功但当前不可用，不代表缺少安装包。

## Middleware 成环

检查 before/after 和插件依赖是否产生反向约束。错误报告包含涉及的 middleware ID；不能通过改变插件加载顺序修复环。

## 插件启动失败

core 会清理该实例已注册的资源；原始异常向宿主传播。如果清理也失败，会收到包含启动和清理异常的 AggregateError。loader 的批量启动汇总失败，但允许独立实例启动；通过 `status()` 检查状态和错误，通过 `takeDiagnostics()` 检查后台传播或观察者异常。启用 manifest restart policy 后，运行时故障会触发有界自动重试，也可显式调用 `retry()`。

## 找不到 npm 插件

先将插件安装到宿主项目的依赖目录。npm 来源填写 `packageName` 和可选的 SemVer `version` 范围，不填写 URL、`file:` 或带 `@latest` 的安装选择器。loader 只解析已安装包；npm 下载、完整性校验和安装事务仍在实现计划中。

## 宿主无法启动

先运行 `pnpm build`，再检查 `data/` 是否可写。`easybot.sqlite`、`master.key` 和 `management.token` 的父目录会自动创建；如果其中任一文件存在但内容损坏，宿主会拒绝启动，而不是静默重建密钥或 token。

## 管理 API 端口被占用

默认端口是 `27800`。通过 `EASYBOT_MANAGEMENT_PORT=27801 pnpm start` 或配置文件中的 `management.port` 修改端口。管理 API 只允许 `127.0.0.1`、`::1` 和 `localhost`，其他地址会在启动前拒绝。

## 首次启动后找不到 token

首次启动输出的 token 与 `data/management.token` 内容相同。不要把 token 放进插件组 manifest、日志或版本库；CLI 使用时设置 `EASYBOT_MANAGEMENT_TOKEN`，并将 `EASYBOT_MANAGEMENT_URL` 指向宿主地址。

## 插件组没有自动恢复

宿主只恢复 SQLite 中已启用且存在 active deployment 的组。检查管理 API 的 `/api/v1/groups`；如果某组的 `error` 包含完整性校验、依赖或配置错误，先修复部署源或回滚，再通过管理 API 执行 `start`。原始插件目录的修改不会更新已经快照的部署。
