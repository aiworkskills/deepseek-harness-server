/**
 * 这个插件占哪些槽位，取决于部署给了什么——这条规则是它存在的一半理由。
 *
 * 反面教材就在隔壁：`dsh-embed-chrome` 曾经占下 `sidebar.brand.mark` 却渲染 null。
 * 展开态看着对，折叠态是错的——DSH 把那个槽位渲染在折叠按钮内部当静息状态，空占据者
 * 留下一个不悬停就看不见的控件；而且槽位的 fallback 只在无人注册时生效，占着它连
 * DSH 自己的兜底也一起顶掉。
 *
 * 所以「没东西可画就不注册」不是洁癖，是这个槽位的语义要求。
 */
import { describe, expect, it } from 'vitest'

import {
  assertBrandConfig, hasHeadline, hasMark, hasName, EMPTY_WORKSPACE_ACTIONS_CSS,
} from '../src/contract.js'
import { HERO_CSS, HERO_MARKER } from '../src/client/hero.js'

describe('what the deployment supplied decides which seats are taken', () => {
  it('takes no mark seat without artwork', () => {
    expect(hasMark({})).toBe(false)
    expect(hasMark({ name: 'Acme' })).toBe(false)
    // 空字符串是「没给」，不是「给了一个空的」——否则又变成占着位交白卷。
    expect(hasMark({ markSvg: '' })).toBe(false)
    expect(hasMark({ markUrl: '' })).toBe(false)
  })

  it('takes the mark seat for either artwork form', () => {
    expect(hasMark({ markSvg: '<svg/>' })).toBe(true)
    expect(hasMark({ markUrl: '/brand.png' })).toBe(true)
  })

  it('treats a blank wordmark as absent', () => {
    expect(hasName({})).toBe(false)
    expect(hasName({ name: '' })).toBe(false)
    expect(hasName({ name: 'Acme' })).toBe(true)
  })

  it('treats a blank headline as absent', () => {
    expect(hasHeadline({})).toBe(false)
    expect(hasHeadline({ headline: '' })).toBe(false)
    expect(hasHeadline({ headline: '有什么可以帮你' })).toBe(true)
  })
})

/**
 * 嵌入形态下的分工：`dsh-embed-chrome` 拿走文字两个座位（品牌行是工作区切换器，
 * hero 承载页面给的大标题），但它的协议里只有文字没有图，标记位它从不占——那一个
 * 正好留给这里。所以这不是「二选一」，是按座位分。
 */
describe('markOnly hands the text seats to the embedding plugin', () => {
  it('still takes the mark seat — that is the whole point', () => {
    expect(hasMark({ markOnly: true, markSvg: '<svg/>' })).toBe(true)
  })

  it('takes neither text seat, even if something slipped into the config', () => {
    // 走到这里说明校验被绕过了（比如直接调用 apply）。抢座位的后果是遮蔽：输的那个
    // 什么都不渲染、也不报错，所以这两个判定必须自己也守住。
    expect(hasName({ markOnly: true, name: 'Acme' })).toBe(false)
    expect(hasHeadline({ markOnly: true, headline: '有什么可以帮你' })).toBe(false)
  })
})

/**
 * 校验只能用普通代码做——这个包链接进 profile，身边没有 `node_modules`，
 * 一个 `z.object()` 就足以让 Runtime 以 `ERR_MODULE_NOT_FOUND` 起不来
 * （`dsh-embed-chrome` 已经这么挂过一次，见 `bundle.spec.ts`）。
 * 所以这些断言替代的是 schemastery 本来会做的事。
 */
describe('a mistyped profile fails at load, not silently', () => {
  it('accepts an empty config — the plugin is opt-in per field', () => {
    expect(() => { assertBrandConfig({}) }).not.toThrow()
  })

  it('accepts every documented key', () => {
    expect(() => {
      assertBrandConfig({
        name: 'Acme', markSvg: '<svg/>', markUrl: '/b.png', markAlt: 'Acme',
        headline: '有什么可以帮你', hideEmptyWorkspaceActions: true,
      })
    }).not.toThrow()
  })

  it('rejects an unknown key by name', () => {
    // 大小写写错的 `markSVG` 如果被忽略，部署方看到的是「配了 logo 但没显示」，
    // 而这个插件整个形状就是为了不产生「静默的空」。
    expect(() => { assertBrandConfig({ markSVG: '<svg/>' } as never) })
      .toThrow(/unknown config key markSVG/)
  })

  it('rejects a text seat that markOnly already gave away', () => {
    // 静默忽略等于部署方「配了名字但没显示」，静默遮蔽等于按 Profile 顺序抽签。
    // 两个都不行——已知座位被占就在加载时说出来。
    expect(() => { assertBrandConfig({ markOnly: true, name: 'Acme' }) })
      .toThrow(/name cannot be set with markOnly/)
    expect(() => { assertBrandConfig({ markOnly: true, headline: '有什么可以帮你' }) })
      .toThrow(/headline cannot be set with markOnly/)
    // 标记位不冲突，markOnly 下照常接受。
    expect(() => { assertBrandConfig({ markOnly: true, markSvg: '<svg/>', markAlt: 'Acme' }) })
      .not.toThrow()
  })

  it('rejects a wrong type by name', () => {
    expect(() => { assertBrandConfig({ name: 42 } as never) }).toThrow(/name must be a string/)
    expect(() => { assertBrandConfig({ hideEmptyWorkspaceActions: 'yes' } as never) })
      .toThrow(/hideEmptyWorkspaceActions must be a boolean/)
  })
})

/**
 * hero 的规则是拿 CSS 补 DSH 没开出来的那一半：大标题和「预览版」徽章是组件内的本地化
 * 字符串，本地化注册表又拒绝同一命名空间的第二个所有者。所以只能「文案塞进图标槽位 +
 * 把旁边两个藏掉」，而这些断言守的就是这套选择器里最容易写错的地方。
 */
describe('the hero headline rules', () => {
  it('scopes every rule by our own marker', () => {
    // 少了作用域，只组合这个插件却没给 headline 的部署会得到一个**空** hero——
    // 比原来那句 DSH 自己的标题糟得多。
    for (const rule of HERO_CSS.split('}').filter(part => part.trim() !== '')) {
      expect(rule).toContain('data-dshserver-brand-hero')
    }
  })

  it('reaches the marker as a descendant, not as a direct child', () => {
    // 上游给每个槽位渲染点套了 `<div data-slot=… style="display:contents">`，
    // 我们的元素因此是**孙子**。第一版写成 `:has(> [marker])`，静默地一条都不命中。
    expect(HERO_CSS).not.toMatch(/:has\(>\s*\[data-dshserver-brand-hero\]/)
    expect(HERO_CSS).toContain('[data-slot="conversation.hero.brand.mark"] [data-dshserver-brand-hero]')
  })

  it('re-sizes the row instead of only hiding siblings', () => {
    // 那一行是 `grid-template-columns: 34px auto auto`，第一格是给鱼形 logo 的。
    // 只藏兄弟节点的话，文字会溢出压在第二列上，而不是把它挤开。
    expect(HERO_CSS).toContain('grid-template-columns: auto')
  })

  it('uses a marker naming this plugin, so two brand plugins never hide each other', () => {
    expect(HERO_MARKER).toBe('data-dshserver-brand-hero')
    expect(HERO_MARKER).not.toBe('data-dsh-embed-chrome-hero')
  })
})

describe('the empty-workspace-actions workaround', () => {
  /**
   * 这条 CSS 的价值全在选择器的稳定性上。DSH 的类名是内容哈希
   * （`ELhcta_headerActions`），每次上游构建都可能变，而 `data-slot` 是公开契约。
   * 写成哈希类名的规则会在某次升级后**静默失效**，空盒子悄悄回来。
   */
  it('anchors on data-slot attributes, never on hashed class names', () => {
    expect(EMPTY_WORKSPACE_ACTIONS_CSS).toContain('[data-slot="sidebar.workspaces"]')
    expect(EMPTY_WORKSPACE_ACTIONS_CSS).toContain('[data-slot="sidebar.workspaces.directoryFlow"]')
    expect(EMPTY_WORKSPACE_ACTIONS_CSS).not.toMatch(/[A-Za-z0-9_-]{5,}_[a-zA-Z]+/)
  })

  it('hides the row itself, not a zero-sized child of it', () => {
    // 之前那版选的是 `> div:first-child:empty`——一个 0×0 的子元素，隐藏它什么也没改变。
    // 运维看得见的是那个 36×36 的行，折叠态下夹在新会话与搜索图标之间。
    expect(EMPTY_WORKSPACE_ACTIONS_CSS).not.toContain('first-child')
    expect(EMPTY_WORKSPACE_ACTIONS_CSS).toContain(':not(:has(> :not(:empty)))')
  })

  it('only hides the container while it is actually empty', () => {
    // 少了 :empty 就会连有按钮的部署一起藏掉——那些部署本来是好的。
    expect(EMPTY_WORKSPACE_ACTIONS_CSS).toContain(':empty')
  })
})
