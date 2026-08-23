# @dshserver/gateway-server

把 Runtime Gateway 跑成一个服务。

`@dshserver/runtime-gateway` 负责管理 Runtime 进程，但它周围的服务器留给了宿主应用。
结果是每个部署都要照集成指南把同一段顺序重写一遍：匹配 DSH 路径 → 认证 → 用策略扩展
身份 → 拒绝被锁的 RPC → 解析 Runtime → 改写 `session.create` → 代理。这段顺序写错不会
在测试里暴露，会变成安全缺陷，不该让每个部署各实现一次。

身份仍然属于宿主应用：`authenticate` 和 `authorize` 由调用方提供，因为 IAM 和策略控制面
是宿主的，不是这个包的。

## 用法

```ts
import { createServer } from 'node:http'
import { GatewayServer } from '@dshserver/gateway-server'
import { defaultRuntimeOptions } from '@dshserver/runtime-gateway'

const gateway = new GatewayServer({
  authenticate: async request => await verifySession(request),   // 你的 IAM
  authorize: async principal => policyStore.agentPrincipal(principal),  // 你的策略控制面
  authority: { issueRuntimeLease },                              // 你的签名器
  runtime: defaultRuntimeOptions(projectRoot, publicOrigin, internalOrigin),
  onDenied: event => audit(event.subject, event.pathname, event.denial),
})

const server = createServer((request, response) => {
  void gateway.handleRequest(request, response).then(handled => {
    if (!handled) app(request, response)     // 不是 DSH 的路径，交回宿主应用
  })
})

server.on('upgrade', (request, socket, head) => {
  void gateway.handleUpgrade(request, socket, head)
})
```

两个入口在路径不属于 DSH 时都返回 `false`，所以它是叠加在既有应用上的，不是替换它。

## 契约

| 选项 | 说明 |
|---|---|
| `authenticate` | 校验请求，返回它证明的身份；证明不了就返回 `undefined`（普通的认证失败不要抛异常） |
| `authorize` | 用部署策略扩展已验证身份：preset 角色、有效工具集、可选模型、配置权限 |
| `authority` | 签发 Runtime Lease |
| `runtime` | 透传给 `RuntimeManager` 的选项 |
| `onDenied` | 每次拒绝都会回调；否则拒绝是静默的 |

`authorize` 返回的 `tools` 必须已经是「角色策略 ∩ 用户策略 ∩ 已授予 Scope」的结果。
本包转发这个结果，不再收窄。

## 两个刻意的取舍

**RPC 锁按 IAM 实际授予的 Scope 判定，而不是策略扩展后的集合。** 策略可以收窄用户的
能力，但不能发放 IAM 没给的权限——配置类 RPC 是这条界线真正起作用的地方。

**代理是用 `node:http` 自己实现的，没有引入代理库。** 这个组件坐在授权边界上，浏览器与
Runtime 之间的每个字节都经过它；而这个领域里现成的选择要么已停止维护，要么自带一棵依赖
树。Runtime 代理实际需要的东西很窄：一个上游、除请求行外不做改写、升级就是两个 socket
对接。

## 许可

[MIT](LICENSE)
