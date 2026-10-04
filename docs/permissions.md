# 权限和隔离边界

## 四层检查

一次宿主 API 访问依次检查：manifest 声明、组策略、实例授权和当前目标。声明不等于授权；同一包的不同实例可拥有不同授权。

当前 kernel 使用精确权限 ID，不隐式支持通配符。`scope` 支持目标字段的标量相等检查及标量数组允许列表。缺少受限目标字段时拒绝访问；复杂对象约束尚未实现，不应使用它们表示路径或网络安全策略。

```json
{
  "id": "network:connect",
  "scope": { "host": ["localhost"], "port": 443 }
}
```

这个声明只是宿主 capability 检查的示例，并不拦截 Node.js `fetch` 或 socket 调用。

## 信任与运行方式

trusted 表示宿主信任代码在进程内执行；isolated 表示请求隔离执行；privileged 表示显式批准敏感能力，不应自动等同于进程内执行。安装来源、包名或 manifest 不能自行提升信任级别。

**当前 kernel 只允许可信进程内插件。** 后续 child-process 运行时首先实现故障隔离和受控 RPC。单独的子进程或 Worker 不自动限制文件系统、网络、环境变量、原生模块或子进程启动。

不可信代码需要操作系统级限制，且必须处理环境变量过滤、工作目录、密钥泄露、stdio 协议污染、资源配额和进程树清理。系统级沙箱未实现之前，不宣称已安全支持第三方恶意代码。

## 错误语义

- `CAPABILITY_NOT_DECLARED`：manifest 没有请求此权限。
- `CAPABILITY_NOT_GRANTED`：组策略或实例授权没有允许它。
- `PERMISSION_DENIED`：当前目标超出允许范围。
- `SCOPE_DISPOSED`：实例已停止，不能继续请求宿主能力。
