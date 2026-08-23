/**
 * The Runtime Gateway as a runnable service.
 *
 * `@dshserver/runtime-gateway` manages Runtime processes but leaves the server
 * around them to the host, so every deployment ended up re-deriving the same
 * sequence from the integration guide: match the DSH paths, authenticate, widen
 * the identity with policy, refuse the locked RPCs, resolve the Runtime, rewrite
 * `session.create`, proxy. Getting that order wrong is a security bug rather than
 * a bug that shows up in testing, which is a poor thing to ask each deployment to
 * reimplement.
 *
 * Identity stays with the host: `authenticate` and `authorize` are supplied by
 * the caller, because the IAM and the policy control plane are the host's, not
 * this package's.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  blockedDshRpc,
  prepareSessionCreateBody,
  RuntimeManager,
  type GatewayPrincipal,
  type RuntimeLeaseIssuer,
  type RuntimeManagerOptions,
  type RuntimePrincipal,
  type RuntimeRecord,
} from '@dshserver/runtime-gateway'

import { isDshHttpPath, pathnameOf, runtimeTarget } from './paths.js'
import { endSocket, proxyHttp, proxyUpgrade, readBody } from './proxy.js'

/** Scope without which a Runtime is never started. */
const USE_SCOPE = 'assistant:use'

/** The RPC that binds a new session to the managed workspace and preset. */
const SESSION_CREATE_PATH = '/api/session.create'

/** Why a request was refused, for the deployment's audit log. */
export type GatewayDenial =
  | 'unauthenticated'
  | 'missing_assistant_scope'
  | 'managed_capability_locked'
  | 'runtime_unavailable'

export interface GatewayAuditEvent {
  readonly pathname: string
  readonly denial: GatewayDenial
  /** Absent when the request never authenticated. */
  readonly subject?: string
  /**
   * Why the Runtime could not be resolved, on `runtime_unavailable` only.
   *
   * A Runtime fails to start for reasons an operator has to see — a missing
   * build artifact, an unreadable preset, a profile the Harness loader rejects.
   * Reporting only the refusal leaves them with a 503 and nothing to act on.
   */
  readonly cause?: unknown
}

export interface GatewayServerOptions {
  /**
   * Verify the request against the host's IAM and return the identity it proves,
   * or `undefined` when it proves none. Never throws for an ordinary failed
   * authentication — that is what `undefined` means.
   */
  readonly authenticate: (request: IncomingMessage) => Promise<GatewayPrincipal | undefined>
  /**
   * Widen a verified identity with deployment policy: preset role, effective
   * tools, allowed models, configuration rights.
   *
   * `tools` must already be the intersection of role policy, user policy and
   * granted scopes. This package forwards the result; it does not narrow it.
   */
  readonly authorize: (principal: GatewayPrincipal) => Promise<RuntimePrincipal>
  /** Signs the short-lived Runtime Lease each Runtime executes under. */
  readonly authority: RuntimeLeaseIssuer
  readonly runtime: RuntimeManagerOptions
  /** Called for every refusal. Denials are otherwise silent. */
  readonly onDenied?: (event: GatewayAuditEvent) => void
}

/**
 * Serves the embedded DSH UI for authenticated users, one Runtime per Subject.
 *
 * Both entry points return `false` when the path is not DSH's, so the host keeps
 * serving its own routes and this composes with an existing application rather
 * than replacing it.
 */
export class GatewayServer {
  private readonly runtimes: RuntimeManager

  constructor(private readonly options: GatewayServerOptions) {
    this.runtimes = new RuntimeManager(options.authority, options.runtime)
  }

  /** The underlying manager, for health reporting and administrative views. */
  get manager(): RuntimeManager {
    return this.runtimes
  }

  /**
   * Handle one request.
   * @returns `false` when the path belongs to the host application.
   */
  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const pathname = pathnameOf(request.url)
    if (!isDshHttpPath(pathname)) return false

    const resolved = await this.resolve(request, pathname)
    if ('denial' in resolved) {
      respond(response, statusFor(resolved.denial), resolved.denial)
      return true
    }

    // Read and rewrite before proxying: the body decides which workspace and
    // preset the session binds to, and a client is not trusted to choose either.
    let body: Buffer | undefined
    if (pathname === SESSION_CREATE_PATH) {
      try {
        body = prepareSessionCreateBody(await readBody(request), resolved.runtime)
      } catch (error) {
        respond(response, 400, error instanceof Error ? error.message : 'invalid session.create')
        return true
      }
    }

    try {
      await proxyHttp(request, response, {
        target: resolved.runtime.target,
        path: runtimeTarget(request.url),
        ...(body === undefined ? {} : { body }),
      })
    } catch {
      // A Runtime that died between resolution and connect leaves the client
      // waiting on a response nobody will send. Answer instead of hanging.
      if (!response.headersSent) respond(response, 502, 'runtime_unreachable')
      else response.destroy()
    }
    return true
  }

  /**
   * Handle one WebSocket upgrade under the same policy as a request.
   *
   * The event channels carry the whole session, so an upgrade that skipped these
   * checks would hand out unauthenticated access to everything the HTTP path
   * guards.
   * @returns `false` when the path belongs to the host application.
   */
  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const pathname = pathnameOf(request.url)
    if (!isDshHttpPath(pathname)) return false

    const resolved = await this.resolve(request, pathname)
    if ('denial' in resolved) {
      endSocket(socket, statusFor(resolved.denial))
      return true
    }
    try {
      await proxyUpgrade(request, socket, head, {
        target: resolved.runtime.target,
        path: runtimeTarget(request.url),
      })
    } catch {
      endSocket(socket, 502)
    }
    return true
  }

  /** Stop every Runtime this gateway started. */
  async close(): Promise<void> {
    await this.runtimes.close()
  }

  /** Authenticate, apply policy, enforce the RPC lock, then resolve the Runtime. */
  private async resolve(
    request: IncomingMessage,
    pathname: string,
  ): Promise<{ readonly runtime: RuntimeRecord } | { readonly denial: GatewayDenial }> {
    const authenticated = await this.options.authenticate(request)
    if (authenticated === undefined) return this.deny(pathname, 'unauthenticated')

    const current = await this.options.authorize(authenticated)
    if (!current.scopes.includes(USE_SCOPE)) {
      return this.deny(pathname, 'missing_assistant_scope', current.subject)
    }
    // Checked against the scopes the IAM actually granted, not the widened set:
    // policy may narrow what a user can do, never broaden it.
    if (blockedDshRpc(pathname, authenticated.scopes)) {
      return this.deny(pathname, 'managed_capability_locked', current.subject)
    }

    try {
      return { runtime: await this.runtimes.runtime(current) }
    } catch (error) {
      return this.deny(pathname, 'runtime_unavailable', current.subject, error)
    }
  }

  private deny(
    pathname: string,
    denial: GatewayDenial,
    subject?: string,
    cause?: unknown,
  ): { readonly denial: GatewayDenial } {
    this.options.onDenied?.({
      pathname,
      denial,
      ...(subject === undefined ? {} : { subject }),
      ...(cause === undefined ? {} : { cause }),
    })
    return { denial }
  }
}

function statusFor(denial: GatewayDenial): number {
  if (denial === 'unauthenticated') return 401
  if (denial === 'runtime_unavailable') return 503
  return 403
}

/**
 * Reply with a reason code and nothing else.
 *
 * The client is a browser holding a session, so a refusal is not something it can
 * act on beyond re-authenticating; detail here would only describe the
 * deployment's policy to whoever asked.
 */
function respond(response: ServerResponse, status: number, reason: string): void {
  const body = JSON.stringify({ error: reason })
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}
