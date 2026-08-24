/**
 * The container backend: one Runtime = one container.
 *
 * This is the hosted-deployment posture. The process backend isolates state
 * but not reach — every Runtime shares the gateway's kernel, uid and
 * filesystem, so nothing but file modes stands between one Subject's Agent and
 * another Subject's credentials. A container puts a kernel namespace and a
 * private mount set around each Runtime instead, and turns isolation strength
 * into deployment configuration: the same backend runs under `runc` today and
 * under gVisor or Kata tomorrow by naming a different `runtime`, the way
 * Kubernetes swaps isolation through a RuntimeClass.
 *
 * Talks to the Docker Engine API directly over HTTP — the same reasoning as
 * the gateway's own proxy: this component sits on a security boundary, the
 * API surface it needs is six endpoints, and a client library would be a
 * dependency tree with root-equivalent power. For the same reason, point
 * `docker` at a filtered socket proxy in production rather than the raw
 * socket: whoever holds the raw socket owns the host.
 *
 * Path translation is the backend's one edit to the environment it is handed.
 * The manager provisions and addresses everything by host paths; inside the
 * container those same trees appear at fixed mount points, so every
 * environment value under a mapped host prefix is rewritten to match. Mounting
 * and rewriting derive from one table, which is what keeps them from ever
 * disagreeing.
 */
import { request as httpRequest } from 'node:http'

import type { RuntimeBackend, RuntimeHandle, RuntimeStart } from './runtime-backend.js'

/** Where the per-Runtime tree and the tenant-shared tree appear in-container. */
const RUNTIME_MOUNT = '/dsh/runtime'
const TENANT_MOUNT = '/dsh/tenant'

export interface ContainerBackendOptions {
  /** Image every Runtime container starts from. */
  readonly image: string
  /**
   * Docker Engine API endpoint: a unix socket path (`/var/run/docker.sock`) or
   * an HTTP origin (`http://docker-proxy:2375`). Prefer a filtered proxy — the
   * raw socket is root on the host.
   */
  readonly docker: string
  /**
   * User-defined bridge network the Runtime containers join. The gateway must
   * be able to reach container IPs on it; Runtime ports are never published.
   */
  readonly network: string
  /** In-container path of the Harness CLI entry. */
  readonly cli: string
  /** Port the Runtime listens on inside its container. Default 3082. */
  readonly port?: number
  /** Container entrypoint override; defaults to the image's own. */
  readonly entrypoint?: readonly string[]
  /**
   * Extra bind mounts in Docker `host:container[:ro]` syntax — a shared
   * skill checkout, a CA bundle. Per-Runtime and tenant trees are mounted
   * automatically and do not belong here.
   */
  readonly extraBinds?: readonly string[]
  /** Container runtime name (`runsc`, `kata-runtime`); default the daemon's. */
  readonly runtime?: string
  /** Memory limit in bytes. Default 1 GiB. */
  readonly memoryBytes?: number
  /** PID limit. Default 256. */
  readonly pidsLimit?: number
}

interface DockerResponse {
  readonly status: number
  readonly body: Buffer
}

/** One Engine API call. `stream` bodies are read fully — none of ours are large. */
async function dockerCall(
  endpoint: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<DockerResponse> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const socket = endpoint.startsWith('/')
  const base = socket ? { socketPath: endpoint, path } : targetOf(endpoint, path)
  return await new Promise<DockerResponse>((resolveCall, reject) => {
    const request = httpRequest({
      ...base,
      method,
      headers: {
        host: 'docker',
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': payload.byteLength }),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        resolveCall({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) })
      })
      response.once('error', reject)
    })
    request.once('error', reject)
    request.end(payload)
  })
}

function targetOf(origin: string, path: string): { hostname: string; port: string; path: string } {
  const url = new URL(origin)
  return { hostname: url.hostname, port: url.port, path }
}

function expectOk(operation: string, response: DockerResponse, accept: readonly number[]): void {
  if (accept.includes(response.status)) return
  const detail = response.body.toString('utf8').slice(0, 300)
  throw new Error(`docker ${operation} failed (HTTP ${String(response.status)}): ${detail}`)
}

/**
 * Split a multiplexed Docker log stream into lines.
 *
 * Without a TTY the Engine frames output as an 8-byte header — stream type,
 * three zero bytes, a big-endian length — followed by that many payload bytes.
 * Concatenating the raw body would interleave those headers into the text.
 */
export function demuxDockerLogs(body: Buffer): string[] {
  const lines: string[] = []
  let offset = 0
  while (offset + 8 <= body.length) {
    const kind = body[offset] === 2 ? 'stderr' : 'stdout'
    const size = body.readUInt32BE(offset + 4)
    const payload = body.subarray(offset + 8, offset + 8 + size).toString('utf8')
    for (const line of payload.split('\n').filter(Boolean)) lines.push(`[${kind}] ${line}`)
    offset += 8 + size
  }
  return lines
}

/**
 * The environment, with every host path under a mapped prefix rewritten to the
 * container's mount point. `PATH` is dropped: it names host directories, and
 * handing it to the container breaks executable lookup against the image.
 */
export function translateEnvironment(
  env: NodeJS.ProcessEnv,
  mappings: ReadonlyArray<readonly [hostPrefix: string, containerPrefix: string]>,
): string[] {
  const entries: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name === 'PATH') continue
    let translated = value
    for (const [hostPrefix, containerPrefix] of mappings) {
      if (translated === hostPrefix) translated = containerPrefix
      else if (translated.startsWith(`${hostPrefix}/`)) translated = containerPrefix + translated.slice(hostPrefix.length)
    }
    entries.push(`${name}=${translated}`)
  }
  return entries
}

export class ContainerRuntimeBackend implements RuntimeBackend {
  readonly isolation = 'dedicated-container'

  constructor(private readonly options: ContainerBackendOptions) {}

  async start(start: RuntimeStart): Promise<RuntimeHandle> {
    const { options } = this
    const port = options.port ?? 3082
    const name = `dsh-runtime-${start.key}`
    const mappings: ReadonlyArray<readonly [string, string]> = [
      [start.layout.root, RUNTIME_MOUNT],
      [start.layout.tenantConfigDir, TENANT_MOUNT],
    ]
    const create = {
      Image: options.image,
      Env: translateEnvironment(start.env, mappings),
      Cmd: [
        'node', options.cli,
        '--profile', 'web',
        '--host', '0.0.0.0',
        '--port', String(port),
        '--trusted-host', start.publicHost,
        '--no-open',
      ],
      ...(options.entrypoint === undefined ? {} : { Entrypoint: [...options.entrypoint] }),
      WorkingDir: translatePath(start.layout.workspace, mappings),
      Labels: { 'dshserver.runtime-key': start.key },
      HostConfig: {
        Binds: [
          `${start.layout.root}:${RUNTIME_MOUNT}`,
          // Read-only unless this Subject administers the platform: "ordinary
          // users cannot reconfigure models or credentials" becomes a mount
          // fact instead of a UI promise.
          `${start.layout.tenantConfigDir}:${TENANT_MOUNT}${start.canConfigureDsh ? '' : ':ro'}`,
          ...(options.extraBinds ?? []),
        ],
        NetworkMode: options.network,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: options.memoryBytes ?? 1_073_741_824,
        PidsLimit: options.pidsLimit ?? 256,
        RestartPolicy: { Name: 'no' },
        ...(options.runtime === undefined ? {} : { Runtime: options.runtime }),
      },
    }

    let created = await dockerCall(options.docker, 'POST', `/containers/create?name=${name}`, create)
    if (created.status === 409) {
      // A container by this name survived a previous gateway. It is not this
      // start's runtime — its policy and lease are stale — so replace it.
      expectOk('remove stale container', await dockerCall(options.docker, 'DELETE', `/containers/${name}?force=true`), [204, 404])
      created = await dockerCall(options.docker, 'POST', `/containers/create?name=${name}`, create)
    }
    expectOk('create container', created, [201])
    const id = (JSON.parse(created.body.toString('utf8')) as { Id: string }).Id

    expectOk('start container', await dockerCall(options.docker, 'POST', `/containers/${id}/start`), [204])

    const inspected = await dockerCall(options.docker, 'GET', `/containers/${id}/json`)
    expectOk('inspect container', inspected, [200])
    const details = JSON.parse(inspected.body.toString('utf8')) as {
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
    }
    const address = details.NetworkSettings?.Networks?.[options.network]?.IPAddress
    if (address === undefined || address === '') {
      await dockerCall(options.docker, 'DELETE', `/containers/${id}?force=true`).catch(() => undefined)
      throw new Error(`container ${name} has no address on network ${options.network}`)
    }

    let cause: number | string | null = null
    const exited = dockerCall(options.docker, 'POST', `/containers/${id}/wait?condition=not-running`)
      .then(response => {
        const status = (JSON.parse(response.body.toString('utf8')) as { StatusCode?: number }).StatusCode
        cause = typeof status === 'number' ? status : 'exit'
        return cause
      })
      .catch((): number | string | null => {
        // The wait channel failing does not mean the runtime died; report
        // nothing rather than a fabricated exit.
        return cause
      })

    return {
      target: `http://${address}:${String(port)}`,
      exitCause: () => cause,
      exited,
      logTail: async lines => {
        try {
          const logs = await dockerCall(options.docker, 'GET', `/containers/${id}/logs?stdout=true&stderr=true&tail=${String(lines)}`)
          return demuxDockerLogs(logs.body).slice(-lines)
        } catch (error) {
          return [`(container logs unavailable: ${error instanceof Error ? error.message : String(error)})`]
        }
      },
      stop: async () => {
        // Engine-side stop is SIGTERM, a grace period, then SIGKILL — the same
        // ladder the process backend climbs by hand.
        await dockerCall(options.docker, 'POST', `/containers/${id}/stop?t=5`).catch(() => undefined)
        await dockerCall(options.docker, 'DELETE', `/containers/${id}?force=true`).catch(() => undefined)
        if (cause === null) cause = 'stopped'
      },
    }
  }
}

function translatePath(
  path: string,
  mappings: ReadonlyArray<readonly [hostPrefix: string, containerPrefix: string]>,
): string {
  for (const [hostPrefix, containerPrefix] of mappings) {
    if (path === hostPrefix) return containerPrefix
    if (path.startsWith(`${hostPrefix}/`)) return containerPrefix + path.slice(hostPrefix.length)
  }
  return path
}
