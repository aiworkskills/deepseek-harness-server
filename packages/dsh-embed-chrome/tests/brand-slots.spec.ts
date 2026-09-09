/**
 * 这个插件占哪些品牌槽位，是个有过错误答案的决定。
 *
 * 曾经它连 `sidebar.brand.mark` 一起占下并渲染 null。展开态看着对——宿主的文字已经
 * 承载了身份，DSH 的鱼标是多余的第二身份。折叠态是错的：DSH 把那个槽位渲染在折叠
 * 按钮**内部**当静息状态（面板图标只在悬停时出现），所以一个空占据者留下的是一个
 * 没有静息可见性的控件；而且槽位的 `fallback` 只在**无人注册**时生效，占着它等于连
 * DSH 自己的兜底也一起顶掉。
 *
 * 协议里没有图片字段（见 `ChromeState`），宿主页给不出标记，所以这个位置我们永远
 * 没有东西可画——占着它没有任何收益。要真正让嵌入方掌控它，得给 `ChromeState` 加
 * 字段，而不是占一个填不上的坑。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../src/client.ts', import.meta.url)), 'utf8')

/** `register({ name: '…' })` 的槽位名，即这个插件真正占下的位置。 */
function registeredSlots(text: string): string[] {
  return [...text.matchAll(/register\(\s*\{\s*name:\s*'([^']+)'/g)].map(match => match[1] as string)
}

describe('brand slot occupancy', () => {
  it('claims the brand line and the hero, and leaves the mark to DSH', () => {
    expect(new Set(registeredSlots(source)))
      .toEqual(new Set(['sidebar.brand.name', 'conversation.hero.brand.mark']))
  })

  it('never registers sidebar.brand.mark', () => {
    // 分开断言，因为这一条的失败原因和上一条不同：加回它不会有任何编译或运行时错误，
    // 只会让折叠栏的折叠按钮再次失去静息状态。
    expect(registeredSlots(source)).not.toContain('sidebar.brand.mark')
  })
})
