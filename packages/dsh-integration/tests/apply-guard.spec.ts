import { describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.js'
import { DELIVERABLE_TOOL_NAME } from '../src/deliverable-tool.js'

type Guard = (execution: { name: string; arguments: unknown }) => string | undefined

/**
 * Capture the guard `apply` installs, so the routing between the business
 * policy table and the deployment's external rules can be exercised directly.
 */
function guardOf(config: Config): Guard {
  let captured: Guard | undefined
  const ctx = {
    tools: {
      guard: (guard: Guard) => { captured = guard },
      register: () => {},
    },
    settings: { get: () => undefined, register: () => {} },
    get: () => undefined,
  } as unknown as Context
  apply(ctx, config)
  if (captured === undefined) throw new Error('apply did not install a guard')
  return captured
}

const base = {
  brokerUrl: 'https://broker.example.com',
  businessApiUrl: 'https://api.example.com',
  runtimeLeaseFile: '/run/dsh/lease.jwt',
  scopes: ['assistant:use'],
  exposedTools: [],
  readScope: 'customers:read:self',
} as unknown as Config

describe('guard routing', () => {
  it('leaves foreign tools alone when the deployment configured no rules', () => {
    const guard = guardOf(base)
    expect(guard({ name: 'shell', arguments: { command: 'rm -rf /' } })).toBeUndefined()
  })

  it('applies deployment rules to tools this plugin never registered', () => {
    const guard = guardOf({
      ...base,
      guard: { default: 'deny', denyMessage: '未开放。' },
    } as Config)
    expect(guard({ name: 'mcp__mf__list_projects', arguments: {} })).toBe('未开放。')
  })

  it('never routes the deliverable tool through external rules', () => {
    // It reaches no business API and carries no scope, so a `default: deny`
    // policy written for MCP servers and shells must not break it.
    const guard = guardOf({
      ...base,
      guard: { default: 'deny', denyMessage: '未开放。' },
    } as Config)
    expect(guard({ name: DELIVERABLE_TOOL_NAME, arguments: { path: 'out/report.docx' } })).toBeUndefined()
  })
})
