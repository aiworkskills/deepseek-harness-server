/**
 * 浏览器半边真的把座位占上了吗。
 *
 * `slots.spec.ts` 测的是「该不该占」——`hasMark()` 这一族纯函数。那一层一直是对的，
 * 而这个插件仍然从未画出过任何东西：它的 `apply` 声明了一个 `config` 参数，可 cordis
 * 只把 Profile 配置交给 Host 半边，浏览器 bundle 由 `window.__ModuleLoader__` 加载，
 * 两边不共享配置树。于是 client 每次拿到的都是默认值 `{}`，`hasMark({})` 为假，一个
 * 座位都不占——**而这正是「部署方什么都没给」的正确行为**，所以它一声不响。
 *
 * 判定逻辑测了、占座位没测，缺口就在这两者之间。这个文件盯着那道缝。
 */
import { describe, expect, it, vi } from 'vitest'

import { apply } from '../src/client.js'
import { BRAND_ROUTE, type BrandConfig } from '../src/contract.js'

interface Claimed {
  readonly slots: string[]
  readonly dispose: () => void
}

/**
 * driving `apply` with a fake ClientContext and a fake Host route.
 * @param served - what the config route answers, or null to make it 404.
 * @returns which slots got claimed, once the pending fetch settles.
 */
async function run(served: BrandConfig | null): Promise<Claimed> {
  const slots: string[] = []
  const disposers: (() => void)[] = []
  let teardown: () => void = () => {}

  const ctx = {
    slots: {
      inject: (name: string, body: () => unknown) => {
        slots.push(name)
        body()
        const off = (): void => {}
        disposers.push(off)
        return off
      },
      register: () => () => {},
    },
    effect: (body: () => () => void) => { teardown = body() },
  } as unknown as Parameters<typeof apply>[0]

  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    expect(input).toBe(BRAND_ROUTE)
    return served === null
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => served }
  }))

  apply(ctx)
  // Let the microtask queue drain the fetch chain before asserting.
  await vi.waitFor(() => { if (fetchCalled() === 0) throw new Error('not yet') })
  await Promise.resolve()
  await Promise.resolve()
  return { slots, dispose: teardown }
}

function fetchCalled(): number {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
}

describe('the browser half claims seats from what the Host serves', () => {
  it('claims the mark seat for artwork that arrived over the route', async () => {
    // 这一条如果只靠 config 参数就永远失败：apply(ctx) 拿不到任何 Profile 配置。
    const { slots } = await run({ markSvg: '<svg/>', markOnly: true })
    expect(slots).toContain('sidebar.brand.mark')
  })

  it('leaves the text seats to the embedding plugin under markOnly', async () => {
    const { slots } = await run({ markSvg: '<svg/>', markOnly: true, markAlt: '某某助手' })
    expect(slots).toEqual(['sidebar.brand.mark'])
  })

  it('claims all three when the deployment runs standalone', async () => {
    const { slots } = await run({ markSvg: '<svg/>', name: 'Acme', headline: '你好' })
    expect(slots).toEqual([
      'sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark',
    ])
  })

  it('takes nothing when the Host half is not composed', async () => {
    // 路由不在 = 部署方没配品牌。DSH 自己的兜底该原样留着。
    const { slots } = await run(null)
    expect(slots).toEqual([])
  })

  it('takes nothing when the deployment supplied an empty brand', async () => {
    const { slots } = await run({})
    expect(slots).toEqual([])
  })

  it('releases every seat it took when the plugin unloads', async () => {
    const { slots, dispose } = await run({ markSvg: '<svg/>', name: 'Acme', headline: '你好' })
    expect(slots).toHaveLength(3)
    expect(() => { dispose() }).not.toThrow()
  })
})
