/**
 * These cover the order of the checks, not the proxying.
 *
 * The sequence is where a mistake becomes a security bug: a Runtime started
 * before the scope check, or an RPC lock applied to the widened scopes instead
 * of the granted ones, both still pass a smoke test.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
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
async function call(
  gateway: GatewayServer, path: string, payload?: unknown,
  /** Extra request headers — a browser sends more than these tests used to. */
  extra: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
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
    const method = payload === undefined ? 'GET' : 'POST'
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method, headers: extra }, (response: IncomingMessage) => {
      let body = ''
      response.on('data', chunk => { body += String(chunk) })
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
    })
    outgoing.once('error', reject)
    outgoing.end(payload === undefined ? undefined : JSON.stringify(payload))
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

  it('explains a locked RPC inside the API error branch so the client can show it', async () => {
    // A bare 403 is thrown away by the DSH client before it reads the body, so
    // the user sees "transport failure ... HTTP 403" — a wire detail that
    // explains nothing. The refusal belongs in the protocol's own error branch,
    // where the client already surfaces `error.message`.
    const { gateway, onDenied } = harness({
      lockedRpcMessage: path => `no ${path} here`,
    })
    const response = await call(gateway, '/api/host.openPath', {
      type: 'client-request', rpcId: 'rpc-7', method: 'host.openPath', payload: { path: '/x' },
    })
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body) as {
      type: string
      rpcId: string
      result: { ok: boolean; error: { code: string; message: string; details: unknown } }
    }
    expect(body.type).toBe('server-response')
    // Echoed: the client rejects a mismatched id before reading the result, so
    // a guessed one would replace the explanation with a mismatch error.
    expect(body.rpcId).toBe('rpc-7')
    expect(body.result.ok).toBe(false)
    expect(body.result.error.message).toBe('no /api/host.openPath here')
    expect(body.result.error.details).toEqual({})
    // Still a refusal: audited, and nothing reached a Runtime.
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ denial: 'managed_capability_locked' }))
  })

  it('keeps a plain 403 for a locked path that is not an RPC call', async () => {
    // No client request means no conversation to answer; inventing an envelope
    // would only disguise that.
    const { gateway } = harness()
    expect((await call(gateway, '/api/cordis.install')).status).toBe(403)
  })

  it('reports a Runtime that will not start as a service error, not a refusal', async () => {
    const { gateway, onDenied } = harness({}, async () => { throw new Error('spawn failed') })
    expect((await call(gateway, '/assistant')).status).toBe(503)
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ denial: 'runtime_unavailable' }))
  })
})

describe('gateway upgrade resilience', () => {
  it('survives a client that resets before the Runtime has resolved', async () => {
    // The window between the `upgrade` event and the proxy taking the socket is
    // owned by nobody, and resolving may have to start a Runtime — seconds during
    // which a client can give up. Guarding after that await rather than before it
    // leaves an unlistened `error` on a detached socket, which ends the process
    // and with it every other Subject's session.
    const { gateway } = harness()
    const socket = new PassThrough()
    const upgrade = { url: '/plugins/events', headers: {} } as IncomingMessage

    const pending = gateway.handleUpgrade(upgrade, socket, Buffer.alloc(0))
    expect(() => socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })))
      .not.toThrow()

    await expect(pending).resolves.toBe(true)
  })

  it('leaves non-DSH upgrades to the host application', async () => {
    const { gateway, runtimeFor } = harness()
    const socket = new PassThrough()
    const upgrade = { url: '/ws/host-app', headers: {} } as IncomingMessage
    await expect(gateway.handleUpgrade(upgrade, socket, Buffer.alloc(0))).resolves.toBe(false)
    expect(runtimeFor).not.toHaveBeenCalled()
  })
})

/**
 * Harness pins `settings.*` and friends to a loopback authority: it refuses
 * them outright when `Host` names anything else, because for a desktop install
 * "the caller is local" *is* the authorization. Behind a gateway the caller is
 * never local, so a platform administrator got a bare 403 and a settings page
 * that only said "settings are unavailable in this browser".
 *
 * The stand-in below re-implements Harness's actual fence rather than echoing
 * the header back. An earlier version of these tests only asserted that `Host`
 * had been rewritten, which is not the claim that matters — it stayed green
 * while the rewrite was still being refused upstream, for two reasons the echo
 * could not see: the container backend addresses a Runtime by container name
 * (not loopback), and browsers attach `Origin` to every non-GET request, which
 * an upstream compares against `Host`.
 */
describe('loopback-pinned configuration RPCs', () => {
  /**
   * A stand-in Runtime applying the same two fences as
   * `dsh-client-connection`'s `isTrustedApiRequest` for a channel declared
   * `authority: 'loopback'` — that declaration empties the trusted-host list,
   * so only a loopback `Host` passes, and an `Origin` that disagrees with it is
   * refused. Restated here rather than imported: this package does not depend
   * on the client runtime, and a test that cannot fail is worse than no test.
   */
  async function pinnedRuntime(): Promise<string> {
    const server = createServer((request, response) => {
      const host = request.headers.host ?? ''
      const hostname = host.replace(/:\d+$/u, '')
      const origin = request.headers.origin
      const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
      const originAgrees = origin === undefined || new URL(origin).host === host
      if (!loopback || !originAgrees || request.headers['sec-fetch-site'] === 'cross-site') {
        response.writeHead(403).end('forbidden')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ host }))
    })
    servers.push(server)
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  }

  /** Same identity, plus the scope the deployment requires for configuration. */
  function administrator(target: string, loopbackConfigurationRpc: boolean) {
    const scopes = ['assistant:use', 'assistant:platform:write']
    return harness(
      {
        loopbackConfigurationRpc,
        authenticate: async () => ({ ...authenticated, scopes }),
        authorize: async () => ({ ...authorized, scopes, canConfigureDsh: true }),
      },
      async () => ({ target, managedWorkspaceId: 'ws-1' }),
    )
  }

  /** What a browser actually sends: same-origin POSTs carry Origin too. */
  const browser = { origin: 'https://agent.example.com', 'sec-fetch-site': 'same-origin' }

  it('gets a configuration RPC past the pin when the deployment opts in', async () => {
    const target = await pinnedRuntime()
    const { gateway } = administrator(target, true)
    const answer = await call(gateway, '/api/settings.describe', { type: 'client-request', rpcId: 'r1' }, browser)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body).host).toBe(`127.0.0.1:${new URL(target).port}`)
  })

  it('leaves the pin in place by default', async () => {
    // Most deployments never expose DSH's own settings. Carrying a door you do
    // not use is worse than not having it.
    const target = await pinnedRuntime()
    const { gateway } = administrator(target, false)
    const answer = await call(gateway, '/api/settings.describe', { type: 'client-request', rpcId: 'r2' }, browser)
    expect(answer.status).toBe(403)
  })

  it('forwards the caller Host everywhere else', async () => {
    const target = await pinnedRuntime()
    const { gateway } = administrator(target, true)
    // Not a configuration RPC, so `Host` is untouched — and the stand-in
    // refuses it, which is exactly right: that is what a Runtime builds its
    // links from, and rewriting it everywhere would hand out 127.0.0.1 links.
    const answer = await call(gateway, '/api/llm.providers', { type: 'client-request', rpcId: 'r3' }, browser)
    expect(answer.status).toBe(403)
  })

  it('still refuses a configuration RPC without the platform scope', async () => {
    const target = await pinnedRuntime()
    const { gateway } = harness({ loopbackConfigurationRpc: true }, async () => ({ target, managedWorkspaceId: 'ws-1' }))
    const answer = await call(gateway, '/api/settings.describe', { type: 'client-request', rpcId: 'r4' }, browser)
    // The opt-in must never become a way around the deployment's own check.
    expect(answer.body).not.toContain('"host"')
  })
})
