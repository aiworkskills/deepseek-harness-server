# @dshserver/dsh-brand

独立打开的 Runtime，**顶上写谁的名字由 Profile 决定**。

## 解决什么

自建的 Runtime 左边栏写的是 `DSH Local Build <sha>`。这几乎从来不是部署方想要的——
它是 DSH 在没有官方构建标识时的兜底。

这不是把 DSH 撬开：DSH 自己的品牌就是一个可替换插件（`ui-brand-official`），
在非官方构建上它**什么都不注册**，槽位空着等人来填。本包就是来填的那个。

跟 [`@dshserver/dsh-embed-chrome`](../dsh-embed-chrome) 的分工不是「二选一」，是**按座位**分：

| 座位 | 嵌入插件 | 本插件 |
|---|---|---|
| `sidebar.brand.mark` | 从不占——它的协议里只有文字，没有图 | 给了 `markSvg`/`markUrl` 就占 |
| `sidebar.brand.name` | 嵌入时是工作区切换器 | 给了 `name` 且非 `markOnly` |
| `conversation.hero.brand.mark` | 承载页面给的大标题 | 给了 `headline` 且非 `markOnly` |

槽位是**遮蔽式**的：同一个格子只有优先序里第一个存活的条目会渲染，两个都在 `extension`
档，抢同一个格子就成了「按 Profile 顺序静默二选一」。所以嵌入形态下把本插件置成
`markOnly`——文字两个座位交出去，logo 留下。此时再设 `name` 或 `headline` 会在加载时
报错，**不是悄悄不生效**。

本仓库的 `config/dsh-profile/cordis.patch.yml` 已经这么接好了：配了
`DSHSERVER_EMBED_HOST_ORIGIN` 就自动 `markOnly`。

## 组进 profile

```yaml
- id: dshserver-brand
  name: '@dshserver/dsh-brand'
  config:
    name: 甲公司智能助理
    markSvg: |
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="…"/></svg>
    headline: 有什么可以帮你
```

每个字段都是可选的，**给了才占位**：

| 字段 | 作用 |
|---|---|
| `name` | 侧栏文字商标。留空则保留 DSH 自己那一行 |
| `markSvg` | 内联 SVG 源码。用 `fill="currentColor"` 可跟随明暗主题 |
| `markUrl` | 标记图片地址，在没有 `markSvg` 时使用；任意格式，但不跟随主题 |
| `markAlt` | 标记的无障碍名称，默认取 `name` |
| `headline` | 空会话的大标题，替换 DSH 自己那句（见下文「不干净的那一半」） |
| `markOnly` | 只占 logo 那一个座位，文字两个交给嵌入插件。默认关 |
| `hideEmptyWorkspaceActions` | 临时绕过，见下文。默认关 |

`markSvg` 的内容**不做净化**直接注入。它来自 Profile——只有运维写得了，不是用户输入。
要展示用户提供的图片，用 `markUrl`。

**标记要跟随明暗主题。** DSH 官方那枚鱼形标记自己就是 `fill="currentColor"`，说明这个
座位期望的是单色字形；硬编码颜色的 logo 在另一个主题下会消失（深绿躯干配深色侧栏 =
什么都看不见）。全彩商标和侧栏标记是同一个 logo 的两种正当呈现，别指望一份资产两处用。

写错的键会在 Runtime 加载时报错并点名，而不是安静地什么都不显示。校验刻意用普通代码
而非 schemastery：本包以符号链接进 Profile，身边没有 `node_modules`，任何真实的运行时
import 都会让 Runtime 以 `ERR_MODULE_NOT_FOUND` 起不来（隔壁包这么挂过一次）。
`tests/bundle.spec.ts` 盯着这条。

## 没东西可画就不注册

这条规则是本包的整个形状，不是洁癖。

`sidebar.brand.mark` 被 DSH 渲染在**折叠按钮内部**当静息状态，面板图标只在悬停时出现。
占下这个槽位却渲染 `null`，展开态看着没问题，折叠态就留下一个不悬停就看不见的控件；
而且槽位的 `fallback` 只在**无人注册**时生效，占着它连 DSH 自己的兜底也一起顶掉。

这个错误隔壁包犯过一次。所以这里每个槽位都由配置里真有内容才注册——
`hasMark()` / `hasName()` 就是这件事。

## `headline` 是不干净的那一半，写在明面上

DSH 把 hero 的**图标**开成了槽位，却把大标题和「预览版」徽章留在组件里当本地化字符串，
而它的本地化注册表**拒绝同一命名空间的第二个所有者**——覆盖 `hero.headline` 会直接抛错，
不会生效。

所以这里用支持的那一半做它能做的（图标槽位承载文案），剩下两个 span 用一条结构选择器
藏掉。规则挂在本包自己设的标记属性上，**绝不挂 DSH 哈希过的 CSS Module 类名**，
上游改样式不会悄悄失效；上游若重排 hero，选择器不再命中，DSH 原来的标题回来——
看得见、且无害，而不是一个空白的 hero。

不填 `headline` 就一条规则都不装。

## `hideEmptyWorkspaceActions` 是绕过，不是特性

不挂目录选择器的部署（网关拒绝 `workspace.create`），DSH 会正确地藏掉"添加工作区"
按钮，但装着它的 flex 容器仍然占位，折叠栏里留下一个空盒子。

打开这个开关会装一条 CSS，只在容器**确实为空**时藏掉它。选择器挂在 `data-slot` 属性上，
不挂 DSH 的内容哈希类名（`ELhcta_headerActions` 这种每次上游构建都可能变，写成那样会
在某次升级后静默失效）。**上游修好这个容器后，删掉这个开关和它装的 CSS。**
