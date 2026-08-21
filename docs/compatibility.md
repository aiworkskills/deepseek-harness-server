# 兼容性

本文帮你确定该用哪个 DeepSeek Harness 版本，以及升级时会遇到什么。

## 支持矩阵

| 本仓库版本 | 验证过的 DSH 版本 | Cordis | Node |
|---|---|---|---|
| `0.1.0` | `0.1.0-rc.8` | `4.0.1` | `>=22.19.0` |

「验证过」的含义是：这些版本上 `pnpm check` 与 `pnpm example` 全部通过。其他版本可能可用，
但没有被验证。

## DSH 仍在预发布，请精确锁定版本

DeepSeek Harness 的 `@deepseek-ai/*` 包目前只发布预发布版本，而且 npm 的 `latest` 标签
落后于 `next`：

```
@deepseek-ai/dsh-tools    latest = 0.0.1-rc.1    next = 0.1.1-rc.1
```

本仓库的 `peerDependencies` 声明为 `>=0.1.0-rc.6 <0.2.0`。按 semver 的预发布规则，
**预发布版本只有在与某个比较符的 `主.次.修订` 完全相同时才算满足区间**，因此：

| 版本 | 是否满足 `>=0.1.0-rc.6 <0.2.0` |
|---|---|
| `0.1.0-rc.8` | 是 |
| `0.1.0` | 是 |
| `0.1.1-rc.1` | **否**（`0.1.1` 这个三元组上没有预发布比较符） |
| `0.0.1-rc.1` | 否 |

也就是说，直接 `pnpm add @deepseek-ai/dsh-tools` 装到的 `latest`（`0.0.1-rc.1`）和
`next`（`0.1.1-rc.1`）**都不满足** peer 区间。请显式安装验证过的版本：

```bash
pnpm add -D @deepseek-ai/dsh-tools@0.1.0-rc.8 @deepseek-ai/dsh-settings@0.1.0-rc.8 @deepseek-ai/cordis@4.0.1 @deepseek-ai/schemastery@3.18.1
```

如果你的宿主应用确实需要跑在 `0.1.1-rc.x` 上，可以在项目 `.npmrc` 中打开
`include-prerelease`，或在宿主里用 `pnpm.overrides` 统一钉住一个版本——但请先自行验证，
本仓库尚未在该版本上跑过验收。

DSH 发布 `0.1.0` 正式版后，本文会更新为区间安装，并去掉这一节。

## 升级流程

1. 在 `packages/*/package.json` 的 `devDependencies` 中把 `@deepseek-ai/*` 提到新版本。
2. `pnpm install && pnpm check`。
3. `pnpm example` —— 这一步会真实跑通守卫、Token Exchange 与业务调用，比类型检查更能
   发现运行期契约变化。
4. 更新本文的支持矩阵和 `peerDependencies` 区间。
5. 在 `CHANGELOG.md` 记录支持版本的变化。

## 本仓库的版本策略

- 三个公开包**锁步发版**，共用同一个版本号和同一个 `vX.Y.Z` 标签。
- `0.x` 阶段，次版本号（`0.Y.0`）可能包含不兼容修改，修订号只含修复。
- 支持的 DSH 版本发生变化时，至少提升次版本号。
