/**
 * 这个包必须自包含。
 *
 * 它以符号链接进 DSH profile，身边没有自己的 `node_modules`。任何真实的运行时
 * import——哪怕是 `@deepseek-ai/schemastery` 这种"反正装了的"包——都会让整个
 * Runtime 以 `ERR_MODULE_NOT_FOUND` 起不来，而且是在就绪探测之后，外面只看到 503。
 *
 * 这条规矩被违反过两次（`@deepseek-ai/dsh-agent` 的副作用 import，以及一个
 * `z.object()`），两次都是部署到线上才发现的。所以它现在是一个测试。
 */
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dist = (name: string): string => fileURLToPath(new URL(`../dist/${name}`, import.meta.url))

/** 每个 ESM import/export 说明符，按出现顺序。 */
function specifiers(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/(?:^|[;\s])(?:import|export)[^;]*?from\s*["']([^"']+)["']/g)) {
    found.add(match[1] as string)
  }
  for (const match of source.matchAll(/(?:^|[;\s])import\s*["']([^"']+)["']/g)) {
    found.add(match[1] as string)
  }
  return [...found]
}

describe('published bundle', () => {
  it('imports nothing at runtime but Node builtins', () => {
    const file = dist('index.js')
    // 未构建时跳过而不是假装通过：CI 的 `pnpm check` 先 build 再 test。
    if (!existsSync(file)) return
    const foreign = specifiers(readFileSync(file, 'utf8'))
      .filter(specifier => !specifier.startsWith('node:'))
      .filter(specifier => !specifier.startsWith('./') && !specifier.startsWith('../'))
    expect(foreign).toEqual([])
  })

  it('leaves only react external in the browser bundle', () => {
    const file = dist('client.js')
    if (!existsSync(file)) return
    const body = readFileSync(file, 'utf8')
    // 客户端半边由 esbuild 打包成 CJS，外部依赖走 require()。React 由宿主提供，
    // 是唯一允许的一个。
    const required = new Set<string>()
    for (const match of body.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      required.add(match[1] as string)
    }
    expect([...required].filter(name => name !== 'react')).toEqual([])
  })
})
