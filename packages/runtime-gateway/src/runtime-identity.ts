import { createHash } from 'node:crypto'

import type { RuntimePrincipal } from './types.js'

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

/** Stable process/home key for one verified identity. */
export function runtimeKey(principal: Pick<RuntimePrincipal, 'issuer' | 'tenantId' | 'subject'>): string {
  return shortHash(`${principal.issuer}\u0000${principal.tenantId}\u0000${principal.subject}`)
}

/** Stable tenant key used by all users sharing administrator-owned settings. */
export function tenantKey(principal: Pick<RuntimePrincipal, 'issuer' | 'tenantId'>): string {
  return shortHash(`${principal.issuer}\u0000${principal.tenantId}`)
}

/** Restart boundary for policy facts captured when a Runtime is spawned. */
export function policyFingerprint(principal: RuntimePrincipal): string {
  const models = principal.models
    .map(model => `${model.provider}/${model.model}/${model.apiKeyEnv ?? ''}/${model.baseURL ?? ''}`)
    .sort()
    .join(' ')
  return shortHash([
    principal.presetRole,
    [...principal.scopes].sort().join(' '),
    [...principal.tools].sort().join(' '),
    models,
    principal.canConfigureDsh ? 'configure' : 'consume',
  ].join('\u0000'))
}
