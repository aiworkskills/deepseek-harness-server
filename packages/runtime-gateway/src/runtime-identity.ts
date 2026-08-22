import { createHash } from 'node:crypto'

import type { RuntimePrincipal } from './types.js'

/**
 * A deployment-pinned tenant directory name: one safe path segment, so an
 * operator-supplied value can never reach outside the tenants root.
 */
const PINNED_TENANT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

/** Stable process/home key for one verified identity. */
export function runtimeKey(principal: Pick<RuntimePrincipal, 'issuer' | 'tenantId' | 'subject'>): string {
  return shortHash(`${principal.issuer}\u0000${principal.tenantId}\u0000${principal.subject}`)
}

/**
 * Stable tenant key used by all users sharing administrator-owned settings.
 *
 * The derived key changes with the issuer, so moving a deployment to its real
 * origin or to the customer's own IdP would silently orphan every administrator
 * setting and credential. `pinned` names the directory instead, which is what a
 * production deployment should do before it ever changes those inputs.
 */
export function tenantKey(principal: Pick<RuntimePrincipal, 'issuer' | 'tenantId'>, pinned?: string): string {
  if (pinned !== undefined && pinned.length > 0) {
    if (!PINNED_TENANT_KEY.test(pinned)) {
      throw new Error(`pinned tenant key (DSHSERVER_TENANT_KEY) must be one safe path segment: ${pinned}`)
    }
    return pinned
  }
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
