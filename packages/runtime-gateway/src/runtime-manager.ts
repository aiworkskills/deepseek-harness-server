import { request as httpRequest } from 'node:http'
import { chmod, rename, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import type { GatewayPrincipal, RuntimeLeaseIssuer, RuntimePrincipal } from './types.js'
import type { RuntimeBackend, RuntimeHandle } from './runtime-backend.js'
import { ProcessRuntimeBackend } from './backend-process.js'
import { policyFingerprint, runtimeKey } from './runtime-identity.js'
import {
  assertBuiltArtifacts, inspectTenantConfig, provisionRuntimeHome, runtimeEnvironment, runtimeLayout,
  type RuntimeLayout, type RuntimeLayoutOptions,
} from './runtime-provision.js'

export interface RuntimeRecord {
  readonly id: string
  readonly key: string
  readonly principal: GatewayPrincipal
  readonly policyFingerprint: string
  readonly target: string
  readonly home: string
  readonly workspace: string
  managedWorkspaceId: string
  readonly leaseFile: string
  readonly handle: RuntimeHandle
  /**
   * The Runtime's own browser-auth cookie, held on the Gateway's behalf.
   *
   * Since DSH 0.1.5 a Runtime authenticates its browser surface itself, so
   * every request the Gateway sends or forwards needs this. It is minted once
   * at startup and never travels to the browser: in a managed deployment the
   * user is already authenticated by the Gateway, and handing them a second
   * credential for the Runtime would be a way around it.
   *
   * Empty when the Runtime never announced a token — the Gateway then behaves
   * exactly as it did before 0.1.5, which is the right posture for a Runtime
   * that does not ask for one.
   */
  runtimeCookie: string
  readonly startedAt: number
  lastUsedAt: number
  /**
   * Live proxied connections — open SSE responses and upgraded sockets.
   *
   * `lastUsedAt` alone cannot answer "is this Runtime in use". It moves only
   * when the gateway resolves a Runtime for a NEW request, and a working agent
   * generates none: the browser is holding a stream opened minutes ago, the
   * model calls go outbound from the Runtime, and the tools run inside it. So a
   * turn that takes longer than `idleMs` looked exactly like an abandoned one,
   * and the sweep destroyed the container mid-task.
   *
   * A connection is the honest signal: someone is attached right now. The idle
   * clock restarts when the last one goes away.
   */
  connections: number
  leaseExpiresAt: number
  leaseRefresh: Promise<void> | undefined
  status: 'starting' | 'ready' | 'stopping' | 'failed'
}

export interface RuntimeView {
  readonly id: string
  readonly status: RuntimeRecord['status']
  readonly startedAt: string
  readonly lastUsedAt: string
  /** Named by the backend: what stands between this Runtime and its neighbours. */
  readonly isolation: string
  readonly preset: string
}

export interface RuntimeManagerOptions extends RuntimeLayoutOptions {
  readonly internalOrigin: string
  readonly publicHost: string
  readonly idleMs: number
  readonly disabled: boolean
  /**
   * Where Runtimes execute. Defaults to child processes of the gateway — right
   * for one operator's machine, wrong for hosting strangers, and deliberately a
   * deployment decision rather than this library's.
   */
  readonly backend?: RuntimeBackend
  readonly log?: (message: string) => void
}

function defaultLog(message: string): void {
  process.stdout.write(`DSH Gateway: ${message}\n`)
}

/**
 * 启动失败时回传多少行子进程输出。
 *
 * 八行连一条 Node 栈回溯都装不下 —— 真正说明原因的那句往往在更前面,于是报错里
 * 只剩下栈尾,看不出是什么坏了。记录本身保留 200 行,这里取一个够读完一次失败、
 * 又不至于把日志淹掉的数。
 */
const STARTUP_LOG_LINES = 40

/**
 * How long a Runtime Lease stays good for.
 *
 * A mirror of what the authority signs, not an instruction to it — the `exp`
 * inside the JWT is what decides. Keep the two in step: a mirror that runs long
 * has us believing a lease is alive after the business API has stopped taking
 * it, which surfaces as an unexplained `令牌已过期` on every tool call.
 */
const LEASE_MS = 5 * 60_000

/**
 * Renew this far ahead of expiry.
 *
 * Wide enough that several sweeps land inside it, so one failed round trip to
 * the authority is not the last chance before the lease lapses.
 */
const LEASE_MARGIN_MS = 2 * 60_000

/** How often to look for leases due for renewal. Comfortably under the margin. */
const LEASE_SWEEP_MS = 30_000

/**
 * What we ask a starting Runtime, and why it is not `/`.
 *
 * The question here is only "is the webserver bound and serving" — whether the
 * API answers is settled right after, by the workspace bootstrap and its own
 * retry loop. `/` cannot answer it: the web profile mints a startup token and
 * refuses every request without one, so an unauthenticated `GET /` is 401 no
 * matter how ready the Runtime is, and this loop would spend its whole deadline
 * on a Runtime that came up fine. The Gateway never sees that token — it is
 * printed on the Runtime's stdout for a human.
 *
 * The manifest is the one thing served without credentials, and not by accident:
 * browsers fetch a web app manifest uncredentialed by spec, so DSH has to leave
 * it open. That makes it a stable thing to knock on.
 */
const READY_PROBE_PATH = '/manifest.webmanifest'

async function waitForReady(record: RuntimeRecord): Promise<void> {
  const deadline = Date.now() + 45_000
  const probe = new URL(READY_PROBE_PATH, record.target).toString()
  while (Date.now() < deadline) {
    const cause = record.handle.exitCause()
    if (cause !== null) {
      throw new Error(`DSH Runtime exited during startup (${String(cause)}): ${(await record.handle.logTail(STARTUP_LOG_LINES)).join('\n')}`)
    }
    try {
      const response = await fetch(probe, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch {
      // Startup polling expects connection failures until the webserver binds.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  }
  throw new Error(`DSH Runtime did not become ready: ${(await record.handle.logTail(STARTUP_LOG_LINES)).join('\n')}`)
}


/**
 * One request to a Runtime with an explicit `Host`.
 *
 * `node:http`, not `fetch`, and that is the whole reason this exists: `fetch`
 * silently drops a `Host` header, and this Host is load-bearing. DSH names its
 * browser-auth cookie `dsh-auth-<sha256(authority)>` and signs the authority
 * into the payload, where the authority is exactly this header. The Gateway
 * proxies a browser request with the *caller's* Host — the public origin — so a
 * cookie minted under the address the socket happens to use (a container name,
 * or loopback) is a cookie under a different name, and every proxied request
 * comes back 401 with DSH's own "reopen the URL printed by dsh web".
 * @param target - origin the socket connects to.
 * @param path - request path.
 * @param options - method, the Host to present, an optional cookie and body.
 * @returns status and body text.
 */
async function runtimeRequest(
  target: string,
  path: string,
  options: {
    readonly method: string
    readonly host: string
    readonly cookie?: string
    readonly body?: string
    readonly timeoutMs: number
  },
): Promise<{ status: number; body: string; setCookie: readonly string[] }> {
  const upstream = new URL(path, target)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      path: `${upstream.pathname}${upstream.search}`,
      method: options.method,
      headers: {
        host: options.host,
        ...(options.cookie === undefined || options.cookie === '' ? {} : { cookie: options.cookie }),
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(options.body)) }),
      },
      timeout: options.timeoutMs,
    }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: text,
          setCookie: response.headers['set-cookie'] ?? [],
        })
      })
    })
    request.on('timeout', () => { request.destroy(new Error('runtime request timed out')) })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/**
 * Trade the Runtime's startup token for its browser-auth cookie.
 *
 * The cookie DSH mints is bound to the authority that asked for it, and the
 * authority the Runtime will see afterwards is the Gateway's public host — the
 * proxy forwards the caller's `Host`, which is what the Runtime builds its own
 * links from. So the handshake has to present that same host, not the loopback
 * address the socket actually goes to. This is also why the Runtime is launched
 * with `--trusted-host <publicHost>`: without it DSH refuses the authority.
 *
 * Failure is not fatal. A Runtime that announces no token is a Runtime that
 * does not authenticate, and the caller carries on unauthenticated — the shape
 * every DSH before 0.1.5 had.
 * @param record - the started Runtime.
 * @param publicHost - authority the Gateway is reached at.
 * @returns the `Cookie` header value, or an empty string when there is none.
 */
async function acquireRuntimeCookie(
  record: RuntimeRecord,
  publicHost: string,
  log: ((message: string) => void) | undefined,
): Promise<string> {
  const token = await record.handle.startupToken()
  if (token === undefined) {
    // Worth saying out loud. Without a token there is no cookie, and without a
    // cookie every request answers 401 — an error that names the symptom and
    // hides this cause completely.
    log?.('DSH Gateway: Runtime announced no startup token; requests will be unauthenticated')
    return ''
  }
  try {
    const response = await runtimeRequest(record.target, `/?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      // The public authority, not the one the socket uses: see `runtimeRequest`.
      host: publicHost,
      timeoutMs: 5_000,
    })
    // Only the name=value pair travels on: attributes like Path and HttpOnly
    // describe how a browser should store it, and this is not a browser.
    const pairs = response.setCookie.map(entry => entry.split(';', 1)[0]).filter(Boolean)
    if (pairs.length === 0) {
      log?.(`DSH Gateway: browser-auth handshake set no cookie (HTTP ${String(response.status)})`)
    }
    return pairs.join('; ')
  } catch (error) {
    log?.(`DSH Gateway: browser-auth handshake failed: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

async function ensureManagedWorkspace(record: RuntimeRecord, publicHost: string): Promise<string> {
  const rpcId = `bootstrap-workspace-${record.key}`
  const deadline = Date.now() + 10_000
  let lastFailure = 'DSH API did not become ready'
  while (Date.now() < deadline) {
    try {
      const response = await runtimeRequest(record.target, '/api/workspace/create', {
        method: 'POST',
        // Same authority the cookie was minted under; DSH checks the two agree.
        host: publicHost,
        cookie: record.runtimeCookie,
        // `args` is keyed by the method's own parameter names, not by the
        // request's fields: `WorkspaceController.create(request)` takes one
        // parameter called `request`, so the envelope nests one level deeper
        // than it looks like it should.
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'workspace/create',
          payload: { args: { request: { path: record.workspace } } },
        }),
        timeoutMs: 5_000,
      })
      const raw = response.body
      if (response.status < 200 || response.status >= 300) {
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
    // A Runtime that answered the readiness probe can still die before this
    // call lands. Without this check every remaining attempt reports a bare
    // connection failure, and the crash that caused it is never reported.
    const cause = record.handle.exitCause()
    if (cause !== null) {
      throw new Error(
        `DSH Runtime exited before its workspace was provisioned (${String(cause)}): `
        + (await record.handle.logTail(STARTUP_LOG_LINES)).join('\n'),
      )
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  }
  throw new Error(
    `failed to provision managed DSH workspace: ${lastFailure}\n${(await record.handle.logTail(STARTUP_LOG_LINES)).join('\n')}`,
  )
}

/** Starts one isolated DSH Runtime and DSH_HOME per verified OAuth Subject. */
export class RuntimeManager {
  private readonly runtimes = new Map<string, RuntimeRecord>()
  private readonly starting = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RuntimeRecord> }>()
  private readonly reportedTenants = new Set<string>()
  private readonly sweepTimer: NodeJS.Timeout
  private readonly leaseTimer: NodeJS.Timeout
  private readonly backend: RuntimeBackend

  constructor(
    private readonly authority: RuntimeLeaseIssuer,
    private readonly options: RuntimeManagerOptions,
  ) {
    this.backend = options.backend ?? new ProcessRuntimeBackend()
    this.sweepTimer = setInterval(() => { void this.sweepIdle() }, Math.min(60_000, Math.max(5_000, options.idleMs / 3)))
    this.sweepTimer.unref()
    this.leaseTimer = setInterval(() => { void this.sweepLeases() }, LEASE_SWEEP_MS)
    this.leaseTimer.unref()
  }

  async runtime(principal: RuntimePrincipal): Promise<RuntimeRecord> {
    if (this.options.disabled) throw new Error('DSH Runtime is disabled by DSH_RUNTIME_DISABLED')
    const key = runtimeKey(principal)
    const fingerprint = policyFingerprint(principal)
    const existing = this.runtimes.get(key)
    if (existing !== undefined && existing.policyFingerprint === fingerprint && existing.status === 'ready') {
      existing.lastUsedAt = Date.now()
      if (existing.leaseExpiresAt <= Date.now() + LEASE_MARGIN_MS) await this.refreshLease(existing, principal)
      return existing
    }
    // A start already in flight owns the runtime behind `existing`, which is
    // still 'starting'. Join it — stopping that record here would kill the
    // runtime the pending promise is waiting on.
    const pending = this.starting.get(key)
    if (pending !== undefined) {
      if (pending.fingerprint === fingerprint) return await pending.promise
      try { await pending.promise } catch { /* The replacement start below owns the next error. */ }
      return await this.runtime(principal)
    }
    if (existing !== undefined) await this.stop(existing)
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
      isolation: this.backend.isolation,
      preset: principal.presetRole,
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer)
    clearInterval(this.leaseTimer)
    await Promise.all([...this.runtimes.values()].map(async record => { await this.stop(record) }))
  }

  private async startRuntime(key: string, policyFingerprint: string, principal: RuntimePrincipal): Promise<RuntimeRecord> {
    const defaultModel = principal.models[0]
    if (defaultModel === undefined) throw new Error('Runtime has no deployment-approved model')
    const layout = runtimeLayout(this.options, key, principal)
    const provisioned = await provisionRuntimeHome(layout, key, principal.presetRole)
    await this.reportTenantConfig(layout, provisioned.seededModelDefaults)
    await assertBuiltArtifacts(layout)

    const handle = await this.backend.start({
      key,
      layout,
      env: runtimeEnvironment({
        layout,
        principal,
        defaultModel,
        internalOrigin: this.options.internalOrigin,
      }),
      publicHost: this.options.publicHost,
      canConfigureDsh: principal.canConfigureDsh,
    })
    const record: RuntimeRecord = {
      id: `runtime-${key}`,
      key,
      principal,
      policyFingerprint,
      target: handle.target,
      home: layout.home,
      workspace: layout.workspace,
      managedWorkspaceId: '',
      leaseFile: layout.leaseFile,
      handle,
      runtimeCookie: '',
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      connections: 0,
      leaseExpiresAt: 0,
      leaseRefresh: undefined,
      status: 'starting',
    }
    this.runtimes.set(key, record)
    void handle.exited.then(() => {
      if (record.status !== 'stopping') record.status = 'failed'
      if (this.runtimes.get(key) === record && record.status === 'failed') this.runtimes.delete(key)
    })
    await this.refreshLease(record, principal)
    try {
      await waitForReady(record)
      record.runtimeCookie = await acquireRuntimeCookie(record, this.options.publicHost, this.options.log)
      record.managedWorkspaceId = await ensureManagedWorkspace(record, this.options.publicHost)
      record.status = 'ready'
      return record
    } catch (error) {
      record.status = 'failed'
      await this.stop(record)
      throw error
    }
  }

  /**
   * Announce the tenant configuration directory once per process.
   *
   * An operator who changes `PUBLIC_ORIGIN` or swaps in the customer's IdP moves
   * the derived tenant key, and the only visible symptom is that administrator
   * settings and credentials appear to be gone. Naming the directory and the
   * orphans on startup makes that recoverable instead of mysterious.
   */
  private async reportTenantConfig(layout: RuntimeLayout, seededModelDefaults: boolean): Promise<void> {
    const key = basename(layout.tenantConfigDir)
    if (this.reportedTenants.has(key)) return
    this.reportedTenants.add(key)
    const log = this.options.log ?? defaultLog
    try {
      const report = await inspectTenantConfig(layout)
      const origin = this.options.tenantKey === undefined ? 'derived from the OAuth issuer and tenant id' : 'pinned by DSHSERVER_TENANT_KEY'
      log(`tenant configuration ${report.key} (${origin}) at ${report.directory}`)
      if (seededModelDefaults) log('profile has no administrator-owned entries yet; seeding deployment model defaults')
      if (report.configured || report.orphans.length === 0) return
      log(`WARNING: this tenant directory is empty while ${report.orphans.join(', ')} still hold configuration.`)
      log(`WARNING: set DSHSERVER_TENANT_KEY to reuse an existing directory, or move it to ${report.key}.`)
    } catch (error) {
      // Diagnostics must never block a Runtime start.
      log(`failed to inspect tenant configuration: ${error instanceof Error ? error.message : String(error)}`)
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
      record.leaseExpiresAt = Date.now() + LEASE_MS
    })()
    record.leaseRefresh = refresh
    try {
      await refresh
    } finally {
      if (record.leaseRefresh === refresh) record.leaseRefresh = undefined
    }
  }

  /**
   * Mark a Runtime as carrying one live connection; the returned function releases it.
   *
   * The release is idempotent — an upgraded socket can emit both `close` and an
   * error, and a double decrement would let the sweep reap a Runtime that still
   * has clients attached.
   */
  attach(record: RuntimeRecord): () => void {
    record.connections += 1
    let released = false
    return () => {
      if (released) return
      released = true
      record.connections -= 1
      // The idle clock starts when the last client leaves, not when it arrived.
      if (record.connections === 0) record.lastUsedAt = Date.now()
    }
  }

  /**
   * Keep the lease alive under a Runtime that is working.
   *
   * `runtime()` already tops a lease up, but it only runs when the gateway
   * resolves a Runtime for a NEW request — and a turn in flight generates none,
   * for exactly the reasons `connections` was introduced: the browser is holding
   * a stream opened minutes ago, the model calls go outbound from the Runtime,
   * and the tools run inside it. So a turn could outlive its own authorization.
   * Every business call failed with `令牌已过期` from the moment the lease
   * lapsed, and nothing inside the turn could renew it — the MCP client rereads
   * the lease file on every call, so it went on failing until the turn ended.
   *
   * Seen on a report task: six queries succeeded in the first two minutes, then
   * the lease sat unrenewed for another eight while the turn kept running.
   *
   * A live connection is the same signal `sweepIdle` already trusts, used here
   * for the same reason — someone is attached right now. With none, the lease
   * lapses on purpose and the idle sweep takes the Runtime away shortly after.
   *
   * @internal Exported for tests; the constructor's timer is the only caller in production.
   */
  async sweepLeases(): Promise<void> {
    const due = [...this.runtimes.values()].filter(record =>
      record.status === 'ready' && record.connections > 0
      && record.leaseExpiresAt <= Date.now() + LEASE_MARGIN_MS)
    await Promise.all(due.map(async record => {
      try {
        await this.refreshLease(record, record.principal)
      } catch (error) {
        // One bad round trip is not worth killing a working Runtime over: the
        // current lease is still good for up to LEASE_MARGIN_MS and the next
        // sweep tries again. Say so, though — a renewal that keeps failing is
        // otherwise invisible right up until the tools stop working.
        const log = this.options.log ?? defaultLog
        const cause = error instanceof Error ? error.message : String(error)
        log(`failed to renew the Runtime Lease for ${record.id}: ${cause}`)
      }
    }))
  }

  /** @internal Exported for tests; the constructor's timer is the only caller in production. */
  async sweepIdle(): Promise<void> {
    const expired = [...this.runtimes.values()].filter(record =>
      record.connections === 0 && Date.now() - record.lastUsedAt >= this.options.idleMs)
    await Promise.all(expired.map(async record => { await this.stop(record) }))
  }

  private async stop(record: RuntimeRecord): Promise<void> {
    if (record.status === 'stopping') return
    record.status = 'stopping'
    await record.handle.stop()
    if (this.runtimes.get(record.key) === record) this.runtimes.delete(record.key)
  }
}

export function defaultRuntimeOptions(projectRoot: string, publicOrigin: string, internalOrigin = publicOrigin): RuntimeManagerOptions {
  const dshSourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? join(projectRoot, '..', 'deepseek-harness'))
  const pinnedTenantKey = process.env.DSHSERVER_TENANT_KEY
  return {
    projectRoot,
    dshSourceRoot,
    runtimeRoot: join(projectRoot, '.runtime', 'users'),
    internalOrigin,
    publicHost: new URL(publicOrigin).host,
    idleMs: Number(process.env.DSH_RUNTIME_IDLE_MS ?? 15 * 60_000),
    disabled: process.env.DSH_RUNTIME_DISABLED === '1',
    ...(pinnedTenantKey === undefined || pinnedTenantKey.length === 0 ? {} : { tenantKey: pinnedTenantKey }),
  }
}
