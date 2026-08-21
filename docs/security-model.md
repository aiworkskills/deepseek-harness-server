# 安全说明

本文帮你完成 DSH Server 的安全评审：确认信任边界、逐层授权约束、普通用户锁定矩阵、
凭据处理规则，以及上线前的自查项。

漏洞报告流程见仓库根目录的 [SECURITY.md](../SECURITY.md)；本文描述的是设计级安全边界。

## 信任边界

```text
企业 IAM / BFF
  → Gateway Access Token（aud = urn:dshserver:runtime-gateway）
  → 独立 DSH Runtime + 短期 Runtime 租约（aud = urn:dshserver:runtime-lease）
  → OAuth Token Exchange
  → Business Access Token（aud = urn:dshserver:business-api）
  → 业务 API 对象级授权
```

浏览器只持有 HttpOnly 会话 Cookie。Gateway Access Token、Runtime 租约、Business Access
Token 与 Refresh Token 都**不进入** URL、模型上下文、工具参数、SessionEvent、Shell 环境
或工具结果。

| 凭据 | 持有者 | 有效期 | 存储位置 |
|---|---|---|---|
| 会话 Cookie | 浏览器 | 与 Refresh Token 同步 | HttpOnly、SameSite=Lax、HTTPS 下 Secure |
| Gateway Access Token | BFF 服务端 | 建议 ≤30 分钟 | 服务端会话存储 |
| Runtime 租约 | Runtime 文件系统 | 5 分钟 | `runtime-lease.jwt`，权限 `0600` |
| Business Access Token | 单次工具调用 | 120 秒 | 仅存在于进程内存 |
| 模型凭据 | DSH Credentials | 长期 | 租户目录 `.credentials.yaml`，只写不回读 |

## 纵深授权

一次业务调用必须同时满足：

```text
部署允许能力 ∩ 管理员策略 ∩ OAuth Scope ∩ Agent Preset ∩ 有效 Runtime 租约 ∩ 业务对象权限
```

| 检查点 | 位置 | 内容 |
|---|---|---|
| Token 验证 | Runtime Gateway | `typ`、RS256 签名、`iss`、`aud`、`exp`、`client_id` 与 `assistant:use` |
| 路由派生 | Runtime Gateway | 路由键只从验证后的 `issuer + tenant + subject` 派生 |
| 管理员策略 | 业务策略控制面 | 只能从审核工具集合中收缩，不能产生 Token 中不存在的 Scope |
| Preset 强制 | Runtime Gateway | 会话创建请求被改写为受管 `business` Preset |
| 执行前守卫 | 插件 `ctx.tools.guard()` | 每次执行检查 Scope、租户写开关与租约过期 |
| Token Exchange | Token Broker | 禁止扩大 Scope，签发不同 Audience 的短期 Token |
| 对象级授权 | 业务 API | 不信任资源 ID，按 Subject、Team、Scope 与对象属性最终裁决 |

工具获准调用某个接口，**不等于**获准读取该接口下的每一条记录。最终裁决必须留在业务
API。

## 普通用户锁定矩阵

| 能力 | UI | Gateway / API | Runtime / Profile |
|---|---|---|---|
| 插件与 Cordis 管理 | 移除 | 拒绝 | Host runner / inventory 禁用 |
| Credentials / Provider | 普通用户移除，平台管理员保留 | 要求 `assistant:platform:write` | 同租户共享 DSH Settings / Credentials |
| 会话模型选择 | 保留 | 原生模型目录可读 | 用户可在管理员发布的模型中选择 |
| Preset 创作与切换 | 移除 | 写入与选择均拒绝 | 会话强制 `business` |
| 任意目录与本地路径 | 不装载目录浏览 UI | 目录 RPC 拒绝 | 唯一受管工作区 |
| 工作区创建 / 删除 / 移动 | 无创建入口 | 变更 RPC 拒绝 | 由 Runtime Manager 启动时创建 |
| Shell / 文件系统 / 任意网络 | 不展示 | 无对应工具 | 不进入业务 Preset |
| 沙箱提权 | 不展示 | 无切换接口 | 固定 Read Only |
| 个人偏好 | 业务系统提供 | 只能按当前 Subject 读写允许字段 | 不影响 Runtime 权限 |
| 业务智能体策略 | 仅管理员展示 | 要求 `assistant:policy:write` 与策略版本 | 与 OAuth Scope 求交集后生成 Runtime 策略 |
| 业务页面送入话术 | 只写输入框，不自动发送 | 仅接受同源且来自嵌入方窗口的消息 | 走原生输入机的草稿写入路径 |

**只隐藏界面不是安全边界。** 上表中每一项高风险能力都至少还有 Gateway 或 Runtime 层的
独立约束，具体路径见[集成指南 · 确认锁定生效](integration.md#45-确认锁定生效)。

## 管理控制面

DSH 原生设置页只对带 `assistant:platform:write` 的账号装载，并由 Gateway 放行。允许的
方法包括脱敏配置读取、settings 写入、credentials 只写管理与模型发现；宿主文件打开、
动态 Cordis、插件安装与其他管理能力继续拒绝。

配置与凭据按 OAuth 租户共享：同租户 Runtime 读取同一份 `settings.yaml` 与
`.credentials.yaml`，跨进程加锁写入并热更新。普通用户的 Runtime 只消费更新后的模型
目录，不能读取配置面或凭据状态。

业务系统仍负责个人偏好与 Agent 策略：`assistant:policy:read` / `write` 控制业务策略，
`assistant:platform:read` 只允许读取平台摘要。这两个控制面不重复保存模型配置。

## 插件审核

标准 DSH 工具与 MCP 工具经过 `ctx.tools` 流水线，可以复用统一守卫。下列插件不能因为
「能加载」就视为安全，需要代码审计与独立运行策略：

- 直接访问宿主文件或网络；
- 监听事件后自行产生副作用；
- 注册全局后台任务；
- 动态执行代码；
- 绕过 `ctx.tools` 保存凭据。

第三方插件若注册了自己的设置命名空间，还必须显式加入
`DSHSERVER_EXPOSED_SETTINGS_NAMESPACES` 白名单，否则 DSH ApiProxy 返回
`settings-not-exposed`。插件不能自行扩大远程配置权限。

## 提示注入与工具组合

模型上下文可能包含来自业务数据的不可信内容。因此：

- 身份字段永远不来自模型输出；工具参数只承载业务输入。
- 工具的 Scope 由服务端策略表决定，模型无法请求「更大的权限」。
- 写工具要求显式变更原因，并写入业务审计，便于事后追溯。
- 拒绝原因不回传内部地址、Token 或堆栈，避免把内部拓扑喂给模型。
- 业务页面送入的话术落在输入框而不是模型：发送仍由用户按下，页面不能代替用户开口。

## 演示与生产差异

仓库内的账号选择页、OAuth 私钥、Client Secret、Session Store、业务数据与审计均为内存
演示实现。生产环境必须：

| 演示实现 | 生产要求 |
|---|---|
| 内存账号与固定演示密码 | 接入既有 IAM / BFF |
| 进程内生成的 RS256 密钥 | 正式密钥管理与轮换 |
| 内存 Session Store | 持久化会话存储 |
| 内存审计事件（保留 100 条） | 集中审计与长期留存 |
| 无限流 | 限流、WAF、告警与备份 |

`deploy/nginx/dshserver.cn.conf` 提供 TLS、请求限流与 WebSocket 代理示例，但不替代企业
边界防护。

## 上线前安全自查

- [ ] Gateway 对 HTTP 与两个 WebSocket 通道执行同一套鉴权。
- [ ] Runtime 内部端口只监听 `127.0.0.1`，公网无法直连。
- [ ] 两个用户产生不同的 Runtime 目录与进程。
- [ ] `runtime-lease.jwt` 权限为 `0600`，日志中检索不到 Token。
- [ ] 普通用户调用 settings、credentials、目录或工作区变更 API 返回 403。
- [ ] `settings.openDocument` 对所有角色均被拒绝。
- [ ] 非管理员无法读取角色策略；策略更新校验管理 Scope 与当前版本号。
- [ ] Token Broker 拒绝任何超出租约 Scope 的换票请求。
- [ ] 业务 API 对越权对象返回 403 / 404，而不是依赖前端隐藏。
- [ ] 写操作具备幂等键与业务审计记录。
- [ ] 跨源页面向嵌入助手发送的话术被忽略；同源送入的内容不会自动发送。
- [ ] 定期执行 `pnpm check && pnpm example`，并按[兼容性](compatibility.md)升级 Harness。

## 后续步骤

- 授权链路的机制解释：[核心概念](concepts.md)
- 逐步接入自己的系统：[集成指南](integration.md)
