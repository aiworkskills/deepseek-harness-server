# @dshserver/dsh-integration

本文帮你在 DeepSeek Harness 中加载 DSH Server 业务连接器，并查到它的全部配置项。

这是一个树外 Cordis 插件。它注册标准 `ctx.tools` 工具，在每次执行前检查服务器下发的
工具集合、OAuth Scope 和短期 Runtime 租约，并通过 OAuth Token Exchange 调用受保护的
业务 API。

插件不接收 `userId`、`tenantId`、角色或 Access Token 作为模型参数。用户身份来自 Runtime
Manager 写入的受保护租约；Token Broker 负责签名、Issuer、Audience、过期时间和 Scope 的
最终验证。

## 两个入口

| 入口 | 加载平面 | 作用 |
|---|---|---|
| `@dshserver/dsh-integration` | Agent Preset | 注册业务工具与执行前授权守卫 |
| `@dshserver/dsh-integration/settings` | Host Profile | 安装 `dshserver-integration` 租户设置命名空间 |

Host 平面先加载 settings 入口，使命名空间在任何会话创建前就已存在；业务工具插件只
实时读取该 Host-owned section，不重复注册命名空间。

## 在 Agent Preset 中加载

```yaml
- id: dshserver-business
  name: '@dshserver/dsh-integration'
  config:
    brokerUrl: https://broker.internal.example.com
    businessApiUrl: https://api.internal.example.com
    runtimeLeaseFile: /run/secrets/runtime-lease.jwt
    scopes: [assistant:use, customers:read:team, customers:write:team]
    exposedTools: [business_list_customers, business_update_customer]
    readScope: customers:read:team
```

## 配置

### 部署输入（`src/config.ts`）

| 名称 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `brokerUrl` | string | 是 | — | 内部 OAuth Token Exchange 服务地址 |
| `tokenEndpointPath` | string | 否 | `/internal/oauth/token` | Token Exchange 路径 |
| `businessApiUrl` | string | 是 | — | 业务 Resource Server 地址 |
| `businessApiAudience` | string | 否 | `urn:dshserver:business-api` | 交换后 Token 的目标资源 |
| `runtimeLeaseFile` | string | 是 | — | 当前独立 Runtime 的 `0600` 租约文件 |
| `scopes` | string[] | 否 | `[]` | Gateway 验证后写入的 Scope 上限 |
| `exposedTools` | string[] | 否 | `[]` | 当前 Agent Preset 可见的业务工具白名单 |
| `readScope` | `customers:read:self` \| `customers:read:team` | 是 | — | 当前角色的数据读取范围 |
| `requestTimeoutMs` | number | 否 | `15000` | 初始请求超时，范围 `1000`～`120000` |
| `writeOperationsEnabled` | boolean | 否 | `true` | 初始写操作总开关 |
| `minimumWriteReasonLength` | number | 否 | `2` | 初始最短变更原因字符数，范围 `2`～`200` |

连接地址、Audience、租约、Scope 和工具白名单属于部署或策略输入，不能由普通用户修改。

### 租户级设置（`src/connector-settings.ts`）

最后三项同时注册到 DSH 原生 Settings 的 `dshserver-integration` 命名空间。只有具备
`assistant:platform:write` 的平台管理员可以写入，保存后同租户的活动 Runtime 立即读取
新值，无需重启。

| 名称 | 类型 | 默认值 | 取值范围 |
|---|---|---|---|
| `requestTimeoutMs` | number | `15000` | `1000`～`120000` |
| `writeOperationsEnabled` | boolean | `true` | — |
| `minimumWriteReasonLength` | number | `2` | `2`～`200` |

`@dshserver/dsh-preferences` 通过 DSH 原生插件设置槽位渲染这张配置卡片。

完整配置说明见[配置参考](../../docs/configuration.md)。

## 内置示例工具

`src/customer-tools.ts` 是 CRM 示例目录，用于演示接入方式：

| 工具 | 类型 | 所需 Scope | 下游接口 |
|---|---|---|---|
| `business_list_customers` | 只读 | `readScope` | `GET /v1/customers` |
| `business_get_customer` | 只读 | `readScope` | `GET /v1/customers/:id` |
| `business_customer_overview` | 只读 | `customers:read:team` + `analytics:read` | `GET /v1/analytics/team-overview` |
| `business_update_customer` | 写操作 | `customers:write:team` | `PATCH /v1/customers/:id` |

参数、返回结构与错误码见[工具与 API 参考](../../docs/tools-and-api.md)。

## 新增业务工具

1. 在 `src/policy.ts` 登记工具名称、所需 Scope 与写操作标记。
2. 用 `businessTool()` 声明目录条目：严格的参数与输出 Schema、展示标题，以及把参数映射
   为一次下游请求的构建器。
3. 在 `src/index.ts` 的注册循环中加入新目录。
4. 在 Agent Preset 的 `exposedTools` 中开放该工具。

`businessTool()` 会自动按策略表申请 Token Exchange Scope、应用租户写开关、为写操作附加
幂等键、套用管理员配置的超时并渲染结果。详细步骤见
[集成指南](../../docs/integration.md#步骤-6把业务接口变成-agent-工具)与
[插件架构](../../docs/ARCHITECTURE.md)的扩展检查表。

## DSH 插件生态兼容

本插件没有包装或替换 DSH 的插件系统。它使用原生 Cordis `apply()`、Agent Preset、
`ctx.tools.register()`、`ctx.tools.guard()`、Tool Schema、取消信号和结果渲染。新增经
审核的 DSH Tool、Prompt、Context 或 MCP 插件仍由企业 Preset 组合；官方 `dsh-mcp-client`
继续负责 MCP 工具发现和调用。

管理员需要为新增工具声明 Scope 和数据出口策略。未知插件不会自动获得业务写入、Shell、
文件或任意网络权限；绕开 `ctx.tools` 直接产生副作用的宿主插件必须单独审核。

默认 Profile 使用 DSH 原生模型 Provider 和 Models 设置页；业务工具作为普通 Tool 挂载，
无需替换或包装模型。

## 同一仓库中的其他包

| 包 | 作用 |
|---|---|
| [`@dshserver/runtime-gateway`](../runtime-gateway) | 每用户独立 Runtime 生命周期与 DSH 管理接口锁定 |
| [`@dshserver/dsh-preferences`](../dsh-preferences) | 浏览器侧个人偏好与连接器设置卡片 |
| [`config/`](../../config) | 部署方维护的企业 Profile 与 Agent Preset |

各部分都只依赖稳定协议与 DeepSeek Harness 原生扩展点，不依赖任何演示账号、内存策略或
示例业务数据。想在本机看到完整链路，运行仓库根目录的 `pnpm example`。

模块职责、配置所有权和新增连接器检查项见[插件架构](../../docs/ARCHITECTURE.md)。

本包采用 [MIT License](LICENSE)。
