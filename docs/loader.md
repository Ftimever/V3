# 加载本地或 npm 插件

本指南运行可信进程内插件。开始前运行 `pnpm install --frozen-lockfile` 和 `pnpm build`。先执行 `pnpm example:loader`，确认输出计数 `3` 和完整启停状态。

## 准备插件包

每个插件目录包含 `package.json`、`plugin.json` 和已构建的 JavaScript 入口。`package.json` 提供 npm 包名与 SemVer 版本，`plugin.json` 提供平台身份和声明。入口支持 `.js`、`.mjs`、`.cjs`，不直接加载 TypeScript 源码。

入口导出命名函数 `apply(context, config)`，或者默认导出包含 `apply` 的插件对象。对象若同时携带 `manifest`，它必须与 `plugin.json` 一致。apply 可以返回释放函数。loader 将释放函数加入实例作用域，激活失败时也清理已经注册的资源。

发现阶段读取并校验文件，但不执行入口。入口、manifest、包元数据与配置 Schema 必须在插件包 realpath 内。该约束不是文件系统沙箱：执行后的可信插件仍能导入外部依赖和使用 Node.js API。

## 创建实例

下面的代码从宿主的依赖中导入 workspace 包；仓库内完整可运行示例位于 `examples/loader.mjs`。

```js
import { createPluginLoader } from '@easybot/loader'

const loader = createPluginLoader({ baseDirectory: process.cwd() })

try {
  await loader.discover({
    instanceId: 'utility-main',
    source: { kind: 'local', path: './plugins/utility' },
    trust: 'trusted',
    config: {},
  })
  await loader.resolve()
  await loader.startAll()
} finally {
  await loader.dispose()
}
```

`trust` 必须显式提供。isolated 实例不能选择 in-process；child-process manifest 当前可以发现，但启动会明确失败，不会降级到进程内执行。

npm 来源写作 `{ kind: 'npm', packageName: '@example/utility', version: '^1.0.0' }`。包必须已经安装，声明范围必须匹配安装版本。发现不依赖包开放 `package.json` 导出，也不自动下载、改写依赖或执行安装脚本。

## 解析与授权

`resolve()` 在执行任何插件代码前检查所有已发现实例的必需依赖、版本范围、重复服务提供者及依赖环。可选依赖缺失或版本不匹配作为降级原因；已存在的可选依赖参与拓扑，包含可选边的环也会拒绝。当前服务 ID 全局唯一，多提供者选择、服务替换和组内绑定留待部署层实现。同一 pluginId 的多个兼容实例导致插件依赖歧义，不按加载顺序猜测提供者。

`start(instanceId)` 启动该实例的依赖闭包，`startAll()` 启动整个图。必需提供者启动失败时消费者不会执行入口；批量启动仍尝试独立实例，并汇总错误。可选失败不阻止默认策略的消费者激活，但会产生 degraded 状态和诊断信息。

消费者通过平台 API 访问服务时仍需完整的 manifest 权限、宿主 policy 和当前实例 grant。依赖声明不等于权限，trust 也不自动授予权限。初始 config 是冻结的 JSON 对象；manifest 的 config.schema 指向包内 draft 2020-12 Schema。平台不填充默认值、不进行类型转换，也不加载远程 Schema；`@easybot/config` 和 loader 的 reconfigure 路径负责持久化更新与失败回滚。

## 观察与停机

| 方法 | 行为 |
| --- | --- |
| `status(id)` / `list()` | 返回不可变状态快照、失败消息、降级原因和重试次数 |
| `subscribe(listener)` | 订阅状态变化；监听器异常进入诊断队列，不破坏加载流程 |
| `idle()` | 等待已排队的服务就绪变化与生命周期操作完成 |
| `stop(id)` | 先停止传递依赖，再清理目标实例 |
| `reportFailure(id, error)` | 清理故障目标及依赖，并将目标标记 failed |
| `retry(id)` | 按 manifest 的有界策略显式重试 failed 实例 |
| `stopAll()` / `dispose()` | 逆依赖停机；dispose 还关闭 loader 且幂等 |
| `takeDiagnostics()` | 取出并清空后台错误与观察者错误 |

运行期间的必需服务不可用会停止消费者。可选服务不可用默认只降级；`optionalDependencyFailure: 'stop'` 改为停机。恢复后已停止实例不会自动重新启动。宿主 capability 的注册与版本由 `LoaderOptions.capabilities` 提供，运行期通过 `setCapabilityAvailability()` 更新；它不代替权限授权。

当前增添实例要求先 `stopAll()`，不支持运行中变更插件集合、移除/替换代码或监听源码热加载。使用宿主提供的 `runtime` 时，loader 只清理自己的实例和订阅，不销毁共享 runtime。所有插件必须让 apply 与释放动作能够结束；进程内挂起代码不能被安全地强制终止。
