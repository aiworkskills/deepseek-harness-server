import { describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.js'
import { connectorSettings } from '../src/connector-settings.js'
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

describe('tool authorization policy', () => {
  it('requires every scope used by team analytics', () => {
    expect(authorizationProblem('business_customer_overview', {
      readScope: 'customers:read:team',
      grantedScopes: new Set(['customers:read:team']),
      writeOperationsEnabled: true,
    })).toContain('analytics:read')
  })

  it('lets the platform administrator stop all writes without changing OAuth', () => {
    expect(authorizationProblem('business_update_customer', {
      readScope: 'customers:read:team',
      grantedScopes: new Set(['customers:write:team']),
      writeOperationsEnabled: false,
    })).toContain('暂停写操作')
  })

  it('requests exactly the guarded scopes during token exchange', () => {
    for (const name of BUSINESS_TOOL_NAMES) {
      for (const readScope of ['customers:read:self', 'customers:read:team'] as const) {
        expect(exchangeScope(name, readScope)).toBe(requiredScopes(name, readScope).join(' '))
      }
    }
    expect(exchangeScope('business_list_customers', 'customers:read:self')).toBe('customers:read:self')
    expect(exchangeScope('business_customer_overview', 'customers:read:self')).toBe('customers:read:team analytics:read')
  })
})
