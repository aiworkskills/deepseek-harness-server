/**
 * The container backend against a stand-in Docker Engine.
 *
 * What matters here is the shape of the Engine conversation — the create body
 * is where isolation actually gets configured, so these tests read it the way
 * a security review would: are the mounts right, is the tenant tree read-only
 * for non-administrators, did the host's PATH leak in, does a stale container
 * get replaced rather than adopted.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ContainerRuntimeBackend, containerCommand, demuxDockerLogs, translateEnvironment } from './backend-container.js'
import { runtimeLayout } from './runtime-provision.js'
import type { RuntimeStart } from './runtime-backend.js'
import type { RuntimePrincipal } from './types.js'

const principal: RuntimePrincipal = {
  issuer: 'https://iam.example.com', tenantId: 'acme', subject: 'user-1', teamId: 'sales',
  clientId: 'business-web', name: 'User One', role: 'employee', expiresAt: 1_900_000_000, tokenId: 'token-1',
  scopes: ['assistant:use'], presetRole: 'employee', tools: [],
  models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], policyRevision: 1, canConfigureDsh: false,
}

const layout = runtimeLayout(
  { projectRoot: '/srv/app', dshSourceRoot: '/srv/harness', runtimeRoot: '/srv/app/.runtime/users' },
  'subject-key',
  principal,
)

function startFor(overrides: Partial<RuntimeStart> = {}): RuntimeStart {
  return {
    key: 'subject-key',
    layout,
    env: { DSH_HOME: layout.home, PATH: '/host/bin', ACME_API_KEY: 'sk-test' },
    publicHost: 'agent.example.com',
    canConfigureDsh: false,
    ...overrides,
  }
}

interface EngineCall {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

/** A Docker Engine that records every call and plays a normal happy path. */
function fakeEngine(behaviour: { firstCreateConflicts?: boolean; waitNever?: boolean } = {}) {
  const calls: EngineCall[] = []
  let creates = 0
  let resolveWait: (() => void) | undefined
  const logFrame = (kind: number, text: string): Buffer => {
    const payload = Buffer.from(text)
    const head = Buffer.alloc(8)
    head[0] = kind
    head.writeUInt32BE(payload.byteLength, 4)
    return Buffer.concat([head, payload])
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      calls.push({ method: request.method ?? '', url: request.url ?? '', body: raw === '' ? undefined : JSON.parse(raw) })
      route(request, response)
    })
  })
  const route = (request: IncomingMessage, response: import('node:http').ServerResponse): void => {
    const url = request.url ?? ''
    if (url.startsWith('/containers/create')) {
      creates += 1
      if (behaviour.firstCreateConflicts === true && creates === 1) {
        response.writeHead(409).end(JSON.stringify({ message: 'name already in use' }))
        return
      }
      response.writeHead(201).end(JSON.stringify({ Id: 'cid-1' }))
      return
    }
    if (url.endsWith('/start')) { response.writeHead(204).end(); return }
    if (url.endsWith('/json')) {
      response.writeHead(200).end(JSON.stringify({
        NetworkSettings: { Networks: { 'agent-net': { IPAddress: '172.30.0.7' } } },
      }))
      return
    }
    if (url.includes('/wait')) {
      if (behaviour.waitNever === true) {
        resolveWait = () => { response.writeHead(200).end(JSON.stringify({ StatusCode: 0 })) }
        return
      }
      response.writeHead(200).end(JSON.stringify({ StatusCode: 3 }))
      return
    }
    if (url.includes('/logs')) {
      response.writeHead(200).end(Buffer.concat([
        logFrame(1, 'booting\n'),
        logFrame(2, 'provider has an empty baseURL\n'),
      ]))
      return
    }
    if (url.includes('/stop') || request.method === 'DELETE') { response.writeHead(204).end(); return }
    response.writeHead(500).end()
  }
  return {
    calls,
    finishWait: () => { resolveWait?.() },
    listen: async (): Promise<string> => {
      await new Promise<void>(resolveListen => { server.listen(0, '127.0.0.1', resolveListen) })
      return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    },
    close: async (): Promise<void> => {
      server.closeAllConnections()
      await new Promise<void>(resolveClose => { server.close(() => { resolveClose() }) })
    },
  }
}

let engine: ReturnType<typeof fakeEngine>

beforeEach(() => { engine = fakeEngine({ waitNever: true }) })
afterEach(async () => { engine.finishWait(); await engine.close() })

async function backendFor(engineUrl: string) {
  return new ContainerRuntimeBackend({
    image: 'acme/agent-runtime:dev',
    docker: engineUrl,
    network: 'agent-net',
    cli: '/opt/harness/apps/cli/lib/bin.js',
  })
}

function createBody(calls: readonly EngineCall[]): Record<string, unknown> & {
  Env: string[]
  Cmd: string[]
  HostConfig: { Binds: string[]; NetworkMode: string; CapDrop: string[]; Runtime?: string }
} {
  const call = calls.find(({ url }) => url.startsWith('/containers/create'))
  expect(call).toBeDefined()
  return call?.body as ReturnType<typeof createBody>
}

describe('container runtime backend', () => {
  it('creates a hardened container on the runtime network and targets its address', async () => {
    const backend = await backendFor(await engine.listen())
    const handle = await backend.start(startFor())
    expect(handle.target).toBe('http://172.30.0.7:3082')

    const body = createBody(engine.calls)
    expect(body.Image).toBe('acme/agent-runtime:dev')
    expect(body.HostConfig.NetworkMode).toBe('agent-net')
    expect(body.HostConfig.CapDrop).toEqual(['ALL'])
    // No published ports: the only road to a Runtime runs through the gateway.
    expect(JSON.stringify(body)).not.toContain('PortBindings')
  })

  it('mounts the runtime tree writable and the tenant tree read-only for ordinary users', async () => {
    const backend = await backendFor(await engine.listen())
    await backend.start(startFor())
    const { HostConfig } = createBody(engine.calls)
    expect(HostConfig.Binds).toContain(`${layout.root}:/dsh/runtime`)
    expect(HostConfig.Binds).toContain(`${layout.tenantConfigDir}:/dsh/tenant:ro`)
  })

  it('lets a platform administrator write the tenant tree', async () => {
    const backend = await backendFor(await engine.listen())
    await backend.start(startFor({ canConfigureDsh: true }))
    const { HostConfig } = createBody(engine.calls)
    expect(HostConfig.Binds).toContain(`${layout.tenantConfigDir}:/dsh/tenant`)
  })

  it('rewrites host paths in the environment and drops the host PATH', async () => {
    const backend = await backendFor(await engine.listen())
    await backend.start(startFor())
    const { Env } = createBody(engine.calls)
    expect(Env).toContain('DSH_HOME=/dsh/runtime/home')
    expect(Env).toContain('ACME_API_KEY=sk-test')
    // The host's PATH names host directories; inside the image it only breaks
    // executable lookup.
    expect(Env.some(entry => entry.startsWith('PATH='))).toBe(false)
  })

  it('replaces a stale container left by a previous gateway instead of adopting it', async () => {
    engine.finishWait()
    await engine.close()
    engine = fakeEngine({ firstCreateConflicts: true, waitNever: true })
    const backend = await backendFor(await engine.listen())
    const handle = await backend.start(startFor())
    expect(handle.target).toBe('http://172.30.0.7:3082')
    const methods = engine.calls.map(({ method, url }) => `${method} ${url.split('?')[0] ?? ''}`)
    // create (409) → remove by name → create again.
    expect(methods.filter(entry => entry === 'POST /containers/create')).toHaveLength(2)
    expect(methods).toContain('DELETE /containers/dsh-runtime-subject-key')
  })

  it('reports the exit status from the Engine wait channel', async () => {
    engine.finishWait()
    await engine.close()
    engine = fakeEngine()
    const backend = await backendFor(await engine.listen())
    const handle = await backend.start(startFor())
    await expect(handle.exited).resolves.toBe(3)
    expect(handle.exitCause()).toBe(3)
  })

  it('fetches and demultiplexes the container log tail', async () => {
    const backend = await backendFor(await engine.listen())
    const handle = await backend.start(startFor())
    const lines = await handle.logTail(10)
    expect(lines).toContain('[stdout] booting')
    expect(lines).toContain('[stderr] provider has an empty baseURL')
  })

  it('stop() stops and removes the container', async () => {
    const backend = await backendFor(await engine.listen())
    const handle = await backend.start(startFor())
    await handle.stop()
    const urls = engine.calls.map(({ url }) => url)
    expect(urls.some(url => url.includes('/stop'))).toBe(true)
    expect(urls.some(url => url.includes('force=true'))).toBe(true)
    expect(handle.exitCause()).not.toBeNull()
  })
})

describe('container command', () => {
  it('keeps the Harness on loopback and bridges the container IP to it', () => {
    // The Harness refuses --host 0.0.0.0 by design: an Agent runtime is remote
    // code execution and it will not bind a network interface itself. The
    // backend must respect that, not fight it — loopback Harness, in-container
    // forwarder on the published port.
    const [shell, flag, script] = containerCommand('/opt/harness/cli.js', 3082, 'agent.example.com')
    expect(shell).toBe('sh')
    expect(flag).toBe('-c')
    expect(script).toContain('--host 127.0.0.1')
    expect(script).toContain('--port 3081')
    expect(script).not.toContain('0.0.0.0",')
    expect(script).toContain('.listen(3082,"0.0.0.0")')
    expect(script).toContain('--trusted-host agent.example.com')
    // exec, so the Harness is PID-signal-reachable and its exit ends the container.
    expect(script).toContain('exec node /opt/harness/cli.js')
  })

  it('is what the created container actually runs', async () => {
    const backend = await backendFor(await engine.listen())
    await backend.start(startFor())
    const body = createBody(engine.calls)
    expect(body.Cmd).toEqual(containerCommand('/opt/harness/apps/cli/lib/bin.js', 3082, 'agent.example.com'))
  })
})

describe('environment translation', () => {
  it('rewrites values under a mapped prefix and leaves the rest alone', () => {
    const entries = translateEnvironment(
      { A: '/srv/users/k/home', B: '/srv/users/k', C: '/srv/users/k-other', D: 'plain' },
      [['/srv/users/k', '/dsh/runtime']],
    )
    expect(entries).toContain('A=/dsh/runtime/home')
    expect(entries).toContain('B=/dsh/runtime')
    // A sibling directory that merely shares the prefix string is not inside it.
    expect(entries).toContain('C=/srv/users/k-other')
    expect(entries).toContain('D=plain')
  })
})

describe('docker log demultiplexing', () => {
  it('strips frame headers and labels streams', () => {
    const frame = (kind: number, text: string): Buffer => {
      const payload = Buffer.from(text)
      const head = Buffer.alloc(8)
      head[0] = kind
      head.writeUInt32BE(payload.byteLength, 4)
      return Buffer.concat([head, payload])
    }
    const lines = demuxDockerLogs(Buffer.concat([frame(1, 'out line\n'), frame(2, 'err line\n')]))
    expect(lines).toEqual(['[stdout] out line', '[stderr] err line'])
  })
})
