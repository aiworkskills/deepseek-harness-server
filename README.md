# DeepSeek Harness Server

把原版 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 作为受管智能体
模块接入既有业务系统的树外扩展。不修改 Harness 源码，用 OAuth 委托身份、每用户独立
Runtime 和业务 API 对象级授权实现多用户共用。

一句话概括：**用户在自己的业务系统里使用 Agent，Agent 用用户自己的身份和权限访问业务
数据。**

> 本项目由 [aiworkskills](https://github.com/aiworkskills) 维护，是 DeepSeek Harness 的
> 第三方扩展，**与 DeepSeek 官方无关**，也未获得其背书。

## 三个包

| 包 | 加载平面 | 作用 |
|---|---|---|
| [`@dshserver/dsh-integration`](packages/dsh-integration) | DSH Runtime | OAuth 委托的业务工具与执行前授权守卫 |
| [`@dshserver/runtime-gateway`](packages/runtime-gateway) | 宿主应用 | 每用户独立 Runtime 生命周期与 DSH 管理接口锁定 |
| [`@dshserver/dsh-preferences`](packages/dsh-preferences) | 浏览器 | 个人偏好、连接器设置卡片、业务页面话术送入 |

外加 [`config/`](config)：部署方维护的企业 Profile 与三套 Agent Preset（员工、管理者、
审计员）。

## 60 秒看到它在做什么

只需要 Node.js `>=22.19` 和 pnpm 11，**不需要** Harness 源码、模型凭据或任何网络出口：

```bash
pnpm install --frozen-lockfile && pnpm example
```

这条命令会在本机拉起一个假的 Token Broker 和一个假的业务 API，写入一份真实格式的
Runtime 租约，然后用真插件跑五个场景：授权读取、缺少 Scope 被守卫拒绝、租户写开关关闭、
写入携带幂等键、租约过期后失败关闭。输出是逐条的 PASS/FAIL。

它证明的是本仓库负责的那段边界；完整产品形态（登录、嵌入 UI、业务系统）见
<https://dshserver.cn>。

## 它解决什么问题

在业务系统里嵌一个智能体，难的从来不是接模型，而是**让智能体的权限恰好等于当前用户的
权限**，而且这件事要在用户看不见的地方被强制执行。本仓库的做法：

- 模型参数**永远不含** `userId`、`tenantId`、角色或 Access Token。身份来自 Runtime
  Manager 写入的 `0600` 租约文件。
- 每次工具调用用租约换一张有效期 120 秒的降权业务 Token（RFC 8693 Token Exchange）。
- 申请的 Scope 恒等于守卫检查过的 Scope——两者从同一张策略表派生，不可能不一致。
- 最终的对象级授权由业务 Resource Server 执行，插件不直接连业务数据库。
- 平台管理员可以在不改 OAuth 的前提下一键停掉所有写操作。

## 文档

| 我想… | 文档 |
|---|---|
| 接入自己的业务系统 | [集成指南](docs/integration.md) |
| 理解 OAuth 委托、Runtime 隔离与 Token Exchange | [核心概念](docs/concepts.md) |
| 查配置项与默认值 | [配置参考](docs/configuration.md) |
| 查工具、接口与错误码 | [工具与 API 参考](docs/tools-and-api.md) |
| 了解模块划分与扩展检查表 | [插件架构](docs/ARCHITECTURE.md) |
| 做安全评审 | [安全模型](docs/security-model.md) |
| 确认支持的 DSH 版本 | [兼容性](docs/compatibility.md) |

## 安装

**DSH 目前只发布预发布版本，请精确锁定版本**——npm 的 `latest` 标签落后于 `next`，两者
都不满足本仓库的 peer 区间。详情与原因见[兼容性](docs/compatibility.md)。

```bash
pnpm add @dshserver/dsh-integration
pnpm add -D @deepseek-ai/dsh-tools@0.1.0-rc.8 @deepseek-ai/dsh-settings@0.1.0-rc.8 @deepseek-ai/cordis@4.0.1 @deepseek-ai/schemastery@3.18.1
```

在 Agent Preset 中加载：

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

内置的四个 CRM 工具是**示例**，用来演示接入方式。换成自己的业务接口见
[集成指南 · 步骤 6](docs/integration.md#步骤-6把业务接口变成-agent-工具)。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm check      # typecheck + test + build
pnpm example    # 端到端契约检查
```

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞报告见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)。
