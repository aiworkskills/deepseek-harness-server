import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { GatewayPrincipal, RuntimeLeaseIssuer, RuntimePrincipal } from './types.js'
import { policyFingerprint, runtimeKey } from './runtime-identity.js'
import {
  assertBuiltArtifacts, provisionRuntimeHome, runtimeEnvironment, runtimeLayout,
} from './runtime-provision.js'

export interface RuntimeRecord {
  readonly id: string
  readonly key: string
  readonly principal: GatewayPrincipal
  readonly policyFingerprint: string
  readonly port: number
  readonly target: string
  readonly home: string
  readonly workspace: string
  managedWorkspaceId: string
  readonly leaseFile: string
  readonly child: ChildProcess
  readonly startedAt: number
  lastUsedAt: number
  leaseExpiresAt: number
  leaseRefresh: Promise<void> | undefined
  status: 'starting' | 'ready' | 'stopping' | 'failed'
  readonly logs: string[]
}

export interface RuntimeView {
  readonly id: string
  readonly status: RuntimeRecord['status']
  readonly startedAt: string
  readonly lastUsedAt: string
  readonly isolation: 'dedicated-process-and-home'
  readonly preset: string
}

export interface RuntimeManagerOptions {
  readonly projectRoot: string
  readonly dshSourceRoot: string
  readonly runtimeRoot: string
  readonly internalOrigin: string
  readonly publicHost: string
  readonly idleMs: number
  readonly disabled: boolean
  readonly exposedSettingsNamespaces: readonly string[]
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || address === null) {
        server.close()
        reject(new Error('failed to allocate a runtime port'))
        return
      }
      const port = address.port
      server.close(error => error === undefined ? resolvePort(port) : reject(error))
    })
  })
}

async function waitForReady(record: RuntimeRecord): Promise<void> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (record.child.exitCode !== null) {
      throw new Error(`DSH Runtime exited during startup (${record.child.exitCode}): ${record.logs.slice(-8).join('\n')}`)
    }
    try {
      const response = await fetch(record.target, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch {
      // Startup polling expects connection failures until the webserver binds.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  }
  throw new Error(`DSH Runtime did not become ready: ${record.logs.slice(-8).join('\n')}`)
}

async function ensureManagedWorkspace(record: RuntimeRecord): Promise<string> {
  const rpcId = `bootstrap-workspace-${record.key}`
  const deadline = Date.now() + 10_000
  let lastFailure = 'DSH API did not become ready'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${record.target}/api/workspace.create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'workspace.create',
          payload: { path: record.workspace },
        }),
        signal: AbortSignal.timeout(1_000),
      })
      const raw = await response.text()
      if (!response.ok) {
        lastFailure = `HTTP ${String(response.status)}: ${raw.slice(0, 160)}`
      } else {
        const body = JSON.parse(raw) as {
          result?: {
            ok?: boolean
            value?: { workspace?: { workspaceId?: string } }
            error?: { message?: string }
          }
        }
        if (body.result?.ok === true) {
          const workspaceId = body.result.value?.workspace?.workspaceId
          if (typeof workspaceId === 'string' && workspaceId.length > 0) return workspaceId
          lastFailure = 'successful response omitted workspaceId'
        } else {
          lastFailure = body.result?.error?.message ?? 'workspace.create returned an error'
        }
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  }
  throw new Error(`failed to provision managed DSH workspace: ${lastFailure}`)
}

/** Starts one isolated DSH process and DSH_HOME per verified OAuth Subject. */
export class RuntimeManager {
  private readonly runtimes = new Map<string, RuntimeRecord>()
  private readonly starting = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RuntimeRecord> }>()
  private readonly sweepTimer: NodeJS.Timeout

  constructor(
    private readonly authority: RuntimeLeaseIssuer,
    private readonly options: RuntimeManagerOptions,
  ) {
    this.sweepTimer = setInterval(() => { void this.sweepIdle() }, Math.min(60_000, Math.max(5_000, options.idleMs / 3)))
    this.sweepTimer.unref()
  }

  async runtime(principal: RuntimePrincipal): Promise<RuntimeRecord> {
    if (this.options.disabled) throw new Error('DSH Runtime is disabled by DSH_RUNTIME_DISABLED')
    const key = runtimeKey(principal)
    const fingerprint = policyFingerprint(principal)
    const existing = this.runtimes.get(key)
    if (existing !== undefined && existing.policyFingerprint === fingerprint && existing.status === 'ready') {
      existing.lastUsedAt = Date.now()
      if (existing.leaseExpiresAt <= Date.now() + 60_000) await this.refreshLease(existing, principal)
      return existing
    }
    if (existing !== undefined) await this.stop(existing)
    const pending = this.starting.get(key)
    if (pending !== undefined) {
      if (pending.fingerprint === fingerprint) return await pending.promise
      try { await pending.promise } catch { /* The replacement start below owns the next error. */ }
      return await this.runtime(principal)
    }
    const start = this.startRuntime(key, fingerprint, principal)
    this.starting.set(key, { fingerprint, promise: start })
    try {
      return await start
    } finally {
      if (this.starting.get(key)?.promise === start) this.starting.delete(key)
    }
  }

  view(principal: RuntimePrincipal): RuntimeView | undefined {
    const key = runtimeKey(principal)
    const record = this.runtimes.get(key)
    if (record === undefined) return undefined
    return {
      id: record.id,
      status: record.status,
      startedAt: new Date(record.startedAt).toISOString(),
      lastUsedAt: new Date(record.lastUsedAt).toISOString(),
      isolation: 'dedicated-process-and-home',
      preset: principal.presetRole,
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer)
    await Promise.all([...this.runtimes.values()].map(async record => { await this.stop(record) }))
  }

  private async startRuntime(key: string, policyFingerprint: string, principal: RuntimePrincipal): Promise<RuntimeRecord> {
    const defaultModel = principal.models[0]
    if (defaultModel === undefined) throw new Error('Runtime has no deployment-approved model')
    const layout = runtimeLayout(this.options, key, principal)
    await provisionRuntimeHome(layout, this.options.projectRoot, key, principal.presetRole)
    await assertBuiltArtifacts(layout)

    const port = await availablePort()
    const child = spawn(process.execPath, [
      layout.cli,
      '--profile', 'web',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--trusted-host', this.options.publicHost,
    ], {
      cwd: layout.workspace,
      env: runtimeEnvironment({
        layout,
        principal,
        defaultModel,
        internalOrigin: this.options.internalOrigin,
        exposedSettingsNamespaces: this.options.exposedSettingsNamespaces,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const record: RuntimeRecord = {
      id: `runtime-${key}`,
      key,
      principal,
      policyFingerprint,
      port,
      target: `http://127.0.0.1:${port}`,
      home: layout.home,
      workspace: layout.workspace,
      managedWorkspaceId: '',
      leaseFile: layout.leaseFile,
      child,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      leaseExpiresAt: 0,
      leaseRefresh: undefined,
      status: 'starting',
      logs: [],
    }
    this.runtimes.set(key, record)
    const append = (source: string, chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        record.logs.push(`[${source}] ${line}`)
      }
      if (record.logs.length > 200) record.logs.splice(0, record.logs.length - 200)
    }
    child.stdout?.on('data', (chunk: Buffer) => { append('stdout', chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { append('stderr', chunk) })
    child.once('exit', () => {
      if (record.status !== 'stopping') record.status = 'failed'
      if (this.runtimes.get(key) === record && record.status === 'failed') this.runtimes.delete(key)
    })
    await this.refreshLease(record, principal)
    try {
      await waitForReady(record)
      record.managedWorkspaceId = await ensureManagedWorkspace(record)
      record.status = 'ready'
      return record
    } catch (error) {
      record.status = 'failed'
      await this.stop(record)
      throw error
    }
  }

  private async refreshLease(record: RuntimeRecord, principal: GatewayPrincipal): Promise<void> {
    if (record.leaseRefresh !== undefined) return await record.leaseRefresh
    const refresh = (async () => {
      const lease = await this.authority.issueRuntimeLease(principal, record.id)
      const temporary = `${record.leaseFile}.next`
      await writeFile(temporary, `${lease}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, record.leaseFile)
      record.leaseExpiresAt = Date.now() + 5 * 60_000
    })()
    record.leaseRefresh = refresh
    try {
      await refresh
    } finally {
      if (record.leaseRefresh === refresh) record.leaseRefresh = undefined
    }
  }

  private async sweepIdle(): Promise<void> {
    const expired = [...this.runtimes.values()].filter(record => Date.now() - record.lastUsedAt >= this.options.idleMs)
    await Promise.all(expired.map(async record => { await this.stop(record) }))
  }

  private async stop(record: RuntimeRecord): Promise<void> {
    if (record.status === 'stopping') return
    record.status = 'stopping'
    if (record.child.exitCode === null && record.child.signalCode === null) {
      record.child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>(resolveExit => record.child.once('exit', () => { resolveExit() })),
        new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
      ])
      if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL')
    }
    if (this.runtimes.get(record.key) === record) this.runtimes.delete(record.key)
  }
}

function parseExposedSettingsNamespaces(raw: string | undefined): readonly string[] {
  let configured: unknown = []
  try {
    configured = JSON.parse(raw ?? '[]')
  } catch {
    throw new Error('DSHSERVER_EXPOSED_SETTINGS_NAMESPACES must be a JSON array of strings')
  }
  if (!Array.isArray(configured) || configured.some(value => typeof value !== 'string')) {
    throw new Error('DSHSERVER_EXPOSED_SETTINGS_NAMESPACES must be a JSON array of strings')
  }
  return configured as string[]
}

export function defaultRuntimeOptions(projectRoot: string, publicOrigin: string, internalOrigin = publicOrigin): RuntimeManagerOptions {
  const dshSourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? join(projectRoot, '..', 'deepseek-harness'))
  return {
    projectRoot,
    dshSourceRoot,
    runtimeRoot: join(projectRoot, '.runtime', 'users'),
    internalOrigin,
    publicHost: new URL(publicOrigin).host,
    idleMs: Number(process.env.DSH_RUNTIME_IDLE_MS ?? 15 * 60_000),
    disabled: process.env.DSH_RUNTIME_DISABLED === '1',
    exposedSettingsNamespaces: parseExposedSettingsNamespaces(process.env.DSHSERVER_EXPOSED_SETTINGS_NAMESPACES),
  }
}
