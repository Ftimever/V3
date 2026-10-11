# 自持启动

`@easybot/host` 是平台的默认宿主。它把 core、loader、base、插件组和管理 API 组装成一个长期运行的 Node.js 进程；QQ、Minecraft 和其他领域插件仍然由外部项目提供。

## 快速启动

要求 Node.js 22.18 或更高版本：

```sh
pnpm install
pnpm start
```

根目录的 `pnpm start` 会先构建 workspace，然后执行宿主。默认管理 API 监听 `127.0.0.1:27800`，按 `Ctrl+C` 后依次停止管理 API、插件组和 SQLite 状态库。

也可以直接运行：

```sh
pnpm --filter @easybot/host build
node packages/host/dist/index.js start
```

## 配置文件

宿主读取当前工作目录下可选的 `easybot.config.json`，也可以通过 `--config` 指定：

```sh
node packages/host/dist/index.js start --config ./config/easybot.config.json
```

```json
{
  "dataDirectory": "./data",
  "management": { "port": 27800 },
  "logs": { "capacity": 500 }
}
```

相对路径相对于配置文件所在目录。默认目录结构如下：

```text
data/
├── easybot.sqlite       # 插件组、配置和插件状态
├── master.key           # SecretVault 主密钥，不提交到 Git
├── management.token     # 管理 API Bearer token，不提交到 Git
└── plugins/             # 插件组部署快照
```

首次启动生成 `master.key` 和 `management.token`，并只在控制台显示一次新 token。后续启动从文件读取同一个 token。`EASYBOT_MANAGEMENT_TOKEN` 可以覆盖 token 文件，适合由进程管理器注入凭据。

## 环境变量

环境变量优先于配置文件：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `EASYBOT_DATA_DIR` | 数据目录 | `./data` |
| `EASYBOT_MANAGEMENT_HOST` | 管理 API 监听地址 | `127.0.0.1` |
| `EASYBOT_MANAGEMENT_PORT` | 管理 API 端口 | `27800` |
| `EASYBOT_MANAGEMENT_TOKEN` | Bearer token | 自动生成并保存 |

管理 API 只允许 loopback 地址。需要远程管理时，应在外部部署层增加经过认证的反向代理或跨进程桥接。

## 启动与停止

宿主按以下顺序初始化：

1. 读取配置，创建数据目录。
2. 打开 `StateStore`，读取或生成密钥和管理 token。
3. 创建日志、WebUI registry、安装器和插件组管理器。
4. 从 SQLite 恢复已启用且拥有 active deployment 的插件组。
5. 为每个插件组挂载 base 插件，再解析和启动组成员。
6. 启动 loopback 管理 API。

收到 `SIGINT` 或 `SIGTERM` 后，宿主只执行一次关闭流程：关闭管理 API、释放插件组及其子进程、最后关闭 SQLite。多个步骤失败时仍然继续清理，并以 `AggregateError` 报告失败。

恢复按插件组隔离。某个组完整性校验失败或启动失败时，该组会被标记为停用并保存错误；其他组和管理 API 仍然可以启动。处于 `applying` 的记录不会被当作新版本提交。

## 插件组

宿主不会扫描任意目录，也不会把 QQ 或 Minecraft 写入平台。通过管理 API 部署的本地目录或 npm 插件会被 `PackageInstaller` 快照到 `data/plugins/`，之后由 SQLite 中的 active deployment 恢复。

插件组同时是部署、版本锁定、恢复和回滚的单元；修改原始插件目录不会改变已经运行的快照。
