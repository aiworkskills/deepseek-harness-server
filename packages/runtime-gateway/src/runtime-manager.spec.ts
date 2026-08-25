/**
 * Manager lifecycle against an injected backend.
 *
 * The backend seam is what makes these tests possible at all: before it, every
 * lifecycle assertion needed a real spawned Harness. The fake backend stands in
 * for the execution world; the HTTP server stands in for a Runtime that answers
 * the readiness probe and the workspace bootstrap RPC.
 */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RuntimeManager } from './runtime-manager.js'
import type { RuntimeBackend, RuntimeHandle, RuntimeStart } from './runtime-backend.js'
import type { RuntimePrincipal } from './types.js'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

const principal: RuntimePrincipal = {
  issuer: 'https://iam.example.com', tenantId: 'acme', subject: 'user-1', teamId: 'sales',
  clientId: 'business-web', name: 'User One', role: 'employee', expiresAt: 1_900_000_000, tokenId: 'token-1',
  scopes: ['assistant:use'], presetRole: 'employee', tools: ['business_list_customers'],
  models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], policyRevision: 1, canConfigureDsh: false,
}

/** Answers like a Runtime: ok to the probe, a workspace to the bootstrap RPC. */
function fakeRuntimeServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/workspace.create') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ result: { ok: true, value: { workspace: { workspaceId: 'ws-1' } } } }))
      return
    }
    response.end('ok')
  })
  return new Promise(resolveServer => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolveServer({ server, origin: `http://127.0.0.1:${String(port)}` })
    })
  })
}

interface FakeBackendOptions {
  /** Handles report this exit cause from the start — a runtime dead on arrival. */
  readonly deadWith?: number
  readonly logs?: readonly string[]
}

class FakeBackend implements RuntimeBackend {
  readonly isolation = 'fake-isolation'
  readonly starts: RuntimeStart[] = []
  readonly stopped: RuntimeHandle[] = []

  constructor(private readonly target: string, private readonly options: FakeBackendOptions = {}) {}

  async start(start: RuntimeStart): Promise<RuntimeHandle> {
    this.starts.push(start)
    let cause: number | string | null = this.options.deadWith ?? null
    let resolveExited: (value: number | string | null) => void = () => {}
    const exited = new Promise<number | string | null>(resolveDone => { resolveExited = resolveDone })
    if (cause !== null) resolveExited(cause)
    const backend = this
    const handle: RuntimeHandle = {
      target: this.target,
      exitCause: () => cause,
      exited,
      logTail: async lines => (this.options.logs ?? []).slice(-lines),
      async stop() {
        if (cause === null) {
          cause = 'stopped'
          resolveExited(cause)
        }
        backend.stopped.push(handle)
      },
    }
    return handle
  }
}

let scratch: string
let server: Server
let origin: string
const managers: RuntimeManager[] = []

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dshserver-manager-'))
  ;({ server, origin } = await fakeRuntimeServer())
})

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async manager => { await manager.close() }))
  await new Promise<void>(resolveClose => { server.close(() => { resolveClose() }) })
  await rm(scratch, { recursive: true, force: true })
})

async function makeManager(backend: RuntimeBackend, idleMs = 60_000): Promise<RuntimeManager> {
  // A real provisioning pass needs a readable CLI file and one plugin artifact;
  // the fake backend never executes either.
  const cli = join(scratch, 'harness', 'apps', 'cli', 'lib', 'bin.js')
  await mkdir(dirname(cli), { recursive: true })
  await writeFile(cli, '// stand-in cli\n')
  const pluginRoot = join(scratch, 'plugin')
  await mkdir(join(pluginRoot, 'dist'), { recursive: true })
  await writeFile(join(pluginRoot, 'dist', 'index.js'), 'export {}\n')

  const manager = new RuntimeManager(
    { issueRuntimeLease: async () => 'lease-token' },
    {
      projectRoot: scratch,
      dshSourceRoot: join(scratch, 'harness'),
      runtimeRoot: join(scratch, 'users'),
      configRoot: join(repoRoot, 'config'),
      runtimePlugins: [{ packageName: '@test/plugin', root: pluginRoot, artifacts: ['dist/index.js'] }],
      internalOrigin: origin,
      publicHost: '127.0.0.1:4173',
      idleMs,
      disabled: false,
      backend,
      log: () => {},
    },
  )
  managers.push(manager)
  return manager
}

describe('runtime manager lifecycle', () => {
  it('starts once and reuses the ready runtime for the same policy', async () => {
    const backend = new FakeBackend(origin)
    const manager = await makeManager(backend)
    const first = await manager.runtime(principal)
    const second = await manager.runtime(principal)
    expect(second).toBe(first)
    expect(backend.starts).toHaveLength(1)
    expect(first.status).toBe('ready')
    expect(first.managedWorkspaceId).toBe('ws-1')
    expect(manager.view(principal)?.isolation).toBe('fake-isolation')
  })

  it('replaces the runtime when effective policy changes', async () => {
    const backend = new FakeBackend(origin)
    const manager = await makeManager(backend)
    const before = await manager.runtime(principal)
    const after = await manager.runtime({ ...principal, tools: [] })
    expect(after).not.toBe(before)
    expect(backend.starts).toHaveLength(2)
    // The old runtime must actually be gone, or the revoked policy lives on.
    expect(backend.stopped).toHaveLength(1)
  })

  it('reports the backend log tail when the runtime dies during startup', async () => {
    const backend = new FakeBackend(origin, { deadWith: 7, logs: ['[stderr] refusing to start'] })
    const manager = await makeManager(backend)
    await expect(manager.runtime(principal)).rejects.toThrow(/refusing to start/)
  })

  it('close() stops every runtime it started', async () => {
    const backend = new FakeBackend(origin)
    const manager = await makeManager(backend)
    await manager.runtime(principal)
    await manager.close()
    expect(backend.stopped).toHaveLength(1)
  })
})

describe('idle reclamation counts connections, not clock alone', () => {
  it('keeps a Runtime whose client is still attached', async () => {
    // The bug this replaces: `lastUsedAt` only moves when the gateway resolves
    // a Runtime for a NEW request, and a working agent generates none — the
    // browser holds a stream opened minutes ago, the model calls go outbound,
    // the tools run inside the container. So any turn longer than idleMs looked
    // abandoned and the sweep killed it mid-task, cutting the event stream.
    const manager = await makeManager(new FakeBackend(origin), 1)
    const record = await manager.runtime(principal)
    const detach = manager.attach(record)
    record.lastUsedAt = Date.now() - 60_000

    await manager.sweepIdle()
    expect(record.status).toBe('ready')
    expect(manager.view(principal)).toBeDefined()

    // Releasing restarts the countdown rather than expiring on the spot, so the
    // clock has to run out again before the Runtime is reclaimable.
    detach()
    await manager.sweepIdle()
    expect(manager.view(principal)).toBeDefined()

    record.lastUsedAt = Date.now() - 60_000
    await manager.sweepIdle()
    expect(manager.view(principal)).toBeUndefined()
  })

  it('restarts the idle clock when the last client leaves', async () => {
    const manager = await makeManager(new FakeBackend(origin), 60_000)
    const record = await manager.runtime(principal)
    record.lastUsedAt = Date.now() - 600_000
    const detach = manager.attach(record)
    detach()
    // Releasing is what starts the countdown, so a long-running turn does not
    // arrive at its own end already expired.
    expect(Date.now() - record.lastUsedAt).toBeLessThan(1_000)
  })

  it('counts each client once, however its socket ends', async () => {
    // An upgraded socket can emit both `close` and an error; a double decrement
    // would let the sweep reap a Runtime other clients are still using.
    const manager = await makeManager(new FakeBackend(origin), 1)
    const record = await manager.runtime(principal)
    const first = manager.attach(record)
    manager.attach(record)
    first()
    first()
    record.lastUsedAt = Date.now() - 60_000

    await manager.sweepIdle()
    expect(manager.view(principal)).toBeDefined()
  })
})
