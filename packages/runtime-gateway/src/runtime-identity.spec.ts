import { describe, expect, it } from 'vitest'

import { policyFingerprint, runtimeKey, tenantKey } from './runtime-identity.js'
import type { RuntimePrincipal } from './types.js'

const principal: RuntimePrincipal = {
  issuer: 'https://iam.example.com', tenantId: 'acme', subject: 'user-1', teamId: 'sales',
  clientId: 'business-web', name: 'User One', role: 'employee', expiresAt: 1_900_000_000, tokenId: 'token-1',
  scopes: ['assistant:use'], presetRole: 'employee', tools: ['business_list_customers'],
  models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], policyRevision: 1, canConfigureDsh: false,
}

describe('runtime identity', () => {
  it('keeps user and tenant keys stable while separating their ownership', () => {
    expect(runtimeKey(principal)).toHaveLength(20)
    expect(tenantKey(principal)).toHaveLength(20)
    expect(runtimeKey({ ...principal, subject: 'user-2' })).not.toBe(runtimeKey(principal))
    expect(tenantKey({ issuer: principal.issuer, tenantId: principal.tenantId })).toBe(tenantKey(principal))
  })

  it('pins the tenant key when a deployment names it', () => {
    expect(tenantKey(principal, 'acme-prod')).toBe('acme-prod')
    expect(tenantKey({ issuer: 'https://login.acme.com', tenantId: 'other' }, 'acme-prod')).toBe('acme-prod')
    expect(tenantKey(principal, '')).toBe(tenantKey(principal))
    expect(() => tenantKey(principal, '../escape')).toThrow(/safe path segment/)
    expect(() => tenantKey(principal, 'a'.repeat(65))).toThrow(/safe path segment/)
  })

  it('changes the restart fingerprint when effective policy changes', () => {
    expect(policyFingerprint({ ...principal, tools: [] })).not.toBe(policyFingerprint(principal))
    expect(policyFingerprint({ ...principal, scopes: [...principal.scopes] })).toBe(policyFingerprint(principal))
  })
})
