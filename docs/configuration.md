# 配置参考

本文帮你查到本仓库三个包的每一个配置项：它属于哪一层、类型与默认值是什么、由谁修改、
何时生效。取值以当前代码为准。

宿主应用自身的配置（监听地址、公开域名、模型凭据等）不属于本仓库，由集成方的服务决定。

## 配置层级与所有权

配置分四层。**一个配置项只能属于一层**，混层是安全事故的常见来源。

| 层级 | 示例 | 由谁修改 | 生效方式 | 参考小节 |
|---|---|---|---|---|
| Gateway 选项 | Runtime 根目录、部署资产路径、空闲回收、租户目录名 | 部署运维 | 重启宿主应用 | [Runtime Gateway 选项](#runtime-gateway-选项) |
| 部署连接与授权上限 | Broker 地址、业务 API、Audience、租约路径、工具白名单 | 部署运维 / 策略控制面 | 重启 Runtime | [插件部署配置](#插件部署配置) |
| 租户行为 | 请求超时、写操作总开关、最短变更原因 | 平台管理员（`assistant:platform:write`） | 活动 Runtime 实时读取 | [租户级设置](#租户级设置) |
| 用户偏好 | 主题 | 当前用户 | 立即 | 浏览器本地 |

## Runtime Gateway 选项

`@dshserver/runtime-gateway` 的 `RuntimeManagerOptions`。多数场景直接使用
`defaultRuntimeOptions(projectRoot, publicOrigin, internalOrigin)`，需要时再覆盖字段。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `projectRoot` | string | 必填 | 宿主应用根目录，下面三项路径默认从它派生 |
| `dshSourceRoot` | string | `DSH_SOURCE_ROOT` 或 `<projectRoot>/../deepseek-harness` | 已构建的 Harness 目录 |
| `runtimeRoot` | string | `<projectRoot>/.runtime/users` | 每用户 Runtime 根目录 |
| `pluginRoot` | string | `<projectRoot>/plugin` | 已构建的 `@dshserver/dsh-integration` 包目录，会被链接进 Runtime 的 Profile |
| `preferencesRoot` | string | `<pluginRoot>/preferences` | 已构建的 `@dshserver/dsh-preferences` 包目录 |
| `configRoot` | string | `<pluginRoot>/config` | 部署方维护的 `agent-presets/` 与 `dsh-profile/` 所在目录 |
| `runtimePlugins` | array | 本仓库的 `dsh-integration` + `dsh-preferences` | 链接进每个 Runtime Profile 的插件包。给了值就**替换**默认两项 |
| `permissionMode` | `'read-only'` \| `'workspace-write'` | `'read-only'` | Runtime 沙箱的文件系统授权 |
| `extraEnv` | object | `{}` | 追加给 Runtime 子进程的环境变量，覆盖派生值 |
| `internalOrigin` | string | 等于 `publicOrigin` | Runtime 内部访问 Broker 与业务 API 的地址 |
| `publicHost` | string | 由 `publicOrigin` 解析 | 传给 DSH CLI 的 `--trusted-host` |
| `idleMs` | number | `DSH_RUNTIME_IDLE_MS` 或 `900000` | 空闲回收阈值 |
| `disabled` | boolean | `DSH_RUNTIME_DISABLED === '1'` | 关闭 Runtime 启动 |
| `tenantKey` | string | `DSHSERVER_TENANT_KEY`，留空则由 issuer 与 `tenant_id` 派生 | 固定租户配置目录名，只允许一段安全路径（`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`） |
| `log` | function | 写入 stdout | 接收租户配置诊断信息 |

`pluginRoot` / `preferencesRoot` / `configRoot` 的默认值描述的是参考部署的目录约定
（`<projectRoot>/plugin/...`）。本仓库把三个包放在 `packages/`、把部署资产放在根级
`config/`，宿主应用同理——目录结构不一样时直接指定这三项，不必复制出一个 `plugin/`：

```ts
const runtimes = new RuntimeManager(authority, {
  ...defaultRuntimeOptions(projectRoot, publicOrigin, internalOrigin),
  pluginRoot: join(projectRoot, 'node_modules', '@dshserver', 'dsh-integration'),
  preferencesRoot: join(projectRoot, 'node_modules', '@dshserver', 'dsh-preferences'),
  configRoot: join(projectRoot, 'dsh-config'),
})
```

### 换成自己的插件

`runtimePlugins` 的默认值是本仓库发布的那两个包。部署方要跑自己的 Agent 时，直接给出
自己的包列表——它替换默认值而不是追加，因为自带 Agent 的部署没有理由再带上本仓库的
业务连接器：

```ts
const runtimes = new RuntimeManager(authority, {
  ...defaultRuntimeOptions(projectRoot, publicOrigin, internalOrigin),
  runtimePlugins: [
    { packageName: '@acme/agent-tools', root: join(projectRoot, 'node_modules', '@acme', 'agent-tools') },
  ],
  configRoot: join(projectRoot, 'dsh-config'),
})
```

包会被链接到 Runtime Profile 的 `node_modules/<包名>` 下，Profile 才解析得到它；
实际加载由 `configRoot` 下 `dsh-profile/cordis.patch.yml` 的 `insert` 条目决定。
`artifacts` 列出启动前必须存在的文件（默认 `dist/index.js`），缺失时启动会直接失败，
而不是先起来、之后才发现插件加载不了。

### 沙箱授权

`permissionMode` 默认 `read-only`，适合"通过窄接口读写业务数据、本身不需要写文件"的
Agent。若 Agent 的产出**就是**文件（例如生成文档、代码或图片），改用 `workspace-write`：
它可以写自己的工作区，写不到别处。

选择更宽的授权时要清楚：约束就从"Agent 无法动手"变成了"进程与主机隔离"。这条路径要求
Runtime 主机本身是可牺牲的——不放数据库凭据、不放其他系统的密钥、对外无入站。

Gateway 直接读取的环境变量只有四个：`DSH_SOURCE_ROOT`、`DSH_RUNTIME_IDLE_MS`、
`DSH_RUNTIME_DISABLED`、`DSHSERVER_TENANT_KEY`。其余字段由调用方显式传入。

**正式部署应在首次启动前设置 `DSHSERVER_TENANT_KEY`。** 未设置时租户配置目录名由 OAuth
issuer 与 `tenant_id` 派生，之后换域名、换协议或换成客户自己的 IdP 都会指向一个新的空
目录，表现为管理员配置全部消失。Gateway 会在启动日志中打印当前租户目录，并在旧目录仍
有配置时列出它们，把 `DSHSERVER_TENANT_KEY` 设为旧目录名即可恢复。

固定行为（不可配置）：Runtime 监听 `127.0.0.1` 随机端口；启动就绪超时 45 秒；受管
工作区创建超时 10 秒；租约有效期 5 分钟，剩余不足 60 秒时续期；停止时先 `SIGTERM`，
5 秒后 `SIGKILL`。

## 插件部署配置

`@dshserver/dsh-integration` 的部署输入，定义在
[`packages/dsh-integration/src/config.ts`](../packages/dsh-integration/src/config.ts)，在 Agent Preset 的
`agent.cordis.yml` 中提供。这一层属于部署与策略控制面，**普通用户和模型都不能修改**。

| 名称 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `brokerUrl` | string | 是 | — | Token Broker 服务地址 |
| `tokenEndpointPath` | string | 否 | `/internal/oauth/token` | Broker 上的 Token Exchange 路径 |
| `businessApiUrl` | string | 是 | — | 业务 Resource Server 基础地址 |
| `businessApiAudience` | string | 否 | `urn:dshserver:business-api` | 交换后 Access Token 的目标资源 |
| `runtimeLeaseFile` | string | 是 | — | Runtime 租约文件路径，权限必须为 `0600` |
| `scopes` | string[] | 否 | `[]` | 已验证 Principal 的 Scope 上限，自动去重 |
| `exposedTools` | string[] | 否 | `[]` | 当前 Preset 可注册的工具白名单，自动去重 |
| `readScope` | `customers:read:self` \| `customers:read:team` | 是 | — | 当前角色的数据读取范围 |
| `requestTimeoutMs` | number | 否 | `15000` | 初始请求超时，范围 `1000`～`120000` |
| `writeOperationsEnabled` | boolean | 否 | `true` | 初始写操作总开关 |
| `minimumWriteReasonLength` | number | 否 | `2` | 初始最短变更原因字符数，范围 `2`～`200` |

最后三项只是**初始值**：平台管理员在 DSH 设置页保存新值后，活动 Runtime 立即使用新
配置，无需重启。见[租户级设置](#租户级设置)。

### 校验规则

- `brokerUrl`、`businessApiUrl`、`runtimeLeaseFile` 去除首尾空白后不得为空。
- `exposedTools` 中的每个名称必须存在于
  [`policy.ts`](../packages/dsh-integration/src/policy.ts) 的 `BUSINESS_TOOL_NAMES`。
- `requestTimeoutMs` 与 `minimumWriteReasonLength` 必须是范围内的整数。
- 任一校验失败时插件加载失败，Runtime 不会带着错误配置启动。

### 配置示例

```yaml
- id: dshserver-business
  name: '@dshserver/dsh-integration'
  config:
    brokerUrl: https://broker.internal.example.com
    tokenEndpointPath: /internal/oauth/token
    businessApiUrl: https://api.internal.example.com
    businessApiAudience: urn:example:crm-api
    runtimeLeaseFile: /run/secrets/runtime-lease.jwt
    scopes: [assistant:use, customers:read:team, customers:write:team]
    exposedTools: [business_list_customers, business_update_customer]
    readScope: customers:read:team
    requestTimeoutMs: 15000
```

可运行的对照实现见 [`examples/local-smoke`](../examples/local-smoke)：它用假的 Broker 和
假的业务 API 把上面这份配置真实跑一遍。

### 常见错误

| 错误信息 | 原因 | 处理方式 |
|---|---|---|
| `dshserver-integration: brokerUrl is required` | 值缺失或只有空白字符 | 检查环境变量是否注入成功 |
| `dshserver-integration: businessApiUrl is required` | 同上 | 同上 |
| `dshserver-integration: runtimeLeaseFile is required` | 同上 | 确认 Gateway 已注入租约路径 |
| `dshserver-integration: unknown exposed tool "..."` | 工具名不在策略表中 | 先在 `policy.ts` 登记工具 |
| `dshserver-integration: requestTimeoutMs must be an integer between 1000 and 120000` | 超时越界或非整数 | 修正取值 |
| `dshserver-integration: minimumWriteReasonLength must be an integer between 2 and 200` | 取值越界或非整数 | 修正取值 |

## 租户级设置

命名空间 `dshserver-integration`，定义在
[`connector-settings.ts`](../packages/dsh-integration/src/connector-settings.ts)，注册到 DSH
原生设置页。读写要求 `assistant:platform:write`；命名空间由 Host 平面的
`@dshserver/dsh-integration/settings` 在任何会话创建前安装，因此设置页不依赖用户是否
已挂载业务 Agent Preset。

| 名称 | 类型 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|---|
| `requestTimeoutMs` | number | `15000` | `1000`～`120000` | 业务 API 与 Token Exchange 的单次请求超时（毫秒） |
| `writeOperationsEnabled` | boolean | `true` | — | 租户级写操作总开关。关闭后即使用户拥有写 Scope，写工具也会被守卫拒绝 |
| `minimumWriteReasonLength` | number | `2` | `2`～`200` | 写工具要求模型提供的最短变更原因字符数 |

修改方式：用具备 `assistant:platform:write` 的账号打开 DSH 的「设置 → 插件 →
DSH Server 业务集成」。保存后同租户的活动 Runtime 立即读取新值。

关联行为：

- 单次工具调用的超时上限固定为 120 秒（`catalog.ts` 的 `TOOL_TIMEOUT_CEILING_MS`），
  管理员配置的超时只能在这个上限内生效。
- 写开关关闭时，模型收到的拒绝原因是「平台管理员已暂停写操作」，工具不会发出任何
  下游请求。
- 隐藏设置页面不是安全边界：Gateway 独立校验管理 Scope。

## Runtime 注入的环境变量

Runtime Gateway 为每个子进程生成下列环境变量
（[`runtime-provision.ts`](../packages/runtime-gateway/src/runtime-provision.ts)）。
它们**由身份和策略派生，不应手工设置**，此表仅供排查问题时对照。

| 名称 | 来源 | 说明 |
|---|---|---|
| `DSH_HOME` | Runtime 布局 | 用户私有的 DSH 主目录 |
| `DSH_TELEMETRY_DISABLED` | 固定 `1` | 关闭遥测 |
| `DSH_PERMISSION_MODE` | 固定 `read-only` | 沙箱权限模式 |
| `DSHSERVER_PRESET_ROOT` | Runtime 布局 | 受管 Agent Preset 根目录 |
| `DSHSERVER_RUNTIME_LEASE_FILE` | Runtime 布局 | 租约文件路径，供插件读取 |
| `DSHSERVER_INTERNAL_ORIGIN` | Gateway 选项 | Broker 与业务 API 的内部地址 |
| `DSHSERVER_SCOPES` | 已验证 Principal | 空格分隔的 Scope 上限 |
| `DSHSERVER_SETTINGS_ENABLED` | `canConfigureDsh` | `1` 时装载 DSH 原生配置页 |
| `DSHSERVER_SETTINGS_PATH` | 租户目录 | 同租户共享的 `settings.yaml` |
| `DSHSERVER_CREDENTIALS_PATH` | 租户目录 | 同租户共享的 `.credentials.yaml` |
| `DSHSERVER_EXPOSED_TOOLS` | 策略控制面 | 有效工具集合 JSON 数组 |
| `DSHSERVER_WORKSPACE_ROOT` | Runtime 布局 | 唯一受管工作区 |
| `DSHSERVER_MODEL_PROVIDER` / `_ID` / `_NAME` / `_API_KEY_ENV` / `_BASE_URL` | 部署批准的模型 | 默认模型与凭据来源 |

## 企业 Profile 补丁

[`config/dsh-profile/cordis.patch.yml`](../config/dsh-profile/cordis.patch.yml) 在官方
`dsh-base` 与 `dsh-web-app` 包之后应用，用于移除高风险宿主能力并固定受管行为。

补丁条目**每次 Runtime 启动都会重新应用，并覆盖管理员已保存的同名条目**。这对策略是
目的，对默认值则是缺陷，因此两类条目分成两个文件：

| 文件 | 应用时机 | 内容 |
|---|---|---|
| `cordis.patch.yml` | 每次启动 | 策略叠加层：禁用项、路径、沙箱与审批 |
| `model-seed.patch.yml` | 仅当 Profile 根 `cordis.yml` 还没有持久化条目时追加 | 部署默认模型（`agent-default-model` 与 `llm-deepseek` 的目录、凭据变量名） |

管理员在原生设置页保存任何插件配置后，DSH 会把合成后的条目列表写回 Profile 根，Gateway
随即停止追加种子文件，此后模型配置由管理员拥有，重启、空闲回收和升级都不再覆盖。

策略叠加层的条目：

| 条目 | 设置 | 目的 |
|---|---|---|
| `session-title-llm` | 禁用 | 避免额外的模型调用 |
| `llm-deepseek` / `llm-pi-ai` | 启用 | 保留官方 Provider，其模型目录归租户所有 |
| `settings` / `credentials` | `path` 指向租户目录 | 同租户共享配置与凭据 |
| `dshserver-integration-settings` | 插入 | 在 Host 平面安装租户设置命名空间 |
| `sandbox-policy` | `mode: read-only`，固定工作区根 | 禁止沙箱提权与越界写入 |
| `approval` | `policy: ask` | 高风险操作需要确认 |
| `directory-picker` | 禁用 | 移除宿主目录浏览界面 |
| `directory-picker-browse` | 插入 | `api-gateway` 启动时必须拿到该服务；它面向模型的 `host.*` RPC 由 Gateway 拒绝，因此属于内部依赖而非用户能力 |
| `plugin-inventory` / `cordis-host-runner` / `cordis-client-runner` | 禁用 | 禁止动态插件与宿主运行器 |
| `ui-settings-general` | 启用 | 保留外观等个人设置 |
| `ui-settings-models` / `ui-settings-plugins` | 仅 `DSHSERVER_SETTINGS_ENABLED=1` 时启用 | 平台配置页只对管理员装载 |
| `ui-settings-plugin-inventory` | 禁用 | 移除插件清单入口 |
| `dshserver-preferences` | 插入 | 浏览器侧偏好与连接器设置卡片 |
| `ui-agent-preset` / `ui-permission` / `ui-cordis` / `ui-skill` / `ui-subagent` / `ui-plan` / `ui-goal` / `ui-jobs` | 禁用 | 移除普通用户不应触及的界面 |
| `agent-presets` | `default: business`，`includeUserRoot: true` | 固定受管 Preset |

界面禁用只是第一层。对应的 RPC 由
[`gateway-policy.ts`](../packages/runtime-gateway/src/gateway-policy.ts) 的 `blockedDshRpc()`
在 Gateway 侧独立拒绝。

## 配置持久化

管理员配置全部落在 `runtimeRoot` 的同级目录下，DSH 升级、插件升级和重新预置都不会触碰：

| 位置 | 内容 | 谁拥有 |
|---|---|---|
| `.runtime/tenants/<tenantKey>/settings.yaml` | Provider 目录、默认模型、连接器策略等设置命名空间 | 管理员 |
| `.runtime/tenants/<tenantKey>/.credentials.yaml` | DSH Credentials 页写入的密钥 | 管理员 |
| `.runtime/users/<runtimeKey>/home` | 会话、工作区与个人偏好 | 用户 |
| `.runtime/users/<runtimeKey>/home/profiles/web` | Preset、Profile 补丁与 Profile 根 | 部署（每次启动重写补丁） |

两个配置平面的作用范围不同：**设置命名空间是租户级**，写入 `settings.yaml`，对同租户所有
用户立即生效；**插件配置是每用户 Profile 级**，写入该用户的 `cordis.yml`。因此面向全租户
发布模型时，应使用 Models 页的 Provider 机制，而不是逐个修改插件配置。

会让配置失效的两种操作：

- **改变身份输入**。`tenantKey` 默认由 OAuth issuer 与 Token 的 `tenant_id` 派生，切换
  域名、协议或换成客户自己的 IdP 都会指向一个新的空目录。设置 `DSHSERVER_TENANT_KEY`
  可以彻底避免；未设置时 Gateway 会在启动日志里打印当前租户目录，并在发现旧目录仍有
  配置时给出告警和迁移提示。
- **只把模型密钥放在环境变量里**。`apiKeyEnv` 保存的是变量名而不是密钥值。生产环境应由
  管理员在 DSH Credentials 页写入，密钥随运行数据一起备份。

[`runtime-persistence.spec.ts`](../packages/runtime-gateway/src/runtime-persistence.spec.ts)
把上述边界固定为回归测试：重新预置 Runtime 目录后，租户设置、凭据与用户状态必须逐字节
不变，策略叠加层必须被还原。

## Agent Preset 文件

每套 Preset 位于 [`config/agent-presets/<role>/`](../config/agent-presets)，包含两个文件：

| 文件 | 内容 |
|---|---|
| `preset.yml` | `name`（展示名称）、`description`（说明）、`order`（排序） |
| `agent.cordis.yml` | 插件列表与配置，通常包含 `@deepseek-ai/dsh-persona` 与 `@dshserver/dsh-integration` |

人设插件的常用配置：

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 系统人设。应明确禁止索取 `userId`、`tenantId` 或访问令牌 |
| `complete` | boolean | 是否替换默认人设 |
| `includeRuntimeContext` | boolean | 是否注入运行时上下文；受管场景设为 `false` |

Preset 目录由 Gateway 在每次 Runtime 启动时复制到用户的 `DSH_HOME`，用户无法修改。

## 后续步骤

- 工具与接口细节：[工具与 API 参考](tools-and-api.md)
- 模块划分与扩展检查表：[插件架构](ARCHITECTURE.md)
- 支持的 DSH 版本：[兼容性](compatibility.md)
