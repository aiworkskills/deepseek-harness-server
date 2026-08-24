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

  it('gives one Subject a separate key per workspace', () => {
    const siteA: RuntimePrincipal = { ...principal, workspaceId: 'site-a' }
    const siteB: RuntimePrincipal = { ...principal, workspaceId: 'site-b' }
    expect(runtimeKey(siteA)).not.toBe(runtimeKey(siteB))
    expect(runtimeKey(siteA)).not.toBe(runtimeKey(principal))
    // Same tenant either way: the second axis divides workspaces, not organisations.
    expect(tenantKey(siteA)).toBe(tenantKey(principal))
  })

  it('derives the same key as before for a deployment with no second axis', () => {
    // Written as a literal on purpose. Every deployment that never supplies a
    // workspace has live directories named by this value, so a refactor that
    // quietly changes it orphans all of them — and a test that recomputed the
    // hash the same way the code does would agree with the mistake.
    expect(runtimeKey(principal)).toBe('5a89d52734d34c6d3951')
    // An empty string means "no second axis" too, not a workspace named ''.
    const blank: RuntimePrincipal = { ...principal, workspaceId: '' }
    expect(runtimeKey(blank)).toBe('5a89d52734d34c6d3951')
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
