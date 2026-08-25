import { describe, expect, it, vi } from 'vitest'

import { CHROME_MESSAGE_SOURCE, CHROME_PROTOCOL, parseChromeState, originOf } from '../src/contract.js'
import { openEmbedLink } from '../src/client/link.js'

const HOST = 'https://app.example.com'

/** A window stand-in with a distinct parent, recording what it posts. */
function fakeView(options: { framed: boolean }) {
  const listeners = new Set<(event: MessageEvent) => void>()
  const posted: { data: unknown; target: string }[] = []
  const view = {
    addEventListener: (_type: string, fn: (event: MessageEvent) => void) => { listeners.add(fn) },
    removeEventListener: (_type: string, fn: (event: MessageEvent) => void) => { listeners.delete(fn) },
  } as unknown as Window & { parent: Window }
  const parent = options.framed
    ? ({ postMessage: (data: unknown, target: string) => { posted.push({ data, target }) } } as unknown as Window)
    : view
  Object.defineProperty(view, 'parent', { value: parent, configurable: true })
  const deliver = (event: Partial<MessageEvent>): void => {
    for (const fn of [...listeners]) fn({ source: parent, origin: HOST, ...event } as MessageEvent)
  }
  return { view, parent, posted, deliver, listenerCount: () => listeners.size }
}

describe('embed link', () => {
  it('stays out of a standalone Runtime', () => {
    // Not framed: DSH's own chrome is the right chrome, and no listener should
    // exist to be talked to.
    const world = fakeView({ framed: false })
    expect(openEmbedLink({ hostOrigin: HOST, onState: () => undefined, view: world.view })).toBeNull()
    expect(world.listenerCount()).toBe(0)
  })

  it('stays out when no host origin is configured', () => {
    const world = fakeView({ framed: true })
    expect(openEmbedLink({ hostOrigin: '', onState: () => undefined, view: world.view })).toBeNull()
    expect(world.listenerCount()).toBe(0)
  })

  it('announces readiness to the configured origin, never to a wildcard', () => {
    const world = fakeView({ framed: true })
    openEmbedLink({ hostOrigin: HOST, onState: () => undefined, view: world.view })
    expect(world.posted).toHaveLength(1)
    // A '*' target would hand the workspace roster to whoever framed us.
    expect(world.posted[0]?.target).toBe(HOST)
    expect(world.posted[0]?.data).toMatchObject({ source: CHROME_MESSAGE_SOURCE, type: 'ready' })
  })

  it('accepts chrome from the configured parent', () => {
    const world = fakeView({ framed: true })
    const onState = vi.fn()
    openEmbedLink({ hostOrigin: HOST, onState, view: world.view })
    world.deliver({ data: { source: CHROME_MESSAGE_SOURCE, version: CHROME_PROTOCOL, type: 'chrome', brand: '甲' } })
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ brand: '甲' }))
  })

  it('refuses another origin', () => {
    const world = fakeView({ framed: true })
    const onState = vi.fn()
    openEmbedLink({ hostOrigin: HOST, onState, view: world.view })
    world.deliver({
      origin: 'https://evil.example.com',
      data: { source: CHROME_MESSAGE_SOURCE, version: CHROME_PROTOCOL, type: 'chrome', brand: '乙' },
    })
    expect(onState).not.toHaveBeenCalled()
  })

  it('refuses another window on the right origin', () => {
    // Origin alone is not enough: a popup the user was navigated to shares the
    // deployment's origin and could otherwise dress this Runtime.
    const world = fakeView({ framed: true })
    const onState = vi.fn()
    openEmbedLink({ hostOrigin: HOST, onState, view: world.view })
    world.deliver({ source: {} as Window, data: { source: CHROME_MESSAGE_SOURCE, version: CHROME_PROTOCOL, type: 'chrome', brand: '丙' } })
    expect(onState).not.toHaveBeenCalled()
  })

  it('stops listening and stops posting once closed', () => {
    const world = fakeView({ framed: true })
    const onState = vi.fn()
    const link = openEmbedLink({ hostOrigin: HOST, onState, view: world.view })!
    link.close()
    link.close()
    link.send({ type: 'switch', workspaceId: 'w2' })
    world.deliver({ data: { source: CHROME_MESSAGE_SOURCE, version: CHROME_PROTOCOL, type: 'chrome', brand: '丁' } })
    expect(onState).not.toHaveBeenCalled()
    expect(world.posted).toHaveLength(1)
    expect(world.listenerCount()).toBe(0)
  })

  it('sends a switch as a request carrying the chosen workspace', () => {
    const world = fakeView({ framed: true })
    const link = openEmbedLink({ hostOrigin: HOST, onState: () => undefined, view: world.view })!
    link.send({ type: 'switch', workspaceId: 'w2' })
    expect(world.posted[1]?.data).toMatchObject({ type: 'switch', workspaceId: 'w2' })
  })
})

describe('chrome message parsing', () => {
  const envelope = { source: CHROME_MESSAGE_SOURCE, version: CHROME_PROTOCOL, type: 'chrome' }

  it('reads a full state', () => {
    expect(parseChromeState({
      ...envelope,
      brand: '甲公众号',
      headline: '一条龙写公众号',
      workspaces: [{ id: 'a', name: '甲公众号' }, { id: 'b', name: '乙公众号' }],
      currentWorkspaceId: 'a',
    })).toEqual({
      type: 'chrome',
      brand: '甲公众号',
      headline: '一条龙写公众号',
      workspaces: [{ id: 'a', name: '甲公众号' }, { id: 'b', name: '乙公众号' }],
      currentWorkspaceId: 'a',
    })
  })

  it('treats an empty message as "change nothing"', () => {
    // What makes a partially-implemented host page safe: absent fields leave
    // DSH's own chrome in place instead of blanking it.
    expect(parseChromeState(envelope)).toEqual({ type: 'chrome' })
  })

  it('refuses a foreign envelope or an unknown protocol version', () => {
    expect(parseChromeState({ ...envelope, source: 'something-else' })).toBeNull()
    expect(parseChromeState({ ...envelope, version: 2 })).toBeNull()
    expect(parseChromeState({ ...envelope, type: 'switch' })).toBeNull()
    expect(parseChromeState(null)).toBeNull()
    expect(parseChromeState('chrome')).toBeNull()
  })

  it('drops a malformed field rather than the whole update', () => {
    expect(parseChromeState({ ...envelope, brand: '甲', workspaces: [{ id: 'a' }] }))
      .toEqual({ type: 'chrome', brand: '甲' })
    expect(parseChromeState({ ...envelope, brand: '', headline: 42 })).toEqual({ type: 'chrome' })
  })
})

describe('origin parsing', () => {
  it('reduces a configured URL to its origin', () => {
    expect(originOf('https://app.example.com')).toBe('https://app.example.com')
    expect(originOf('https://app.example.com/')).toBe('https://app.example.com')
    expect(originOf('https://app.example.com/agent?x=1')).toBe('https://app.example.com')
  })

  it('refuses what cannot be an origin', () => {
    expect(originOf('')).toBeNull()
    expect(originOf('   ')).toBeNull()
    expect(originOf('app.example.com')).toBeNull()
    expect(originOf('javascript:alert(1)')).toBeNull()
    expect(originOf('file:///etc/passwd')).toBeNull()
  })
})
