/**
 * Routing this type into the Sidebar rests on two decisions, and both are made
 * from the address string alone: which addresses it claims, and which session
 * workspace the claimed one names. Getting the second wrong serves one Subject's
 * file from another's URL, so the encoding cases are the point here, not padding.
 */
import { describe, expect, it } from 'vitest'

import { deliverableTabDefinition } from '../src/client.js'
import {
  DELIVERABLE_TAB_ID, DELIVERABLE_TAB_KIND, DELIVERABLE_TAB_PATTERNS, PREVIEWED_EXTENSIONS,
  contentTypeOf, deliverableKind, parseSessionFileAddress,
} from '../src/contract.js'

const address = (scope: string, rest: string): string => `dsh-resource://file/${scope}/${rest}`

describe('session file addresses', () => {
  it('reads the session id and the workspace-relative path', () => {
    expect(parseSessionFileAddress(address('session', 's1/drafts/article.html')))
      .toEqual({ sessionId: 's1', path: 'drafts/article.html' })
  })

  it('decodes each segment separately, so a name may carry a slash or a space', () => {
    expect(parseSessionFileAddress(address('session', 's1/q4%20report%2Ffinal.html')))
      .toEqual({ sessionId: 's1', path: 'q4 report/final.html' })
  })

  it('declines the absolute scope, which names no session workspace', () => {
    expect(parseSessionFileAddress(address('absolute', 'etc/passwd'))).toBeNull()
  })

  it('declines an address with no path behind the session id', () => {
    expect(parseSessionFileAddress(address('session', 's1'))).toBeNull()
    expect(parseSessionFileAddress(address('session', 's1/'))).toBeNull()
  })

  it('declines a malformed escape rather than throwing at a routing decision', () => {
    expect(parseSessionFileAddress(address('session', 's1/%E0%A4%A.html'))).toBeNull()
  })

  it('declines anything that is not a dsh-resource file address', () => {
    expect(parseSessionFileAddress('https://example.com/a.html')).toBeNull()
    expect(parseSessionFileAddress('dsh-resource://terminal/session/s1/a')).toBeNull()
    expect(parseSessionFileAddress('not a url')).toBeNull()
  })
})

describe('tab type definition', () => {
  const definition = deliverableTabDefinition()

  it('registers under this package name, in the extension band by default', () => {
    expect(definition.id).toBe(DELIVERABLE_TAB_ID)
    expect(definition.kind).toBe(DELIVERABLE_TAB_KIND)
    // Left unset on purpose: the registry's default for a type that names no
    // band is `extension`, which is what outranks the builtin text viewer.
    expect(definition.priority).toBeUndefined()
  })

  it('claims one glob per previewed extension and nothing else', () => {
    expect(definition.patterns).toEqual(DELIVERABLE_TAB_PATTERNS)
    expect(DELIVERABLE_TAB_PATTERNS).toHaveLength(PREVIEWED_EXTENSIONS.length)
    expect(DELIVERABLE_TAB_PATTERNS).toContain('*.html')
    expect(DELIVERABLE_TAB_PATTERNS).toContain('*.pdf')
  })

  it('leaves the kinds the builtin viewer reads better', () => {
    for (const extension of ['md', 'json', 'txt', 'ts', 'csv']) {
      expect(PREVIEWED_EXTENSIONS).not.toContain(extension)
    }
  })

  /**
   * 认领与渲染必须来自同一份清单。
   *
   * 曾经它们是三张手工维护的表（认领用的扩展名、`deliverableKind` 的种类表、
   * `contentTypeOf` 的类型表），改一处漏两处不会有任何测试变红：多出来的扩展名
   * 会被认领却渲染成下载卡片，少掉的会被内置文本预览开成乱码。
   */
  it('claims exactly what it can render, and can type every claim', () => {
    for (const extension of PREVIEWED_EXTENSIONS) {
      const path = `f.${extension}`
      // 认领的每一个都必须落进三种渲染方式之一，而不是"不认识"。
      expect(['html', 'image', 'binary']).toContain(deliverableKind(path))
      // 且都必须有真实的 content-type——回落到 octet-stream 说明表漏了。
      expect(contentTypeOf(path)).not.toBe('application/octet-stream')
    }
  })

  it('vetoes a matched glob whose address is not in a session workspace', () => {
    expect(definition.canOpen?.(address('session', 's1/a.html'))).toBe(true)
    expect(definition.canOpen?.(address('absolute', 'tmp/a.html'))).toBe(false)
  })

  it('titles a tab with the file basename, and falls back to the address', () => {
    expect(definition.title(address('session', 's1/drafts/article.html'))).toBe('article.html')
    expect(definition.title('https://example.com/a.html')).toBe('https://example.com/a.html')
  })
})
