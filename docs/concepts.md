# 核心概念

本文帮你理解 DSH Server 的四个核心机制——OAuth 委托、Runtime 隔离、Agent Preset 与
Token Exchange——以及它们如何共同决定「这次调用能不能执行」。阅读本文后，[集成指南](integration.md)
中的每一步都会有明确含义。

## 术语表

全仓文档统一使用下列写法。协议术语保留英文并保持大小写一致。

| 术语 | 英文 / 标识 | 含义 |
|---|---|---|
| Runtime | Runtime | 一个用户独占的 DSH 进程，含独立 `DSH_HOME`、工作区与会话存储 |
| Runtime Gateway | Runtime Gateway | 部署侧网关：验证 Token、路由到用户 Runtime、锁定管理接口 |
| Runtime 租约 | Runtime Lease | Runtime Manager 写入 Runtime 文件系统的短期签名凭证，代表当前用户 |
| Token Exchange | RFC 8693 | 用 Runtime 租约换取面向具体业务 API 的降权 Access Token |
| Token Broker | Token Broker | 执行 Token Exchange 的内部服务，只能收缩 Scope，不能扩大 |
| Agent Preset | Agent Preset | 服务器维护的 Agent 配置：人设、插件与工具集合 |
| Scope | OAuth Scope | 授权粒度标识，如 `customers:read:team` |
| Issuer | `iss` | 签发这张 Token 的**身份系统**（不是人）。参与路由键，使换 IdP 后新旧身份不会互相覆盖 |
| Subject | `sub` | Token 代表的那一个身份。通常是人，服务账号同样成立 |
| Tenant | `tenant_id` | 共享管理员设置与凭据的**组织** |
| Workspace | `workspace_id` | 同一 Subject 名下彼此独立的工作集（项目、站点、托管账号）。**可选**，不给即一人一个工作区 |
| 业务 API | Resource Server | 既有业务接口，执行最终的对象级授权与审计 |
| 对象级授权 | object-level authorization | 针对具体一条业务记录的裁决，而非接口级放行 |
| 平台管理员 | `assistant:platform:write` | 可维护模型、凭据与租户级插件设置 |
| 业务管理员 | `assistant:policy:write` | 可调整角色与用户的 Agent 能力 |
| 普通用户 | — | 只能维护个人偏好，不能改变任何安全边界 |

## 概念一：OAuth 委托身份

DSH Server 不建设第二套身份系统。用户身份由既有 IAM 提供，并通过三段互不相同的
Token 传递到业务 API。**没有任何一段 Token 会进入模型上下文、工具参数或浏览器。**

```text
① Gateway Access Token   aud = urn:dshserver:runtime-gateway   30 分钟   BFF 持有
② Runtime 租约            aud = urn:dshserver:runtime-lease     5 分钟    Runtime 文件持有
③ Business Access Token  aud = urn:dshserver:business-api      2 分钟    单次调用持有
```

### Gateway Access Token

由既有 IAM 签发给 BFF，用于访问 Runtime Gateway。Gateway 必须完整校验签名算法、
`iss`、`aud`、`exp`、`typ`、`client_id` 与 Scope，并只从可信声明构造 Principal。

必需声明：

| 声明 | 类型 | 说明 |
|---|---|---|
| `sub` | string | 稳定企业用户标识，是 Runtime 路由键的组成部分 |
| `aud` | string | 必须等于 Gateway 的 Audience |
| `iss` | string | 授权服务器标识，参与 Runtime 路由键 |
| `exp` | number | 过期时间 |
| `jti` | string | Token 标识，用于审计关联 |
| `client_id` | string | 发起调用的客户端 |
| `name` | string | 展示名称 |
| `role` | string | 企业角色，用于映射 Agent Preset |
| `tenant_id` | string | 租户标识，参与 Runtime 路由键与设置共享 |
| `workspace_id` | string？ | **可选**。同一 Subject 名下的哪一个工作集。省略即一人一个工作区，路由键与不带此声明时完全一致 |
| `team_id` | string | 团队标识，业务 API 用于团队范围裁决 |
| `scope` | string | 空格分隔的 Scope 列表 |

```text
{
  "iss": "https://iam.example.com",
  "aud": "urn:dshserver:runtime-gateway",
  "sub": "usr-chen-mo",
  "client_id": "dshserver-business-demo",
  "tenant_id": "tenant-xx",
  "team_id": "team-east",
  "role": "manager",
  "scope": "assistant:use customers:read:team customers:write:team analytics:read"
}
```

### 身份不能成为模型参数

模型只提供业务查询条件（如关键词、客户编号、目标阶段）。Subject、Tenant、角色与
Token 全部来自受信任的运行时上下文：

```text
模型参数（业务输入）  +  受信任 Principal（身份）  →  业务 API 请求
```

任何要求用户或模型提供 `userId`、`tenantId` 或 Access Token 的设计都是错误的，因为
模型上下文可被提示注入影响。

### HTTP 与 WebSocket 使用同一套鉴权

DSH Web UI 使用两个 WebSocket 事件通道（`/api/events.mux` 与 `/api/events.host`）。连接
升级不是跳过鉴权的理由：Gateway 对 HTTP 与 WebSocket 执行完全相同的验证与路由策略。

## 概念二：Runtime 隔离

一个 Runtime 只服务一个已验证身份。

### 路由键与租户键

```text
runtimeKey = sha256(issuer \0 tenantId \0 subject [\0 workspaceId])[:20]
tenantKey  = sha256(issuer \0 tenantId)[:20]
```

`runtimeKey` 决定进程与私有目录；`tenantKey` 决定同租户共享的设置与凭据文件。
两者都只从**已验证声明**派生，浏览器传入的任何标识都不参与。

`workspaceId` 只在部署确实给了值时参与拼接。省略时结果与不存在这个维度时**完全一致**，
因此已有部署升级后目录不变、无需迁移。

多数部署一个 Subject 对应一个工作区，此时忽略这一维即可。当一个人名下有若干彼此独立
的工作集——项目、站点、代运营的账号——才需要它。**不要拿 `tenantId` 去承担这件事**：
`tenantId` 划分的是共享管理员配置的组织，挪作他用会在真出现组织概念时无维度可用。

派生结果会随 issuer 变化，因此正式部署用 `DSHSERVER_TENANT_KEY`（或 `RuntimeManagerOptions`
的 `tenantKey`）直接指定 `tenantKey`，让管理员配置在换域名或换 IdP 后仍然指向同一目录，
见[配置持久化](configuration.md#配置持久化)。

### 每个 Runtime 拥有的资源

| 资源 | 路径 | 隔离级别 |
|---|---|---|
下表的「每用户」在给了 `workspace_id` 的部署里读作「每工作区」——同一个人的两个工作区
各自拥有一份，互不可见。

| 资源 | 路径 | 隔离级别 |
|---|---|---|
| 进程 | 独立 Node 子进程，监听 `127.0.0.1` 随机端口 | 每用户 |
| `DSH_HOME` | `.runtime/users/<runtimeKey>/home` | 每用户 |
| 工作区 | `.runtime/users/<runtimeKey>/workspace` | 每用户 |
| Runtime 租约 | `.runtime/users/<runtimeKey>/runtime-lease.jwt`（`0600`） | 每用户 |
| Agent Preset | `<DSH_HOME>/.agent-presets/business` | 每用户，由服务器写入 |
| 企业 Profile | `<DSH_HOME>/profiles/web/cordis.patch.yml` | 每用户，由服务器写入 |
| 设置与凭据 | `.runtime/tenants/<tenantKey>/settings.yaml`、`.credentials.yaml` | 每租户共享 |

### 生命周期

1. **按需启动**：用户第一次打开助手时才创建 Runtime。
2. **就绪等待**：Gateway 轮询直到 DSH Web 服务可用，并创建唯一的受管工作区。
3. **租约续期**：租约有效期 5 分钟；剩余不足 60 秒时在下一次访问前原子替换文件。
4. **空闲回收**：默认空闲 15 分钟后回收进程，用户目录保留，下次访问自动恢复。
5. **策略指纹重启**：Preset 角色、Scope、工具集合、模型目录或管理能力发生变化时，
   指纹改变，Gateway 停止旧进程并用新策略重新启动，避免旧权限继续生效。

策略指纹的组成：

```text
policyFingerprint = sha256(presetRole \0 scopes \0 tools \0 models \0 canConfigureDsh)
```

## 概念三：Agent Preset

Agent Preset 是服务器维护的 Agent 配置，决定模型看到什么人设、加载哪些插件、可以
使用哪些工具。用户不能创建、编辑或切换 Preset：会话创建请求会被 Gateway 强制改写为
受管的 `business` Preset。

仓库内置三套 Preset（`config/agent-presets/`）：

| Preset | 对应角色 | `readScope` | 典型工具集合 |
|---|---|---|---|
| `employee` | 普通员工 | `customers:read:self` | 查询列表、读取详情 |
| `manager` | 团队管理者 | `customers:read:team` | 查询、详情、团队统计、更新阶段 |
| `auditor` | 只读审计员 | `customers:read:team` | 查询、详情、团队统计 |

每套 Preset 由两个文件构成：

- `preset.yml`：展示名称、描述与排序。
- `agent.cordis.yml`：加载的插件与配置。人设插件写明「不得索取 userId、tenantId 或
  访问令牌」，业务插件从环境变量读取部署输入。

Preset 中的 `readScope` 是**声明**，不是授权来源：真正能用的 Scope 仍取 Token 中已授予
Scope 与 Preset 声明的交集，最终对象可见性由业务 API 决定。

## 概念四：Token Exchange

业务工具不会把 Gateway Token 或 Runtime 租约直接发给业务 API。每次调用都用租约换取
一枚**只够本次使用**的降权 Token。

### 调用时序

```text
工具执行
  → 读取 runtime-lease.jwt（0600）
  → POST {brokerUrl}{tokenEndpointPath}
      grant_type            = urn:ietf:params:oauth:grant-type:token-exchange
      subject_token         = <Runtime 租约>
      subject_token_type    = urn:ietf:params:oauth:token-type:jwt
      requested_token_type  = urn:ietf:params:oauth:token-type:access_token
      resource              = <businessApiAudience>
      scope                 = <该工具在策略表中声明的 Scope>
  → Broker 校验租约签名、iss、aud、typ、exp，并确认请求 Scope ⊆ 租约 Scope
  → 返回 aud = business-api、有效期 120 秒的 Access Token
  → 携带该 Token 调用业务 API，写操作附带 idempotency-key
```

### 三条不变量

1. **只收缩不扩大**：Broker 拒绝任何超出租约 Scope 的请求。
2. **Scope 与守卫同源**：请求的 Scope 由 `packages/dsh-integration/src/policy.ts` 的策略表生成，与执行前
   守卫检查的 Scope 完全相同，不存在「检查一个、申请另一个」的可能。
3. **短生命周期**：业务 Token 只活 120 秒，且不写日志、不进事件流、不返回模型。

参数与错误码见[工具与 API 参考 · Token Exchange 接口](tools-and-api.md#token-exchange-接口)。

## 概念五：权限交集

一次业务调用必须同时通过下列全部约束，任何一层都只能收缩能力：

```text
部署审核工具集合
  ∩ 业务管理员策略
  ∩ OAuth 已授予 Scope
  ∩ Agent Preset 工具白名单
  ∩ 有效 Runtime 租约
  ∩ 业务 API 对象级授权
```

| 层级 | 由谁决定 | 检查位置 |
|---|---|---|
| 部署审核工具集合 | 部署运维 | 插件配置 `exposedTools` |
| 业务管理员策略 | `assistant:policy:write` | 既有策略控制面 |
| OAuth Scope | 既有 IAM | Gateway 验证后写入 Principal |
| Agent Preset | 部署方 | 会话创建时强制受管 Preset |
| Runtime 租约 | Runtime Gateway | 工具执行前检查存在性与过期 |
| 对象级授权 | 业务 API | 每条记录逐一裁决 |

### 有效工具集是怎么算出来的

以只读审计员为例：

1. 角色策略允许 `business_list_customers`、`business_get_customer`、
   `business_customer_overview`。
2. 用户级策略未额外关闭工具，集合不变。
3. 逐个工具校验所需 Scope：`business_update_customer` 需要 `customers:write:team`，
   该用户未获授予，因此**即使被写入白名单也不会进入有效工具集**。
4. 结果写入 Runtime 环境变量 `DSHSERVER_EXPOSED_TOOLS`，插件只注册集合内的工具。
5. 执行前守卫再次校验 Scope、租户写开关与租约有效性。

因此审计员的模型根本看不到写工具——这不是界面隐藏，而是工具集合本身不含它。

## 后续步骤

- 把这些机制落到自己的系统：[集成指南](integration.md)
- 查每一个配置项：[配置参考](configuration.md)
- 查工具与接口细节：[工具与 API 参考](tools-and-api.md)
- 查安全边界与锁定矩阵：[安全模型](security-model.md)
