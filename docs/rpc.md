# RPC 协议

`schemas/rpc-envelope.v1.json` 描述第一版采用的 JSON envelope。`@easybot/rpc` 已提供有界 framing、固定连接身份、调用、流、取消、截止时间、错误和背压；`@easybot/runtime-process` 使用 stdio 将子进程插件接入宿主。

RPC 只提供故障隔离与协议边界，不是操作系统级沙箱。插件仍可能通过其运行环境访问文件、网络、环境变量或原生模块；不可信插件必须由外部部署层提供 OS 级限制。

## 结构

消息携带 `protocol: easybot.rpc`、`version: 1` 及判别字段 `type`。支持 request、response、notification、stream、cancel、hello 和 hello-ack；请求可以携带 capability、pluginInstanceId、traceId 和绝对 deadline。

这是受 JSON-RPC 启发的自定义协议，**不是兼容标准 JSON-RPC 2.0 的 wire 格式**。不能直接连接通用 JSON-RPC 客户端而不做转换。二进制编码属于后续传输实现，不改变领域服务契约。

```json
{
  "protocol": "easybot.rpc",
  "version": 1,
  "type": "request",
  "id": "request-1",
  "method": "service.example.counter.read",
  "pluginInstanceId": "consumer-main",
  "capability": "service:example.counter",
  "payload": {}
}
```

成功 response 使用 `ok: true`，失败 response 使用 `ok: false` 并必须包含结构化 error。notification 不允许请求 ID。握手用于版本和功能协商，不代表已获得授权。

## 传输计划

stdio 采用带长度限制的逐行 JSON 帧；stdout 专供协议，日志走 stderr。宿主从实际连接确认实例身份，不能信任 payload 中自报的身份。必须限制帧大小、未完成请求数量、流缓存和等待时长，并在进程退出时终止关联请求。

cancel 只能请求协作取消，不能保证撤销已发生的副作用。幂等、去重和重试政策属于服务契约。流和 deadline 仍需补齐传输层行为测试后才能称为可用功能。
