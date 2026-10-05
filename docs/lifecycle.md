# 生命周期与资源清理

## 设计状态机

状态集合不是一条线性流程。设计允许：

```text
discovered -> resolved -> starting -> ready -> running
starting -> failed
running <-> degraded
ready / running / degraded -> stopping -> stopped
failed -> starting           受限重试
failed -> quarantined        超过策略限制
stopped -> resolved           再次启用
```

服务注册、插件初始化完成、外部连接就绪是不同事实，不能混成一个状态。loader 保存可查询状态；可选能力缺失时显示 degraded，必需依赖失败时停止消费者。

**当前状态**：core 实现挂载与资源清理；loader 实现进程内状态机、显式有界重试与失败依赖传播。初始化成功经过 ready，未就绪的声明服务和缺失的可选依赖使实例进入 degraded。required 服务不可用时消费者不能启动；运行期丢失时先停止消费者及其传递依赖。

`stop()` 和 `reportFailure()` 按逆依赖顺序清理受影响实例。`reportFailure()` 将目标记为 failed，而手动停机记为 stopped。恢复服务后，可选消费者自动由 degraded 回到 running；已经停止的必需消费者必须显式 `start()`，不会偷偷重新执行副作用。

`retry()` 仅接受启用 restart policy 的 failed 实例，遵循 maxAttempts 与 fixed/linear/exponential 延迟。默认最多重试 3 次，初始延迟 1000 ms，延迟上限 30000 ms；loader 会在运行时故障后按该策略自动调度有限重试。重试额度在 loader 生命周期内累计，超限记为 quarantined。显式 stop 后可以重新启用，但不会重置累计次数；启动、关闭和 RPC 请求均有边界超时。

## Kernel 作用域

每个插件通过 `lifecycle.add(dispose)` 注册释放动作。返回的句柄立即执行释放动作，并将它从待清理集合移除。重复调用该句柄或 `dispose()` 不会重复释放资源。

清理按逆注册顺序执行。一个释放动作失败不会阻止其余动作，最终通过 `AggregateError` 报告。激活失败会清理已注册服务、监听器和资源，并允许同一实例稍后重试。

作用域释放后，服务访问、事件注册和 capability 检查拒绝新操作。进程内插件已经缓存的服务对象或绕过宿主创建的外部资源，不属于可强制撤销的安全边界；插件必须遵守生命周期契约。

## 后续配置更新

第一版支持显式应用配置，并根据 `x-reload` 选择 hot、reconnect、restart 或 manual。代码热替换不在第一版实现范围；它需要排空、状态迁移、去重和恢复策略，不能只清除 import 缓存。
