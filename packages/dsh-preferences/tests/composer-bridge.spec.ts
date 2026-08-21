import { describe, expect, it, vi } from 'vitest'
import {
  COMPOSER_CHANNEL, COMPOSER_PROTOCOL_VERSION, ComposerBridge, composeDraft,
  MAX_PROMPT_LENGTH, normalizePrompt, readComposerMessage,
  type ComposerReply, type ComposerTarget,
} from '../src/composer-bridge.js'

function insert(extra: Record<string, unknown> = {}) {
  return {
    channel: COMPOSER_CHANNEL,
    version: COMPOSER_PROTOCOL_VERSION,
    type: 'insert',
    text: '查一下 CUS-1011 的详情。',
    ...extra,
  }
}

function composer(draft = '', busy = false) {
  const state = { draft, busy }
  const target: ComposerTarget = {
    read: () => state,
    write: (next) => { state.draft = next },
  }
  return { target, state }
}

function collector() {
  const replies: ComposerReply[] = []
  return { replies, respond: (reply: ComposerReply) => { replies.push(reply) } }
}

describe('composer handoff protocol', () => {
  it('ignores payloads addressed to another integration', () => {
    expect(readComposerMessage({ type: 'insert', text: 'x' })).toBeUndefined()
    expect(readComposerMessage('a string')).toBeUndefined()
    expect(readComposerMessage(null)).toBeUndefined()
  })

  it('refuses an unknown protocol version rather than guessing', () => {
    expect(readComposerMessage(insert({ version: 2 }))).toMatchObject({ reason: 'unsupported-version' })
  })

  it('accepts the minimal payload and defaults to appending', () => {
    expect(readComposerMessage(insert())).toMatchObject({ type: 'insert', mode: 'append' })
  })

  it('rejects empty, oversized and malformed text', () => {
    expect(readComposerMessage(insert({ text: '   ' }))).toMatchObject({ reason: 'empty-text' })
    expect(readComposerMessage(insert({ text: 'x'.repeat(MAX_PROMPT_LENGTH + 1) })))
      .toMatchObject({ reason: 'text-too-long' })
    expect(readComposerMessage(insert({ text: 42 }))).toMatchObject({ reason: 'malformed' })
    expect(readComposerMessage(insert({ mode: 'prepend' }))).toMatchObject({ reason: 'malformed' })
  })

  it('strips control characters and the reference-chip placeholder', () => {
    expect(normalizePrompt('a\u0000b\uFFFCc\r\nd  ')).toBe('abc\nd')
    expect(normalizePrompt('列\t表')).toBe('列\t表')
  })

  it('appends below an unfinished draft but never overwrites it silently', () => {
    const request = readComposerMessage(insert())
    expect(request?.type).toBe('insert')
    if (request?.type !== 'insert') return
    expect(composeDraft('', request)).toBe(request.text)
    expect(composeDraft('用户已经写了一半 \n', request)).toBe(`用户已经写了一半\n${request.text}`)
    expect(composeDraft('用户已经写了一半', { ...request, mode: 'replace' })).toBe(request.text)
  })
})

describe('composer bridge', () => {
  it('writes the sentence into the live composer', () => {
    const { target, state } = composer()
    const { replies, respond } = collector()
    new ComposerBridge(() => target).receive(insert({ requestId: 'r1' }), respond)
    expect(state.draft).toBe('查一下 CUS-1011 的详情。')
    expect(replies).toEqual([{
      channel: COMPOSER_CHANNEL, version: COMPOSER_PROTOCOL_VERSION,
      type: 'result', status: 'applied', requestId: 'r1',
    }])
  })

  it('answers a retried request without writing the sentence twice', () => {
    const { target, state } = composer()
    const { replies, respond } = collector()
    const bridge = new ComposerBridge(() => target)
    bridge.receive(insert({ requestId: 'r1' }), respond)
    bridge.receive(insert({ requestId: 'r1' }), respond)
    expect(state.draft).toBe('查一下 CUS-1011 的详情。')
    expect(replies.every(reply => reply.type === 'result' && reply.status === 'applied')).toBe(true)
  })

  it('holds a sentence that arrives before any session exists', () => {
    const { target, state } = composer()
    const { replies, respond } = collector()
    let live: ComposerTarget | undefined
    const bridge = new ComposerBridge(() => live)
    bridge.receive(insert({ requestId: 'r1' }), respond)
    expect(replies).toMatchObject([{ status: 'pending' }])
    expect(bridge.holding).toBe(true)

    bridge.flush()
    expect(bridge.holding).toBe(true)

    live = target
    bridge.flush()
    expect(state.draft).toBe('查一下 CUS-1011 的详情。')
    expect(replies).toMatchObject([{ status: 'pending' }, { status: 'applied' }])
    expect(bridge.holding).toBe(false)
  })

  it('refuses to touch a composer that is submitting', () => {
    const { target, state } = composer('原始草稿', true)
    const { replies, respond } = collector()
    new ComposerBridge(() => target).receive(insert(), respond)
    expect(state.draft).toBe('原始草稿')
    expect(replies).toMatchObject([{ status: 'rejected', reason: 'composer-busy' }])
  })

  it('refuses a handoff that would overflow the draft', () => {
    const { target, state } = composer('x'.repeat(6000))
    const { replies, respond } = collector()
    new ComposerBridge(() => target).receive(insert({ text: 'y'.repeat(MAX_PROMPT_LENGTH) }), respond)
    expect(state.draft).toBe('x'.repeat(6000))
    expect(replies).toMatchObject([{ status: 'rejected', reason: 'draft-too-long' }])
  })

  it('answers a readiness probe and stays silent for foreign traffic', () => {
    const respond = vi.fn()
    const bridge = new ComposerBridge(() => undefined)
    bridge.receive({ channel: COMPOSER_CHANNEL, version: COMPOSER_PROTOCOL_VERSION, type: 'ping' }, respond)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
    respond.mockClear()
    bridge.receive({ type: 'webpack-hmr' }, respond)
    expect(respond).not.toHaveBeenCalled()
  })
})
