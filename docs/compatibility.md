# 兼容性

本文帮你确定该用哪个 DeepSeek Harness 版本，以及升级时会遇到什么。

## 支持矩阵

| 本仓库版本 | 验证过的 DSH 版本 | Cordis | Node |
|---|---|---|---|
| 未发布（下次发版为 `0.2.0`） | `0.1.5-alpha.1` | `4.0.2` | `>=22.19.0` |
| `0.1.0` | `0.1.1-rc.2` | `4.0.1` | `>=22.19.0` |

第一行还没有对应的 npm 版本：六个公开包仍是 `0.1.0`，版本号按本文末尾的策略在发版时
统一提升。装它需要从源码构建，或者等 `0.2.0` 发出来。

「验证过」的含义是：这些版本上 `pnpm check` 与 `pnpm example` 全部通过。其他版本可能可用，
但没有被验证。

**当前钉住的是 `alpha` 而非 `rc`。** DSH 的 `0.1.3` 与 `0.1.4` 都没等到 rc 就被跳过，
所以「等这条线出 rc」不是一个可靠的计划。本仓库先在 alpha 上完成迁移——破坏性变更是
结构性的（拆包、API 改名、详情面板删除），alpha 到 rc 不会往回改——托管部署的镜像 pin
可以等这条线更稳再翻。

## DSH 仍在预发布，请精确锁定版本

DeepSeek Harness 的 `@deepseek-ai/*` 包目前只发布预发布版本，而且 npm 的 `latest` 标签
落后于 `next`：

```
@deepseek-ai/dsh-tools    latest = 0.0.1-rc.1    next = 0.1.2-rc.1    alpha = 0.1.5-alpha.1
```

本仓库的 `peerDependencies` 声明为 `>=0.1.5-alpha.1 <0.2.0`。按 semver 的预发布规则，
**预发布版本只有在与某个比较符的 `主.次.修订` 完全相同时才算满足区间**，因此：

| 版本 | 是否满足 `>=0.1.5-alpha.1 <0.2.0` |
|---|---|
| `0.1.5-alpha.1` | 是 |
| `0.1.5` | 是 |
| `0.1.6` | 是（正式版，不受预发布规则约束） |
| `0.1.2-rc.1` | **否**（`0.1.2` 这个三元组上没有预发布比较符） |
| `0.1.6-alpha.1` | **否**（同理，`0.1.6` 上也没有） |
| `0.0.1-rc.1` | 否 |

这条规则也是升级时最容易踩的坑：把验证版本提到 `0.1.5-alpha.1` 时，peer 区间的下界必须
一起抬到 `0.1.5-alpha.1`，只改 `devDependencies` 会让 pnpm 报 peer 不满足。

**同一个 workspace 里不能同时存在两条 DSH 线。** 分包渐进升级（先迁一个包、别的包留在旧版本）
不可行：pnpm 要为共享的 peer 求一个版本区间的交集，而求交会丢掉下界的预发布标记
（`^0.1.1-rc.2` ∩ `^0.1.5-alpha.1` 得到 `>=0.1.5 <0.2.0-0`），没有任何已发布版本能满足，
报出来的是 `ERR_PNPM_NO_MATCHING_VERSION`，且指向的包和真正冲突的那个对不上号。
升级要么整个 workspace 一起抬，要么不抬。

直接 `pnpm add @deepseek-ai/dsh-tools` 装到的 `latest`（`0.0.1-rc.1`）**不满足** peer 区间。
请显式安装验证过的版本：

```bash
pnpm add -D @deepseek-ai/dsh-tools@0.1.5-alpha.1 @deepseek-ai/dsh-settings@0.1.5-alpha.1 @deepseek-ai/cordis@4.0.2 @deepseek-ai/schemastery@3.18.2
```

如果你的宿主应用需要跑在别的 `0.1.x-rc.y` 上，可以在宿主里用 `pnpm.overrides` 统一钉住一个
版本——但请先自行验证，本仓库只在上表的版本上跑过验收。

DSH 发布 `0.1.0` 正式版后，本文会更新为区间安装，并去掉这一节。

## 升级流程

1. 在**所有** `packages/*/package.json` 的 `devDependencies` 中把 `@deepseek-ai/*` 提到新版本，
   并把 `peerDependencies` 区间的下界一起抬上去（原因见上一节）。分包做不通，同上一节。
2. 把 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 清空成 `[]` 再跑 install，
   让 pnpm 按新版本重写。手工维护这份清单漏掉一条，报错会指向别的包。
3. `pnpm install && pnpm check`。只被 `.d.ts` 间接引用的「纯类型 peer」（例如
   `@deepseek-ai/dsh-client-ui-slots`）必须显式装进 `devDependencies`：`skipLibCheck: true`
   会吞掉未解析的 import，对应 API 静默退化成 `any`，类型检查全绿但运行期出错。
   验证办法是往源码里塞一个**故意写错的**调用（非法设置命名空间、不存在的槽位名），
   确认编译器真的报错——不报错就说明类型已经退化了。
4. `pnpm example` —— 这一步会真实跑通守卫、Token Exchange 与业务调用，比类型检查更能
   发现运行期契约变化。
5. **逐条核对 `config/agent-presets/*/agent.cordis.yml` 里每个插件的 config 键。**
   上游改插件的 config schema 不会有任何编译或类型提示，Preset 挂不上时只在**创建会话**
   的那一刻炸，浏览器侧看到的是 `session create failed: agent-preset/invalid`。
   `0.1.1-rc.2` → `0.1.5-alpha.1` 就把 `dsh-persona` 的 `text` 改名成了 `prefix`
   （并新增可选的 `suffix`），三个 Preset 一起挂掉。机械比对办法：

   ```bash
   # 在 harness 检出里跑，逐个对比新旧两版的 Config 键
   for pair in "dsh-persona:preset/persona" "dsh-tool-bash:shell/tool-bash" …; do
     pkg=${pair%%:*}; dir=${pair#*:}
     old=$(git show <旧tag>:packages/$dir/src/index.ts | grep -A12 "export const Config" \
       | grep -oE "^  [a-zA-Z]+:" | tr -d " :" | sort | tr "\n" " ")
     new=$(grep -A12 "export const Config" packages/$dir/src/index.ts \
       | grep -oE "^  [a-zA-Z]+:" | tr -d " :" | sort | tr "\n" " ")
     [ "$old" != "$new" ] && echo "$pkg 变了: $old -> $new"
   done
   ```

   包被移出默认 bundle **不等于**包没了：`tool-str-replace-editor` 在 0.1.5 被移出
   bundle，但包仍在，Preset 显式引用它没有问题。要查的是 config 键，不是 bundle 成员。

6. 逐条核对 `config/dsh-profile/cordis.patch.yml`：官方 bundle 里**新增**的能力默认是开启的，
   而 overlay 从没对它们表过态。比对办法是从
   `packages/bundle/{base,web-app}/cordis.patch.yml` 里取 id 全集，与上一版做差集。
7. 更新本文的支持矩阵和 `peerDependencies` 区间。
8. 在 `CHANGELOG.md` 记录支持版本的变化。

## 本仓库的版本策略

- 六个公开包**锁步发版**，共用同一个版本号和同一个 `vX.Y.Z` 标签。
  （`check-release.mjs` 会强制这一点：版本号不一致直接 fail。）
- `0.x` 阶段，次版本号（`0.Y.0`）可能包含不兼容修改，修订号只含修复。
- 支持的 DSH 版本发生变化时，至少提升次版本号。所以升到 `0.1.5-alpha.1` 这一次，
  下次发版是 `0.2.0` 而不是 `0.1.1`。
