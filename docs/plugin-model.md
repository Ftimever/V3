# 插件身份与契约

## 三层身份

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `packageName` | 安装包身份 | `@example/provider` |
| `pluginId` | 平台插件身份 | `example.provider` |
| `instanceId` | 运行实例身份 | `provider-main` |

包的版本、作者、许可证和 npm 依赖从 `package.json` 读取；`plugin.json` 不重复维护这些字段。`runtime.entry` 是平台激活入口，可以不同于包的普通导出。当前 loader 验证入口、manifest 与配置 Schema 的 realpath 仍在包内；发现阶段不导入插件代码。加载步骤见 [loader 指南](loader.md)。

## Manifest

`schemas/plugin-manifest.v1.json` 是 wire 结构的来源。运行方式明确命名为 `in-process` 或 `child-process`，避免使用含义不清的 `process`。运行方式不等于信任或授权，宿主始终决定实际运行策略。

```json
{
  "schemaVersion": 1,
  "pluginId": "example.provider",
  "displayName": "Example provider",
  "runtime": { "kind": "in-process", "entry": "./dist/index.js" },
  "provides": {
    "services": [{ "id": "example.counter", "version": "1.0.0" }]
  }
}
```

`requires` 分别声明 plugin、service 和 capability 的 required/optional 依赖。npm 依赖仍只写入 `package.json`。Schema 检查结构；版本解析、重复身份、入口边界和依赖环检查属于宿主/loader 的语义校验。

## 服务

服务 token 使用字符串 ID、SemVer 版本和 TypeScript 泛型。消费者需要在 manifest 声明服务依赖，并请求 `service:<id>` 权限。当前 kernel 检查 manifest、组策略、实例授权及提供者版本。

`services.provide()` 返回就绪状态控制与释放句柄。服务可以注册为 `unavailable`；`get()` 此时返回 `undefined`，`require()` 抛出 `SERVICE_NOT_READY`。重复提供者默认抛出 `SERVICE_CONFLICT`。

第一阶段没有实现候选实现选择或服务替换；宿主绑定逻辑属于后续 loader/部署层。进程内服务对象必须是公开领域契约，不允许把内部客户端或私有 registry 当作契约。

## 事件

事件 payload 只能包含有限 JSON 值。kernel 克隆并冻结 payload，使监听器与 middleware 无法通过共享可变对象修改其他插件的数据。Map、Date、自定义实例、循环引用、undefined 和非有限数字被拒绝。

middleware 返回 continue、stop 或 retry。retry 仅返回调度建议，不自动重放副作用；是否允许 retry 和如何通知监听器，由发布者 manifest 的事件声明决定，而不是由调用方 token 决定。

排序使用插件依赖与显式 before/after。不存在顺序约束的节点按 middleware 稳定 ID 排序，不依赖加载先后；约束成环时立即拒绝注册。串行通知等待全部监听器完成，parallel 通知并发等待全部监听器完成。
