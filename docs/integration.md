# 集成指南

本文帮你把 DSH Server 接入既有业务系统：用你自己的 IAM、BFF、Token Broker 和业务 API
替换仓库中的演示实现，并把第一个业务接口变成 Agent 工具。

演示服务器把 IAM、BFF、Runtime Gateway、Token Broker 和业务 API 放在一个进程里，只是
为了让协议和权限差异可见。正式接入时**保持协议边界不变，不复制演示账号系统**。

阅读前建议先跑一遍 [`examples/local-smoke`](../examples/local-smoke)，并理解[核心概念](concepts.md)中的权限交集。

## 接入前准备

| 事项 | 需要确认 | 负责人 |
|---|---|---|
| 授权服务器 | 支持 Authorization Code + PKCE，可自定义 Audience 与声明 | IAM 团队 |
| Scope 规划 | 业务读/写 Scope 与管理 Scope 命名已评审 | 业务与安全团队 |
| 角色映射 | 企业角色到 Agent Preset 的映射规则 | 业务团队 |
| 业务 API | 具备对象级授权、幂等写入与审计能力 | 业务团队 |
| Token Exchange | 可提供 RFC 8693 端点，或企业 OBO 等价能力 | IAM 团队 |
| 运行环境 | Node.js `>=22.19`，可运行子进程与本地文件写入 | 运维团队 |

## 集成全景

```text
步骤 1  规划 Scope 与角色映射
步骤 2  在 IAM 中签发 Gateway Access Token
步骤 3  在既有 BFF 完成登录与 Token 持有
步骤 4  部署 Runtime Gateway 并代理 DSH 流量
步骤 5  提供 Token Exchange 端点
步骤 6  把业务接口变成 Agent 工具
步骤 7  接入策略控制面与设置页
步骤 8  从业务页面把一段话送进对话框
步骤 9  按验收清单确认
```

## 步骤 1：规划 Scope 与角色映射

先确定「谁能做什么」，再写任何代码。建议采用 `<资源>:<动作>:<范围>` 的 Scope 命名。

仓库示例的规划如下，可直接作为模板替换：

| Scope | 含义 | 授予对象 |
|---|---|---|
| `assistant:use` | 允许使用 Agent；缺失时 Gateway 直接拒绝 | 所有获准用户 |
| `customers:read:self` | 只读本人负责的记录 | 普通员工 |
| `customers:read:team` | 只读本团队记录 | 管理者、审计员 |
| `customers:write:team` | 修改本团队记录 | 管理者 |
| `analytics:read` | 读取团队统计 | 管理者、审计员 |
| `assistant:policy:read` / `:write` | 读取 / 修改 Agent 业务策略 | 业务管理员 |
| `assistant:platform:read` / `:write` | 读取 / 修改平台配置与凭据 | 平台管理员 |

角色到 Agent Preset 的映射：

| 企业角色 | Agent Preset | `readScope` |
|---|---|---|
| 一线员工 | `employee` | `customers:read:self` |
| 团队管理者 | `manager` | `customers:read:team` |
| 只读审计 | `auditor` | `customers:read:team` |

新增角色时复制 `config/agent-presets/<role>/` 目录并修改人设与 `readScope`。

## 步骤 2：在 IAM 中签发 Gateway Access Token

在既有授权服务器中为业务系统 BFF 注册客户端，并确保签发的 Access Token 满足：

| 要求 | 说明 |
|---|---|
| 签名算法 | RS256 或同等强度非对称算法，提供 JWKS 端点 |
| `typ` | 建议 `at+jwt`，便于与其他 Token 区分 |
| `aud` | Runtime Gateway 专用 Audience，例如 `urn:dshserver:runtime-gateway` |
| 必需声明 | `sub` `iss` `exp` `jti` `client_id` `name` `role` `tenant_id` `team_id` `scope` |
| 有效期 | 建议不超过 30 分钟，配合 Refresh Token 续期 |

声明含义见[核心概念 · Gateway Access Token](concepts.md#gateway-access-token)。

**注意**：`sub`、`iss`、`tenant_id` 参与 Runtime 路由键。这三个值必须稳定，否则用户会
在每次登录后拿到新的空白 Runtime。

## 步骤 3：在既有 BFF 完成登录与 Token 持有

BFF 负责发起授权、交换 Token 并持有它。浏览器只拿到 HttpOnly 会话 Cookie。

要点清单：

- 授权请求使用 PKCE（`code_challenge_method=S256`），并校验 `state` 与 `redirect_uri`。
- 会话 Cookie 设置 `HttpOnly`、`SameSite=Lax`；`PUBLIC_ORIGIN` 为 HTTPS 时加 `Secure`。
- Access Token 到期前主动刷新，并对并发刷新做单飞（single-flight）处理。
- 绝不把 Access Token 写入 URL、localStorage 或返回给前端。
- 登出时同时清除服务端会话与 Cookie。

这一层完全由集成方的既有 BFF 实现，本仓库不提供，也不需要知道它的存在。

## 步骤 4：部署 Runtime Gateway 并代理 DSH 流量

安装 `@dshserver/runtime-gateway`，用它管理每用户 Runtime，并把 DSH 的 HTTP 与
WebSocket 流量代理到对应 Runtime。

> **想直接用现成的：** `@dshserver/gateway-server` 已经把 4.3–4.4 这段顺序做成了
> 可运行的服务——匹配路径、认证、套用策略、拒绝被锁的 RPC、解析 Runtime、改写
> `session.create`、代理。认证与策略仍由你提供。这段顺序写错不会在测试里暴露、
> 会变成安全缺陷，所以除非确有必要，建议用现成的那套：
>
> ```ts
> import { GatewayServer } from '@dshserver/gateway-server'
>
> const gateway = new GatewayServer({
>   authenticate: async request => await verifySession(request),
>   authorize: async principal => policyStore.agentPrincipal(principal),
>   authority: { issueRuntimeLease },
>   runtime: defaultRuntimeOptions(projectRoot, publicOrigin, internalOrigin),
> })
>
> const server = createServer((request, response) => {
>   void gateway.handleRequest(request, response).then(handled => {
>     if (!handled) app(request, response)   // 不是 DSH 的路径，交回宿主应用
>   })
> })
> server.on('upgrade', (request, socket, head) => { void gateway.handleUpgrade(request, socket, head) })
> ```
>
> 下面各节描述这套接线**做了什么**，自己实现时按它们来。

### 4.1 创建 Runtime Manager

```ts
import { RuntimeManager, defaultRuntimeOptions } from '@dshserver/runtime-gateway'

const runtimes = new RuntimeManager(authority, defaultRuntimeOptions(
  projectRoot,            // 宿主应用根目录，用于派生 Preset、Profile 与插件包路径
  publicOrigin,           // 对外访问地址，用于 trusted-host 校验
  internalOrigin,         // Runtime 回调 Broker 与业务 API 的内部地址
))
```

派生路径按参考部署的目录约定（`<projectRoot>/plugin/...`）。宿主应用的目录结构不同时，
用 `pluginRoot`、`preferencesRoot`、`configRoot` 直接指定这三份部署资产，见
[配置参考 · Runtime Gateway 选项](configuration.md#runtime-gateway-选项)。

`authority` 只需实现一个方法：

```ts
interface RuntimeLeaseIssuer {
  issueRuntimeLease(principal: GatewayPrincipal, runtimeId: string): Promise<string>
}
```

它应签发 `aud = urn:dshserver:runtime-lease`、有效期约 5 分钟的 JWT，声明至少包含
`sub`、`tenant`、`tenant_id`、`team_id`、`scope`、`runtime_id`、`exp`。

### 4.2 把可信身份转换为 RuntimePrincipal

Gateway 接受的是**已验证**的 Principal。把 IAM 声明与策略控制面的结果合并：

```ts
const authenticated = await verifyGatewayToken(session.accessToken) // 你的 IAM 验证
const current = policyStore.agentPrincipal(authenticated)           // 你的策略控制面
// current 额外包含：presetRole、tools、models、policyRevision、canConfigureDsh
```

`tools` 必须是「角色策略 ∩ 用户策略 ∩ 已授予 Scope」的结果，见
[核心概念 · 有效工具集](concepts.md#有效工具集是怎么算出来的)。

### 4.3 拦截并代理请求

```ts
app.use(async (request, response, next) => {
  if (!isDshHttpPath(request.path)) return next()

  const authenticated = await principal(request)
  if (authenticated === undefined) return unauthorized(response)

  const current = policyStore.agentPrincipal(authenticated)
  if (!current.scopes.includes('assistant:use')) return forbidden(response)

  if (blockedDshRpc(request.path, authenticated.scopes)) {
    audit(current.subject, 'dsh.rpc', request.path, 'denied')
    return forbidden(response, 'managed_capability_locked')
  }

  const runtime = await runtimes.runtime(current)
  if (request.path === '/api/session.create') {
    request.body = prepareSessionCreateBody(await readBody(request), runtime)
  }
  proxy.web(request, response, { target: runtime.target })
})
```

需要代理的路径：`/assistant`、`/api/*`、`/plugins/*`、`/assets/*`、`/favicon.svg`、
`/manifest.webmanifest`。

### 4.4 用同一套策略处理 WebSocket 升级

```ts
server.on('upgrade', async (request, socket, head) => {
  const authenticated = await principal(request)
  if (authenticated === undefined) return endUpgrade(socket, 401)
  const current = policyStore.agentPrincipal(authenticated)
  if (!current.scopes.includes('assistant:use')) return endUpgrade(socket, 403)
  if (blockedDshRpc(pathnameOf(request), authenticated.scopes)) return endUpgrade(socket, 403)
  proxy.ws(request, socket, head, { target: (await runtimes.runtime(current)).target })
})
```

`/api/events.mux` 与 `/api/events.host` 两个事件通道都必须经过上述检查。

### 4.5 确认锁定生效

`blockedDshRpc()` 是部署侧的最后一道 RPC 边界，默认拒绝下列能力：

| 分类 | 路径前缀 | 条件 |
|---|---|---|
| 配置与凭据 | `/api/settings.describe` `/api/settings.update` `/api/settings.replace` `/api/settings.mutate` `/api/credentials.*` `/api/llm.discoverModels` | 缺少 `assistant:platform:write` 时拒绝 |
| 文档打开 | `/api/settings.openDocument` | 始终拒绝 |
| 动态插件 | `/api/cordis.*` `/api/plugin.*` | 始终拒绝 |
| 宿主文件 | `/api/host.open` `/api/host.pickDirectory` `/api/host.listDirectory` `/api/host.createDirectory` | 始终拒绝 |
| 工作区变更 | `/api/workspace.create` `/api/workspace.rename` `/api/workspace.delete` `/api/workspace.insertBefore` `/api/workspace.insertSessionBefore` | 始终拒绝 |
| Preset 管理 | `/api/agentPreset.create` `/api/agentPreset.copy` `/api/agentPreset.remove` `/api/agentPreset.read` `/api/agentPreset.select` | 始终拒绝 |
| 权限管理 | `/api/permission.*` | 始终拒绝 |

## 步骤 5：提供 Token Exchange 端点

插件按调用换取降权业务 Token。你的 Broker 端点需要：

1. 接受 `application/x-www-form-urlencoded`，校验三个 Token 类型参数完全匹配。
2. 用 JWKS 验证 Runtime 租约的签名、`iss`、`aud`、`typ` 与 `exp`。
3. 确认请求 `scope` 是租约 `scope` 的子集，**任何超集请求都必须拒绝**。
4. 确认 `resource` 是允许的业务 Audience。
5. 签发 `aud = <业务 Audience>`、有效期 60～300 秒的 Access Token，并保留 `sub`、
   `tenant_id`、`team_id` 与请求的 `scope`；可加入 `actor_runtime` 便于审计。

请求与响应格式见[工具与 API 参考 · Token Exchange 接口](tools-and-api.md#token-exchange-接口)。
可运行的最小实现见 [`examples/local-smoke/smoke.mjs`](../examples/local-smoke/smoke.mjs) 中的
`startBroker()`——它验证租约、按租约 Scope 降权、签发 120 秒的业务 Token。

## 步骤 6：把业务接口变成 Agent 工具

新增一个业务工具只需要改两个文件，不需要触碰 OAuth 交换、Runtime 身份或 Gateway
策略代码。

### 6.1 在策略表登记工具

编辑 `packages/dsh-integration/src/policy.ts`，这是工具 Scope 的**单一事实来源**：

```ts
export const BUSINESS_TOOL_NAMES = [
  // ...
  'business_search_orders',
] as const

const TOOL_POLICIES: Record<BusinessToolName, ToolPolicy> = {
  // ...
  business_search_orders: { scopes: readScope => [readScope, 'orders:read'], mutating: false },
}
```

- `scopes(readScope)` 返回执行该工具所需的全部 Scope。
- `mutating` 标记写操作，命中租户级写开关与幂等键逻辑。

执行前守卫与 Token Exchange 都从这张表派生，因此不可能出现「检查一个 Scope、申请另一个
Scope」的情况。

### 6.2 用 `businessTool()` 声明目录条目

在自己的目录文件中（建议放在 `packages/dsh-integration/src/` 下，与示例 `customer-tools.ts` 并列）声明：

```ts
import { businessTool, type BusinessToolRegistration } from './catalog.js'

export const ORDER_TOOLS: readonly BusinessToolRegistration[] = [
  businessTool({
    name: 'business_search_orders',
    description: '查询当前登录用户有权查看的订单。身份由 OAuth 授权确定，不接受用户 ID。',
    parameters: {
      keyword: { type: 'string', description: '可选关键词，匹配订单号或客户名称。' },
    },
    output: {
      type: 'object', additionalProperties: false,
      properties: {
        total: { type: 'integer', required: true },
        items: { type: 'array', required: true, items: ORDER_SCHEMA },
      },
    },
    presentCall: () => ({ card: 'generic', title: '查询授权范围内的订单', kind: 'search' }),
    request(args) {
      const query = new URLSearchParams()
      if (args.keyword) query.set('keyword', args.keyword)
      return { path: query.size === 0 ? '/v1/orders' : `/v1/orders?${query.toString()}` }
    },
  }),
]
```

`businessTool()` 会自动完成：按策略表申请 Token Exchange Scope、应用租户级写开关、
为写操作附加 `idempotency-key`、套用管理员配置的超时、渲染结果。你只需要描述
「模型看到什么」和「一次调用对应哪个下游请求」。

写工具可以在 `request()` 中读取受信任上下文做前置校验，例如变更原因长度：

```ts
request(args, { settings }) {
  const reason = args.reason.trim()
  if (reason.length < settings.minimumWriteReasonLength) {
    throw new Error(`变更原因至少需要 ${settings.minimumWriteReasonLength} 个字符。`)
  }
  return { path: `/v1/orders/${encodeURIComponent(args.order_id)}`, method: 'PATCH', body: { reason } }
}
```

抛出的错误会作为面向模型的拒绝原因返回，因此**不要在其中包含内部地址、Token 或堆栈**。

### 6.3 注册到组合根

在 `packages/dsh-integration/src/index.ts` 中把新目录加入注册循环：

```ts
for (const tool of [...CUSTOMER_TOOLS, ...ORDER_TOOLS]) {
  if (exposed.has(tool.name)) tool.register(ctx, dependencies)
}
```

### 6.4 在 Agent Preset 中开放工具

工具最终是否可见由部署输入决定。演示环境通过环境变量注入，生产环境同理：

```yaml
- id: dshserver-business
  name: '@dshserver/dsh-integration'
  config:
    brokerUrl: !!js process.env.DSHSERVER_INTERNAL_ORIGIN
    businessApiUrl: !!js process.env.DSHSERVER_INTERNAL_ORIGIN
    runtimeLeaseFile: !!js process.env.DSHSERVER_RUNTIME_LEASE_FILE
    scopes: !!js process.env.DSHSERVER_SCOPES.split(' ')
    exposedTools: !!js JSON.parse(process.env.DSHSERVER_EXPOSED_TOOLS)
    readScope: customers:read:team
```

完整参数见[配置参考 · 插件部署配置](configuration.md#插件部署配置)，检查表见
[插件架构](ARCHITECTURE.md)。

### 6.5 覆盖测试

每个新工具至少覆盖五种情况：允许执行、缺少 Scope、对象级拒绝、下游超时、写操作
幂等重放。

## 步骤 7：接入策略控制面与设置页

三类配置必须放在各自的控制面，不能混在同一个页面：

| 配置类型 | 控制面 | 所需 Scope | 生效方式 |
|---|---|---|---|
| 个人偏好 | 既有业务系统 | 仅当前 Subject | 立即 |
| Agent 业务策略（角色/用户可用工具） | 既有业务系统 | `assistant:policy:write` | 下次 Runtime 启动，策略指纹变化触发重启 |
| 租户行为（超时、写开关、原因长度） | DSH 原生设置页 | `assistant:platform:write` | 活动 Runtime 实时读取 |
| 模型 Provider 与凭据 | DSH 原生 Models 页 | `assistant:platform:write` | 同租户热更新 |

策略写入必须校验管理 Scope 与策略版本号（或 ETag），防止并发覆盖。策略控制面由集成方
实现；本仓库只消费它产出的 `RuntimePrincipal`。

第三方插件注册的设置命名空间不需要额外登记：自 Harness `0.1.1-rc.2` 起 ApiProxy 不再维护
命名空间白名单，凡是已注册的命名空间都会出现在 `settings.describe` 结果里。远程读写的边界
由 Gateway 承担——`settings.describe/update/replace/mutate` 全部要求
`assistant:platform:write`，普通业务用户拿不到任何设置命名空间。

## 步骤 8：从业务页面把一段话送进对话框

业务系统经常已经知道用户此刻要问什么：客户详情页上的「问智能体」、工单页上的「让助手
总结」。`@dshserver/dsh-preferences` 让业务页面把这段话直接放进嵌入助手的输入框，用户
读完再自己按发送。

插件**只填写输入框，不代替用户发送**，因此嵌入页面无法让智能体自行说话或调用业务工具。

### 8.1 前置条件

- 业务页面与嵌入助手的页面在同一个源（由集成方用统一域名或反向代理实现）。
  插件只接受同源消息，且发送方必须是嵌入它的窗口（`parent` 或 `opener`）。
- 企业 Profile 已加载 `@dshserver/dsh-preferences`（默认 Profile 已包含）。

### 8.2 发送一条话术

```ts
const frame = document.querySelector<HTMLIFrameElement>('iframe#assistant')
frame?.contentWindow?.postMessage({
  channel: 'dshserver.composer',
  version: 1,
  type: 'insert',
  requestId: crypto.randomUUID(), // 可选；带上它，重发不会重复插入
  text: '查一下 CUS-1011 青屿能源的详情，它现在到哪个阶段了？',
  mode: 'append',                 // 可选，默认 append，不覆盖用户已经写的内容
}, location.origin)
```

助手回一条 `{ channel, version, type: 'result', status, reason?, requestId? }`：`applied`
表示已写入输入框，`pending` 表示会话尚未就绪、已暂存，`rejected` 表示被拒绝并给出
`reason`。字段、取值与全部拒绝原因见
[工具与 API 参考 · 对话框话术接口](tools-and-api.md#对话框话术接口)。

发送 `{ channel, version, type: 'ping' }` 可以探测插件是否就绪；插件在激活时也会主动向
`parent` 与 `opener` 发送一条 `{ type: 'ready' }`。

### 8.3 边界

- 插件只写草稿：正在提交的输入框会被拒绝，`append` 不会覆盖用户已经写的内容。
- 跨源发送会被静默忽略；不要用 URL 查询参数传话术，业务内容会进入浏览器历史与访问日志。
- 插件侧实现见 [`packages/dsh-preferences/src/composer-bridge.ts`](../packages/dsh-preferences/src/composer-bridge.ts)。
  建议不要做复制粘贴兜底：送入失败直接显示原因，这条路径是否可用一眼可见。

## 步骤 9：接入验收清单

- [ ] 两个不同用户登录后生成不同的 Runtime 目录与 DSH 进程。
- [ ] 浏览器中不存在任何 Access Token；`document.cookie` 读不到会话。
- [ ] 缺少 `assistant:use` 的账号访问 `/assistant` 返回 403。
- [ ] 普通用户调用 `/api/settings.update`、`/api/cordis.*`、`/api/workspace.create` 返回 403。
- [ ] 只读角色的工具列表中不存在写工具。
- [ ] 越权读取具体对象由业务 API 返回 404 或 403，而不是由前端隐藏。
- [ ] 写操作重复提交同一 `idempotency-key` 只产生一次业务变更。
- [ ] 日志、错误信息与会话事件中检索不到 Token 或租约内容。
- [ ] 修改角色策略后，用户的 Runtime 在下一次访问时按新策略重启。
- [ ] `/api/events.mux` 与 `/api/events.host` 在未登录时无法完成 WebSocket 升级。
- [ ] 业务页面送入的话术只出现在输入框，仍由用户按发送；跨源页面的同一条消息被忽略。

## 常见集成错误

| 现象 | 原因 | 处理方式 |
|---|---|---|
| 每次登录都得到空白会话 | `sub` 或 `tenant_id` 不稳定 | 改用稳定的企业标识，不要使用会话级 ID |
| 工具在模型侧不可见 | `exposedTools` 未包含，或所需 Scope 未授予 | 检查策略控制面输出与 Token 中的 `scope` |
| Token Exchange 返回 403 | 请求 Scope 超出租约 Scope | 核对策略表与租约签发时写入的 `scope` |
| 工具提示没有有效执行授权 | 租约文件缺失、权限不对或已过期 | 确认 Gateway 续期逻辑与 `0600` 权限 |
| 修改策略后不生效 | 策略指纹未变化 | 确认 `tools`/`scopes` 实际发生变化并触发重启 |
| WebSocket 断线重连失败 | 反向代理未传递 Upgrade 头 | 在反向代理上透传 `Upgrade` 与 `Connection` 头 |

## 后续步骤

- 查每一个配置项：[配置参考](configuration.md)
- 查工具与接口细节：[工具与 API 参考](tools-and-api.md)
- 上线前的安全自查：[安全模型](security-model.md)
