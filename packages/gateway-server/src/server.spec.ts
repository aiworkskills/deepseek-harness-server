/**
 * These cover the order of the checks, not the proxying.
 *
 * The sequence is where a mistake becomes a security bug: a Runtime started
 * before the scope check, or an RPC lock applied to the widened scopes instead
 * of the granted ones, both still pass a smoke test.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GatewayPrincipal, RuntimePrincipal } from '@dshserver/runtime-gateway'

import { GatewayServer, type GatewayServerOptions } from './server.js'

const authenticated: GatewayPrincipal = {
  issuer: 'https://iam.example.com', subject: 'user-1', clientId: 'web', name: 'User One',
  role: 'employee', tenantId: 'acme', teamId: 'sales', scopes: ['assistant:use'],
  expiresAt: 1_900_000_000, tokenId: 'token-1',
}

const authorized: RuntimePrincipal = {
  ...authenticated, presetRole: 'employee', tools: [], policyRevision: 1, canConfigureDsh: false,
  models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => { resolve() }) })))
})

/** A gateway whose Runtime resolution is observable and never actually spawns. */
function harness(
  overrides: Partial<GatewayServerOptions> = {},
  // Default target is a port nothing listens on, so a test that gets this far
  // exercises the proxy's failure path rather than reaching a real Runtime.
  resolveRuntime: () => Promise<unknown> = async () => ({ target: 'http://127.0.0.1:1', managedWorkspaceId: 'ws-1' }),
) {
  const runtimeFor = vi.fn(resolveRuntime)
  const onDenied = vi.fn()
  const gateway = new GatewayServer({
    authenticate: async () => authenticated,
    authorize: async () => authorized,
    authority: { issueRuntimeLease: async () => 'lease' },
    runtime: {
      projectRoot: '/srv/app', dshSourceRoot: '/srv/harness', runtimeRoot: '/srv/app/.runtime/users',
      internalOrigin: 'http://127.0.0.1:4173', publicHost: '127.0.0.1:4173', idleMs: 1000, disabled: true,
    },
    onDenied,
    ...overrides,
  })
  // The manager is exercised elsewhere; here it only needs to be reachable so
  // the ordering of the checks before it is what the assertions see.
  Object.defineProperty(gateway.manager, 'runtime', { value: runtimeFor })
  return { gateway, runtimeFor, onDenied }
}

/** Drive one request through a real socket so headers and status are genuine. */
async function call(gateway: GatewayServer, path: string): Promise<{ status: number; body: string }> {
  const server = createServer((request, response) => {
    void gateway.handleRequest(request, response).then(handled => {
      if (!handled) {
        response.writeHead(404).end('host route')
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo

  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (response: IncomingMessage) => {
      let body = ''
      response.on('data', chunk => { body += String(chunk) })
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

describe('gateway request policy', () => {
  it('leaves non-DSH paths to the host application', async () => {
    const { gateway, runtimeFor } = harness()
    expect((await call(gateway, '/auth/start')).status).toBe(404)
    expect(runtimeFor).not.toHaveBeenCalled()
  })

  it('refuses an unauthenticated request without starting a Runtime', async () => {
    const { gateway, runtimeFor, onDenied } = harness({ authenticate: async () => undefined })
    const response = await call(gateway, '/assistant')
    expect(response.status).toBe(401)
    expect(runtimeFor).not.toHaveBeenCalled()
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ denial: 'unauthenticated' }))
  })

  it('refuses a user without the assistant scope before starting a Runtime', async () => {
    const { gateway, runtimeFor, onDenied } = harness({
      authorize: async () => ({ ...authorized, scopes: ['customers:read:self'] }),
    })
    const response = await call(gateway, '/assistant')
    expect(response.status).toBe(403)
    expect(runtimeFor).not.toHaveBeenCalled()
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({
      denial: 'missing_assistant_scope', subject: 'user-1',
    }))
  })

  it('refuses a locked RPC', async () => {
    const { gateway, onDenied } = harness()
    const response = await call(gateway, '/api/cordis.install')
    expect(response.status).toBe(403)
    expect(response.body).toContain('managed_capability_locked')
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ denial: 'managed_capability_locked' }))
  })

  it('judges the RPC lock on granted scopes, not on what policy widened them to', async () => {
    // Policy may narrow a user's capabilities; it must not be able to hand out a
    // scope the IAM withheld. Configuration RPCs are the case that matters.
    const { gateway } = harness({
      authorize: async () => ({ ...authorized, scopes: ['assistant:use', 'assistant:platform:write'] }),
    })
    expect((await call(gateway, '/api/settings.update')).status).toBe(403)
  })

  it('admits a configuration RPC when the IAM itself granted the scope', async () => {
    const platform = { ...authenticated, scopes: ['assistant:use', 'assistant:platform:write'] }
    const { gateway, runtimeFor } = harness({
      authenticate: async () => platform,
      authorize: async () => ({ ...authorized, scopes: platform.scopes }),
    })
    // The check passes, so the request reaches Runtime resolution and then the
    // proxy — where the stub target refuses the connection.
    expect((await call(gateway, '/api/settings.update')).status).toBe(502)
    expect(runtimeFor).toHaveBeenCalled()
  })

  it('answers rather than hangs when the Runtime is gone by the time we connect', async () => {
    const { gateway } = harness()
    const response = await call(gateway, '/assistant')
    expect(response.status).toBe(502)
    expect(response.body).toContain('runtime_unreachable')
  })

  it('reports a Runtime that will not start as a service error, not a refusal', async () => {
    const { gateway, onDenied } = harness({}, async () => { throw new Error('spawn failed') })
    expect((await call(gateway, '/assistant')).status).toBe(503)
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ denial: 'runtime_unavailable' }))
  })
})
