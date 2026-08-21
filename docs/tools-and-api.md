# 工具与 API 参考

本文帮你查阅每个业务工具的模型参数、所需 Scope、下游请求与返回结构，Token
Exchange 与业务 API 的接口约定和错误码，以及业务页面把话术送进对话框的浏览器接口。

仓库内置的四个工具是 CRM 示例（[`packages/dsh-integration/src/customer-tools.ts`](../packages/dsh-integration/src/customer-tools.ts)），
用于演示接入方式。新增自己的工具见[集成指南](integration.md)。

本文描述的两个服务端接口（Token Exchange 与业务 API）由**集成方提供**，不在本仓库内。
仓库里的 [`examples/local-smoke`](../examples/local-smoke) 有一份可运行的最小实现，可以直接
拿来对照契约。

## 通用约定

- **模型参数只含业务输入**。Subject、Tenant、角色与 Token 由受信任的运行时上下文注入，
  永远不是工具参数。
- **每次调用独立换票**。工具执行时用 Runtime 租约换取有效期 120 秒的降权业务 Token。
- **申请的 Scope 等于检查的 Scope**。两者都来自 [`packages/dsh-integration/src/policy.ts`](../packages/dsh-integration/src/policy.ts) 的策略表。
- **写操作自动附带幂等键**。使用 DSH 提供的 `callId` 作为 `idempotency-key`。
- **单次调用超时上限 120 秒**。管理员配置的 `requestTimeoutMs` 只能在上限内生效。
- **错误信息不含敏感数据**。返回给模型的消息不包含 Token、内部地址或堆栈。

## 工具总览

| 工具 | 类型 | 所需 Scope | 下游接口 |
|---|---|---|---|
| [`business_list_customers`](#business_list_customers) | 只读 | `readScope` | `GET /v1/customers` |
| [`business_get_customer`](#business_get_customer) | 只读 | `readScope` | `GET /v1/customers/:id` |
| [`business_customer_overview`](#business_customer_overview) | 只读 | `customers:read:team` + `analytics:read` | `GET /v1/analytics/team-overview` |
| [`business_update_customer`](#business_update_customer) | 写操作 | `customers:write:team` | `PATCH /v1/customers/:id` |

`readScope` 是当前 Agent Preset 声明的读取范围：员工为 `customers:read:self`，管理者与
审计员为 `customers:read:team`。

---

### business_list_customers

查询当前登录用户有权查看的 CRM 客户。

**模型参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `stage` | string | 否 | 销售阶段：`潜在客户`、`需求确认`、`方案沟通`、`商务谈判`、`已成交` |
| `keyword` | string | 否 | 关键词，匹配客户名称、联系人、行业或备注 |

**授权**：`readScope`（`customers:read:self` 或 `customers:read:team`）

**下游请求**：`GET /v1/customers?stage=&keyword=`（无参数时不带查询串）

**返回结构**

| 字段 | 类型 | 说明 |
|---|---|---|
| `visibility` | `self` \| `team` | 本次结果的可见范围，由业务 API 依据 Token Scope 判定 |
| `total` | integer | 命中记录数 |
| `items` | array | 客户记录数组，字段见[客户记录](#客户记录结构) |

**示例响应**

```json
{
  "visibility": "team",
  "total": 2,
  "items": [
    {
      "id": "CUS-1011",
      "company": "青屿能源",
      "industry": "新能源",
      "contactName": "顾言",
      "contactTitle": "采购总监",
      "stage": "商务谈判",
      "level": "A",
      "ownerName": "陈默",
      "teamName": "华东销售一部",
      "expectedValue": 1250000,
      "nextFollowUp": "2026-08-21T07:00:00.000Z",
      "lastContactAt": "2026-08-20T01:05:00.000Z",
      "note": "法务条款全部对齐，只剩年度服务价格。"
    }
  ]
}
```

---

### business_get_customer

读取一位 CRM 客户的详情。业务 API 依据当前 Subject 执行客户级授权。

**模型参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `customer_id` | string | 是 | 客户编号，例如 `CUS-1001` |

**授权**：`readScope`

**下游请求**：`GET /v1/customers/:id`

**返回结构**

| 字段 | 类型 | 说明 |
|---|---|---|
| `record` | object | 单条客户记录，字段见[客户记录](#客户记录结构) |

**常见错误**

| 情况 | 业务 API 响应 | 模型看到的结果 |
|---|---|---|
| 记录不存在或无权访问 | `404 not_found` | 记录不存在，或当前用户无权访问该对象 |

同一个响应同时覆盖「不存在」与「无权访问」，避免通过错误码探测他人数据是否存在。

---

### business_customer_overview

读取当前登录管理者所在团队的客户与销售管道概览。

**模型参数**：无

**授权**：同时需要 `customers:read:team` 与 `analytics:read`

**下游请求**：`GET /v1/analytics/team-overview`

**返回结构**

| 字段 | 类型 | 说明 |
|---|---|---|
| `teamName` | string | 团队名称 |
| `total` | integer | 团队客户总数 |
| `pipelineValue` | number | 未成交客户的预期金额合计 |
| `highValue` | integer | 高价值客户数量 |
| `followUpDue` | integer | 近期需要跟进的客户数量 |
| `byStage` | array | 各销售阶段的客户数量，元素为 `{ stage, count }` |

---

### business_update_customer

更新当前团队内一位客户的销售阶段。业务 API 执行最终的客户级授权与审计。

**模型参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `customer_id` | string | 是 | 客户编号，例如 `CUS-1001` |
| `stage` | string | 是 | 目标阶段，枚举：`潜在客户`、`需求确认`、`方案沟通`、`商务谈判`、`已成交` |
| `reason` | string | 是 | 变更原因，写入业务审计记录 |

**授权**：`customers:write:team`

**下游请求**：`PATCH /v1/customers/:id`，请求体 `{ "stage": "...", "reason": "..." }`，
请求头包含 `idempotency-key`

**返回结构**

| 字段 | 类型 | 说明 |
|---|---|---|
| `changeId` | string | 业务变更编号，可用于对账与审计 |
| `record` | object | 更新后的客户记录 |

**执行前的额外约束**

| 约束 | 来源 | 不满足时 |
|---|---|---|
| 租户写操作开关为开 | 租户级设置 `writeOperationsEnabled` | 拒绝执行，提示平台管理员已暂停写操作 |
| 变更原因长度达标 | 租户级设置 `minimumWriteReasonLength` | 拒绝执行，提示所需最少字符数 |
| 拥有写 Scope | 策略表 + 已授予 Scope | 工具不进入有效工具集，或守卫拒绝 |

---

### 客户记录结构

`items[]` 与 `record` 的字段一致。业务 API 不返回内部标识 `ownerId` 与 `teamId`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 客户编号 |
| `company` | string | 客户名称 |
| `industry` | string | 所属行业 |
| `contactName` | string | 联系人姓名 |
| `contactTitle` | string | 联系人职务 |
| `stage` | string | 销售阶段 |
| `level` | string | 客户等级 `A` / `B` / `C` |
| `ownerName` | string | 负责人姓名 |
| `teamName` | string | 所属团队 |
| `expectedValue` | number | 预期金额 |
| `nextFollowUp` | string | 下次跟进时间（ISO 8601） |
| `lastContactAt` | string | 最近联系时间（ISO 8601） |
| `note` | string | 业务备注 |

## Token Exchange 接口

插件在每次工具调用前访问该接口。**该接口由集成方实现**，路径由 `brokerUrl` +
`tokenEndpointPath` 决定，默认 `POST /internal/oauth/token`。
可运行的最小实现见 [`examples/local-smoke/smoke.mjs`](../examples/local-smoke/smoke.mjs)。

**请求**：`POST {brokerUrl}{tokenEndpointPath}`，
`Content-Type: application/x-www-form-urlencoded`

| 参数 | 必填 | 取值 |
|---|---|---|
| `grant_type` | 是 | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | 是 | 当前 Runtime 租约 |
| `subject_token_type` | 是 | `urn:ietf:params:oauth:token-type:jwt` |
| `requested_token_type` | 是 | `urn:ietf:params:oauth:token-type:access_token` |
| `resource` | 是 | 目标业务 Audience，等于 `businessApiAudience` |
| `scope` | 是 | 空格分隔，必须是租约 Scope 的子集 |

**成功响应**：`200`

```json
{
  "access_token": "<jwt>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 120,
  "scope": "customers:read:team"
}
```

**错误响应**

| 状态码 | `error` | 触发条件 |
|---|---|---|
| `400` | `invalid_request` | 三个 Token 类型参数中任意一个不匹配 |
| `403` | `invalid_scope` | 租约验证失败、`resource` 不被支持，或请求 Scope 超出租约 Scope |

签发的业务 Token 声明包含 `sub`、`tenant_id`、`team_id`、`scope` 与 `actor_runtime`，
Audience 为业务 API，有效期 120 秒。

## 业务 API 接口

**该接口由集成方的既有业务系统提供。** 示例工具约定了下面的路由形状；换成自己的业务
接口时，改写 [`customer-tools.ts`](../packages/dsh-integration/src/customer-tools.ts) 的
`request()` 即可，不需要改动授权链路。所有接口都要求
`Authorization: Bearer <business access token>`。

| 方法 | 路径 | 所需 Scope | 说明 |
|---|---|---|---|
| GET | `/v1/customers` | `customers:read:self` 或 `customers:read:team` | 查询授权范围内的客户 |
| GET | `/v1/customers/:id` | 同上 | 读取单个客户，执行对象级授权 |
| GET | `/v1/analytics/team-overview` | `customers:read:team` + `analytics:read` | 团队统计 |
| PATCH | `/v1/customers/:id` | `customers:write:team` | 更新销售阶段，支持幂等键 |

### 查询参数

`GET /v1/customers`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `stage` | string | 否 | 按销售阶段过滤 |
| `keyword` | string | 否 | 关键词模糊匹配 |

### 请求体

`PATCH /v1/customers/:id`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `stage` | string | 是 | 目标销售阶段，必须是枚举值之一 |
| `reason` | string | 是 | 变更原因，至少 2 个字符 |

| 请求头 | 必填 | 说明 |
|---|---|---|
| `idempotency-key` | 否（插件始终发送） | 相同键的重复请求返回首次结果，不产生第二次变更 |

### 错误响应格式

```json
{ "error": "forbidden", "message": "当前用户没有修改该业务对象的权限。" }
```

| 状态码 | `error` | 含义 |
|---|---|---|
| `400` | `invalid_request` | 参数缺失或不合法，例如阶段值非法、变更原因过短 |
| `401` | `invalid_token` | 缺少 Bearer Token，或 Token 无效、过期、Audience 不匹配 |
| `403` | `forbidden` | 通过了接口级校验，但对象级授权拒绝 |
| `404` | `not_found` | 记录不存在，或当前用户无权访问该对象 |

## 对话框话术接口

业务页面把一段准备好的话送进嵌入助手的输入框时使用的浏览器接口，由
`@dshserver/dsh-preferences` 实现（[`packages/dsh-preferences/src/composer-bridge.ts`](../packages/dsh-preferences/src/composer-bridge.ts)）。
它与上面两个接口不同：不经过服务端，不携带 Token，只在同一个浏览器页面内传递一段文本。

**插件只写输入框草稿，不代替用户发送。** 话术进入模型之前必须由用户按下发送键。

**传输**：`targetWindow.postMessage(message, location.origin)`，其中 `targetWindow` 是嵌入
助手的 `iframe.contentWindow`（或 `window.open` 返回的窗口）。

### 请求消息

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channel` | string | 是 | 固定 `dshserver.composer`；其他值一律忽略且不回复 |
| `version` | number | 是 | 当前为 `1`；不匹配直接拒绝，不做兼容猜测 |
| `type` | string | 是 | `insert` 送入话术，`ping` 探测插件是否就绪 |
| `text` | string | `insert` 必填 | 话术正文，最长 4000 字符 |
| `mode` | string | 否 | `append`（默认）追加到用户已有草稿之后，`replace` 覆盖 |
| `requestId` | string | 否 | 最长 128 字符；同一 id 重发只插入一次，便于重试 |

```js
frame.contentWindow.postMessage({
  channel: 'dshserver.composer',
  version: 1,
  type: 'insert',
  requestId: crypto.randomUUID(),
  text: '查一下 CUS-1011 青屿能源的详情，它现在到哪个阶段了？',
  mode: 'append',
}, location.origin)
```

### 回复消息

插件向发送方回一条消息，`targetOrigin` 为当前源。

| 字段 | 类型 | 说明 |
|---|---|---|
| `channel` | string | `dshserver.composer` |
| `version` | number | `1` |
| `type` | string | `result` 是一次 `insert` 的结果，`ready` 表示插件已就绪 |
| `status` | string | 仅 `result`：`applied` / `pending` / `rejected` |
| `reason` | string | 仅 `status` 为 `rejected` 时出现 |
| `requestId` | string | 请求带了才回显 |

```json
{ "channel": "dshserver.composer", "version": 1, "type": "result", "status": "applied", "requestId": "..." }
```

| `status` | 含义 | 业务页面的处理 |
|---|---|---|
| `applied` | 已写入输入框草稿 | 提示用户确认后发送 |
| `pending` | 会话尚未就绪，已暂存；就绪后自动填入并再回一条 `applied` | 提示稍候 |
| `rejected` | 未写入，原因见 `reason` | 按下表处理 |

| `reason` | 触发条件 | 处理方式 |
|---|---|---|
| `unsupported-version` | `version` 不是 `1` | 升级发送方或插件 |
| `malformed` | 缺少 `text`，或 `mode` 不是 `append` / `replace` | 修正消息结构 |
| `empty-text` | 清洗后为空白 | 检查话术来源 |
| `text-too-long` | `text` 超过 4000 字符 | 由业务页面截断或改写 |
| `draft-too-long` | 与现有草稿合并后超过 8000 字符 | 提示用户先清空输入框 |
| `composer-busy` | 输入框正在提交上一条消息 | 稍后重试 |

`ping` 与插件激活都会得到 `{ "channel": "dshserver.composer", "version": 1, "type": "ready" }`；
插件激活时主动向 `parent` 与 `opener` 各发一条。收不到任何回复通常意味着插件尚未加载。

### 处理规则

- **同源且是嵌入方**：只接受 `event.origin` 等于当前源、且 `event.source` 是 `parent` 或
  `opener` 的消息。其他来源被静默忽略，不回复也不报错。
- **文本清洗**：剥离控制字符与 U+FFFC（DSH 输入框的引用占位符），`\r\n` 统一为 `\n`，
  首尾空白去掉。
- **追加不覆盖**：`append` 在用户已有草稿后另起一行，不会吃掉用户正在写的内容。
- **一条暂存**：会话未就绪时只保留最后一条话术，新的话术顶掉旧的。
- **幂等**：最近 16 个 `requestId` 会被记住，重发只回复不重复插入。

### 生产约束

- 业务页面与嵌入助手的页面必须同源，由集成方用统一域名或反向代理实现。
- 不要用 URL 查询参数传话术：业务内容会进入浏览器历史、Referer 与网关访问日志。
- 业务页面侧的发送代码见[集成指南 · 步骤 8](integration.md#步骤-8从业务页面把一段话送进对话框)。

## Gateway 与会话相关错误

Runtime Gateway 在代理 DSH 流量时可能返回：

| 状态码 | `error` | 含义 | 处理方式 |
|---|---|---|---|
| `401` | `authentication_required` | 未登录或会话已失效 | 重新登录业务系统 |
| `403` | `assistant_scope_required` | 缺少 `assistant:use`，或管理员停用了该角色的 Agent | 检查策略控制面与授予的 Scope |
| `403` | `managed_capability_locked` | 访问了被部署方锁定的 DSH 管理能力 | 属于预期行为，见[安全模型](security-model.md) |
| `502` | `runtime_unavailable` | Runtime 启动或代理失败 | 查看服务端日志与 Harness 构建产物 |
| `503` | `runtime_unavailable` | `DSH_RUNTIME_DISABLED=1` | 需要 Runtime 时移除该环境变量 |

## 工具执行前的拒绝原因

守卫拒绝时，模型收到的是可读原因而非异常堆栈：

| 消息 | 触发条件 |
|---|---|
| `当前 OAuth Scope 不允许调用 <tool>（缺少 <scopes>）。` | 已授予 Scope 不满足策略表要求 |
| `平台管理员已暂停写操作，当前不能调用 <tool>。` | 租户级 `writeOperationsEnabled` 为 `false` |
| `当前登录授权已过期，请刷新业务系统页面后重试。` | Runtime 租约已过期 |
| `当前运行环境没有有效的用户执行授权。` | 租约文件缺失、不可读或不是合法 JWT |
| `变更原因至少需要 <n> 个字符。` | 写工具的 `reason` 短于租户设置要求 |

下游异常会转换为面向模型的消息，例如 Token Broker 拒绝换票、业务 API 返回非 JSON 数据
或请求超时。这些消息同样不包含 Token、内部地址与堆栈。

## 后续步骤

- 新增自己的工具：[集成指南](integration.md)
- 调整超时与写开关：[配置参考 · 租户级设置](configuration.md#租户级设置)
- 从业务页面送入话术：[集成指南 · 步骤 8](integration.md#步骤-8从业务页面把一段话送进对话框)
- 审查授权链路：[安全模型](security-model.md)
- 在本机跑通全链路：[`examples/local-smoke`](../examples/local-smoke)
