import { describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.js'
import {
  CONNECTOR_SETTINGS_NAMESPACE, DEFAULT_CONNECTOR_SETTINGS,
  connectorSettings, installConnectorSettings, type ConnectorSettings,
} from '../src/connector-settings.js'
import { authorizationProblem, BUSINESS_TOOL_NAMES, exchangeScope, requiredScopes } from '../src/policy.js'

const base = {
  brokerUrl: 'https://broker.example.com',
  businessApiUrl: 'https://api.example.com',
  runtimeLeaseFile: '/run/dsh/lease.jwt',
  scopes: ['customers:read:self'],
  exposedTools: ['business_list_customers'] as const,
  readScope: 'customers:read:self' as const,
}

describe('connector configuration', () => {
  it('resolves stable protocol and behavior defaults', () => {
    expect(resolveConfig({ ...base, exposedTools: [...base.exposedTools] })).toMatchObject({
      tokenEndpointPath: '/internal/oauth/token',
      businessApiAudience: 'urn:dshserver:business-api',
      settings: { requestTimeoutMs: 15_000, writeOperationsEnabled: true, minimumWriteReasonLength: 2 },
    })
  })

  it('rejects unknown tools at the deployment boundary', () => {
    expect(() => resolveConfig({ ...base, exposedTools: ['unknown'] as never })).toThrow('unknown exposed tool')
  })

  it('reads the Host-owned live settings section', () => {
    const configured = { requestTimeoutMs: 5_000, writeOperationsEnabled: false, minimumWriteReasonLength: 8 }
    const ctx = { get: () => ({ get: () => configured }) } as unknown as Context
    expect(connectorSettings(ctx, resolveConfig({ ...base, exposedTools: [...base.exposedTools] }).settings)).toEqual(configured)
  })
})

/**
 * 这一节守的是"注册在正确的命名空间下、并且把范围校验交了出去"。
 *
 * 两条都无声：命名空间写错会注册出一个没有卡片能找到的配置段，而漏交 `validate`
 * 会让越界的存量值在工具调用时才炸，而不是在保存时被拒。
 */
describe('tenant settings installation', () => {
  interface RegisterCall {
    ns: unknown
    base: unknown
    validate: ((value: ConnectorSettings) => void) | undefined
  }

  function stubContext(): { ctx: Context; calls: RegisterCall[] } {
    const calls: RegisterCall[] = []
    const ctx = {
      settings: {
        register: (ns: unknown, _schema: unknown, options: {
          base: unknown
          validate?: (value: ConnectorSettings) => void
        }) => { calls.push({ ns, base: options.base, validate: options.validate }) },
      },
    } as unknown as Context
    return { ctx, calls }
  }

  it('registers under this connector namespace, with the entry as base', () => {
    const { ctx, calls } = stubContext()
    installConnectorSettings(ctx, DEFAULT_CONNECTOR_SETTINGS)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.ns).toBe(CONNECTOR_SETTINGS_NAMESPACE)
    expect(calls[0]?.base).toBe(DEFAULT_CONNECTOR_SETTINGS)
  })

  it('hands over the range check, so a stored value out of range is refused', () => {
    const { ctx, calls } = stubContext()
    installConnectorSettings(ctx, DEFAULT_CONNECTOR_SETTINGS)
    expect(() => calls[0]?.validate?.({ ...DEFAULT_CONNECTOR_SETTINGS, requestTimeoutMs: 1 }))
      .toThrow('requestTimeoutMs')
  })

  it('keeps the namespace a literal the service can brand', () => {
    // `settingsNamespace()` 没了，改由 `register`/`get` 在类型层校验字面量，
    // 而这只在常量保持窄字符串类型时成立——widen 成 `string` 就失效了。
    expect(CONNECTOR_SETTINGS_NAMESPACE).toBe('dshserver-integration')
  })
})
