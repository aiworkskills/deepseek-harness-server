const CONFIGURATION_SCOPE = 'assistant:platform:write'

/**
 * The RPCs DSH pins to a loopback authority.
 *
 * Harness refuses these outright when the request carries a non-loopback
 * `Host` — `settings.describe` is documented loopback-only upstream — because
 * for a desktop install "the caller is local" is the whole authorization
 * story. A managed deployment has a different one: the Gateway authenticated
 * the user and checked `assistant:platform:write` before anything reached a
 * Runtime, and the Runtime does in fact listen on loopback.
 *
 * Exported so the server in front can tell those two situations apart. Any
 * path named here reaches a Runtime only after `blockedDshRpc` has already
 * cleared it.
 */
export function isConfigurationRpc(pathname: string): boolean {
  return pathname === '/api/settings.describe'
    || pathname === '/api/settings.update'
    || pathname === '/api/settings.replace'
    || pathname === '/api/settings.mutate'
    || pathname.startsWith('/api/credentials.')
    || pathname === '/api/llm.discoverModels'
}

export function blockedDshRpc(pathname: string, scopes: readonly string[] = []): boolean {
  if (isConfigurationRpc(pathname) && !scopes.includes(CONFIGURATION_SCOPE)) return true
  const blockedPrefixes = [
    '/api/settings.openDocument',
    '/api/cordis.',
    '/api/plugin.',
    '/api/host.open',
    '/api/host.pickDirectory',
    '/api/host.listDirectory',
    '/api/host.createDirectory',
    '/api/workspace.create',
    '/api/workspace.rename',
    '/api/workspace.delete',
    '/api/workspace.insertBefore',
    '/api/workspace.insertSessionBefore',
    '/api/agentPreset.create',
    '/api/agentPreset.copy',
    '/api/agentPreset.remove',
    '/api/agentPreset.read',
    '/api/agentPreset.select',
    '/api/permission.',
  ]
  return blockedPrefixes.some(prefix => pathname.startsWith(prefix))
}

export function prepareSessionCreateBody(
  buffer: Buffer,
  runtime: { readonly managedWorkspaceId: string },
): Buffer {
  const parsed = JSON.parse(buffer.toString('utf8')) as {
    method?: unknown
    payload?: Record<string, unknown>
    [key: string]: unknown
  }
  if (parsed.method !== 'session.create' || typeof parsed.payload !== 'object' || parsed.payload === null) {
    throw new Error('invalid session.create RPC envelope')
  }
  const requestedPreset = parsed.payload.agentPreset
  if (requestedPreset !== undefined && requestedPreset !== 'business') throw new Error('only the managed business preset is allowed')
  if (runtime.managedWorkspaceId.length === 0) throw new Error('managed workspace is not ready')
  return Buffer.from(JSON.stringify({
    ...parsed,
    payload: {
      ...(typeof parsed.payload.sessionId === 'string' ? { sessionId: parsed.payload.sessionId } : {}),
      workspaceId: runtime.managedWorkspaceId,
      agentPreset: 'business',
    },
  }))
}
