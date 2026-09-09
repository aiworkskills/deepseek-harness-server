# AGENTS.md

`@dshserver/*` —— 把 DeepSeek Harness 接进企业业务系统的连接器。四个 Runtime 插件
（OAuth 授权守卫、浏览器偏好、产出文件、嵌入式外观）加两个网关包。改 `packages/`
之前读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，接新客户读
[docs/integration.md](docs/integration.md)。

**卡住时先看 [docs/FAILURE-MODES.md](docs/FAILURE-MODES.md)**——它按报错原文索引，
收录的都是静态检查发现不了、只在运行时炸的失败。

## 这个仓库是成本摊销点，不要 fork

多个客户项目共享这一份连接器。DSH 仍在预发布，升级一次的代价很实在（`0.1.1-rc.2` →
`0.1.5-alpha.1` 跨 2942 个提交、七个破坏性变更），**所有项目消费同一份包，这笔钱就只付
一次**；任何项目 fork 出去改自己的，这条升级跑步机就要各跑各的。

业务差异走注入，不走分叉：

- 业务工具 → `businessTool()` 目录 + 宿主自己的插件包
- 插件组合 → `RuntimeManagerOptions.runtimePlugins`
- 部署资产 → `pluginRoot` / `preferencesRoot` / `configRoot`
- 身份与策略 → `GatewayServer` 的 `authenticate` / `authorize` 回调

需要连接器改动才能支持的场景，**改在这里并发布**，不要在下游打补丁。

## 静态检查覆盖不到运行时链路

`pnpm check`、`pnpm release:check`、`pnpm example` 全绿**不代表能跑**。它们覆盖类型、
单元契约和业务守卫，不覆盖「Runtime 真的起来、浏览器真的连上」这条链路。2026-09 的
0.1.5 升级里，七个 bug 在这三个命令全绿的状态下逐个只在真人打开浏览器时暴露。

所以任何触及以下位置的改动，**必须真起一次 Runtime 验收**，不能只跑静态检查：

- `runtime-gateway` 的 provision / backend / manager
- `gateway-server` 的代理与策略
- `config/dsh-profile/` 与 `config/agent-presets/`
- 升级 DSH 版本

## 看起来像约定、其实是安全属性

改动这些之前先读它们旁边的注释，那里写了为什么：

- **`blockedDshRpc` 的前缀必须是 `/api/<ns>/<method>` 形状。** 写错的前缀是一条永远为真、
  却永远不被命中的规则——被锁的管理能力实际全部敞开，而且没有任何报错。
  `gateway-policy.spec.ts` 有形状守卫，别绕过它。
- **`prepareSessionCreateBody` 认不出的信封必须抛错，不能原样放行。** 放行意味着受管
  工作区与 business Preset 的强制钉定静默失效，客户端就能自选。
- **租户配置目录对普通用户是只读挂载**（`backend-container.ts` 的 `Binds`）。这是把
  「普通用户不能改平台配置」从界面策略变成文件系统事实。需要写入时，分流写入路径，
  不要放开这个挂载。
- **浏览器半边运行时只能 import React。** 插件以符号链接进 profile，身边没有自己的
  `node_modules`，任何别的运行时 import 都会让整个 Runtime 起不来。
  `dsh-deliverables/tests/bundle.spec.ts` 守着这条线，它已经被破过两次。
- **产物路由的收敛在 realpath 之后比较。** 逃逸等于跨租户读取。

## 命令

```bash
pnpm check          # build + typecheck + test，全部 6 个包
pnpm example        # 无需 Harness 与模型凭据的端到端契约检查
pnpm release:check  # 发布边界：包内容、锁步版本、密钥扫描、compatibility 记录
```

`pnpm check` 先构建再类型检查——跨包类型检查需要被依赖方的构建产物。

## 升级 DSH

按 [docs/compatibility.md](docs/compatibility.md) 的升级流程走，八步都别跳。三条最容易
漏的：

1. **整个 workspace 一起抬**，分包渐进不可行（pnpm 求 peer 版本区间交集时会丢掉预发布
   标记，报错还指向别的包）。
2. **纯类型 peer 必须显式装进 devDependencies**，否则 `skipLibCheck` 吞掉未解析的 import，
   对应 API 静默退化成 `any`。验证办法是塞一个故意写错的调用，确认编译器真的报错。
3. **逐条比对 preset 与 profile 里每个插件的 config 键**。上游改 schema 零编译期信号，
   只在创建会话那一刻炸。

## 约定

- 注释解释**为什么**，不解释代码在做什么。约束、权衡、踩过的坑值得写；复述语法不值得。
- 每一条防御性代码都要说明它防的是什么，否则下一个人会把它当成多余的。
- 新增的不变量配一条会变红的测试。没有测试守着的不变量，等于没有。
- 测试断言必须打在**当前版本真实存在**的东西上。断言一条不存在的路径是永远为真的假绿灯，
  这个仓库出过两次。

## 编辑本文件

`CLAUDE.md` 是本文件的副本，两边要一起改。只写**非显然**的东西：能从代码直接读出来的
不要写进来，会过期的具体数值放进对应文档而不是这里。
