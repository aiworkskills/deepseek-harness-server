/**
 * Host half: serve one session's produced files to its own browser.
 *
 * A managed Runtime runs on a server the user will never sit in front of, so
 * DSH's produced-file chips — which hand a path to the *host's* desktop opener
 * — have nothing to open. This route gives the browser half something it can
 * actually render, and the two halves together replace that surface.
 *
 * Confinement is the whole job here. The request names a session and a
 * workspace-relative path, and what comes back must be inside that session's
 * own workspace: not a sibling Subject's, not `/etc`, not a symlink pointing
 * out. The realpath comparison below is what makes that true rather than
 * hoped for.
 */
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: these declare `ctx.agents` and `ctx.webServer` without emitting a
// runtime import. A plain side-effect import would survive compilation and the
// Runtime would die at load — the packages are type declarations, and this
// plugin is linked into a profile, not installed with its own node_modules.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'

import {
  DELIVERABLE_FILE_ROUTE, contentTypeOf, parseDeliverableRequest,
} from './contract.js'

export {
  DELIVERABLE_FILE_ROUTE, DETAILS_PRIORITY, contentTypeOf, deliverableFileUrl, deliverableKind,
  extensionOf, parseDeliverableRequest, type DeliverableKind,
} from './contract.js'

export const name = 'dshserver-deliverables'
export const inject = ['agents', 'webServer']

/** Largest file served inline. Beyond this the browser half offers a download. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024

interface SessionLookup {
  (sessionId: string): string | undefined
}

/**
 * The real path of `path` inside `workspace`, or null when it is not inside.
 *
 * Both sides are realpath'd before comparison: resolving the request against
 * the workspace string alone would accept a symlink inside the workspace that
 * points anywhere on the host, which is exactly the escape a produced file
 * could arrange for itself.
 */
export async function confineToWorkspace(workspace: string, path: string): Promise<string | null> {
  if (path.includes('\0')) return null
  let root: string
  try {
    root = await realpath(workspace)
  } catch {
    return null
  }
  const candidate = resolve(root, path)
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    // Missing file, or a broken symlink: nothing to serve either way.
    return null
  }
  return real === root || real.startsWith(`${root}${sep}`) ? real : null
}

function fail(response: ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error })
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/** @internal Exported for tests; `apply` wires this to the web server. */
export function createDeliverableHandler(lookup: SessionLookup) {
  return async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      fail(response, 405, 'method-not-allowed')
      return
    }
    const parsed = parseDeliverableRequest(request.url ?? DELIVERABLE_FILE_ROUTE)
    if (parsed === null) {
      fail(response, 400, 'path-required')
      return
    }
    const workspace = lookup(parsed.sessionId)
    if (workspace === undefined) {
      fail(response, 404, 'session-not-active')
      return
    }
    const file = await confineToWorkspace(workspace, parsed.path)
    if (file === null) {
      // One answer for "outside the workspace" and "not there": a different
      // reply for each would let a caller map the host's filesystem.
      fail(response, 404, 'not-found')
      return
    }
    const info = await stat(file)
    if (!info.isFile()) {
      fail(response, 404, 'not-found')
      return
    }
    if (info.size > MAX_INLINE_BYTES) {
      fail(response, 413, 'too-large')
      return
    }
    response.writeHead(200, {
      'content-type': contentTypeOf(parsed.path),
      'content-length': info.size,
      // Sniffing is off, so the content type above is the one the browser uses.
      // Without this a `.txt` holding markup could be treated as a document.
      'x-content-type-options': 'nosniff',
      // Produced files change as the agent works, and a stale preview reads as
      // a broken tool.
      'cache-control': 'no-store',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(file).pipe(response)
  }
}

export function apply(ctx: Context): void {
  const lookup: SessionLookup = sessionId => ctx.agents.get(sessionId as SessionId)?.session.header.cwd
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: DELIVERABLE_FILE_ROUTE,
    handler: createDeliverableHandler(lookup),
  }), 'dshserver-deliverables: produced-file route')
}
