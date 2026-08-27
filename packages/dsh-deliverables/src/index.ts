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
import { readdir, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Dirent, Stats } from 'node:fs'
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
  DELIVERABLE_FILE_ROUTE, DELIVERABLE_LIST_ROUTE, contentTypeOf,
  parseDeliverableListRequest, parseDeliverableRequest,
} from './contract.js'
import type { DeliverableEntry } from './contract.js'

export {
  DELIVERABLE_FILE_ROUTE, DELIVERABLE_LIST_ROUTE, DETAILS_PRIORITY, contentTypeOf,
  deliverableFileUrl, deliverableKind, deliverableListUrl, extensionOf,
  parseDeliverableListRequest, parseDeliverableRequest,
  type DeliverableEntry, type DeliverableKind,
} from './contract.js'

export const name = 'dshserver-deliverables'
export const inject = ['agents', 'webServer']

/** Largest file served inline. Beyond this the browser half offers a download. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024

/**
 * Most entries returned for one directory.
 *
 * A workspace can hold a dependency tree, and a listing of a hundred thousand
 * names is neither useful to read nor cheap to send. The browser half says when
 * a directory was truncated rather than implying it saw everything.
 */
const MAX_ENTRIES = 500

/**
 * Directories never listed.
 *
 * Not a security boundary — everything here is inside the session's own
 * workspace and reachable by naming it directly. It is about what the panel is
 * for: someone looking for the report they just asked for should not have to
 * page through a package store to find it.
 */
const SKIPPED = new Set(['node_modules', '.git'])

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
      // The same confinement the preview iframe declares, but carried by the
      // response so it survives a top-level navigation: opening a produced
      // page in a browser tab gives it an opaque origin, exactly as framing it
      // does. Scripts run — a produced page or game works — while the session
      // cookie, the `/api` surface and every other same-origin document stay
      // unreachable.
      //
      // Without this, "open in a new tab" would be the one path that hands a
      // model-written document the deployment's own origin. `allow-same-origin`
      // is deliberately absent, and adding it alongside `allow-scripts` would
      // let the document drop its own sandbox — confinement in name only.
      'content-security-policy': 'sandbox allow-scripts',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(file).pipe(response)
  }
}

/**
 * @internal Exported for tests; `apply` wires this to the web server.
 *
 * Lists one directory inside one session's workspace. Confinement is the same
 * `confineToWorkspace` the file route uses, for the same reason: the directory
 * arrives from the browser, and a `..` or a symlink pointing out of the
 * workspace must not be followed.
 */
export function createListingHandler(lookup: SessionLookup) {
  return async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      fail(response, 405, 'method-not-allowed')
      return
    }
    const parsed = parseDeliverableListRequest(request.url ?? DELIVERABLE_LIST_ROUTE)
    if (parsed === null) {
      fail(response, 400, 'path-required')
      return
    }
    const workspace = lookup(parsed.sessionId)
    if (workspace === undefined) {
      fail(response, 404, 'session-not-active')
      return
    }
    const directory = await confineToWorkspace(workspace, parsed.directory)
    if (directory === null) {
      fail(response, 404, 'not-found')
      return
    }
    // Annotated rather than inferred: `readdir`'s overloads resolve to the
    // Buffer-named variant here, and every `entry.name` downstream would be a
    // Buffer at the type level while being a string at runtime.
    let listing: Dirent[]
    try {
      listing = await readdir(directory, { withFileTypes: true })
    } catch {
      // A file rather than a directory, or gone between the two calls.
      fail(response, 404, 'not-found')
      return
    }
    const kept = listing.filter(entry => !(entry.isDirectory() && SKIPPED.has(entry.name)))
    const truncated = kept.length > MAX_ENTRIES
    const entries: DeliverableEntry[] = []
    for (const entry of kept.slice(0, MAX_ENTRIES)) {
      const child = `${directory}${sep}${entry.name}`
      let info: Stats
      try {
        info = await stat(child)
      } catch {
        // A broken symlink, or removed while we were listing. Skipping it is
        // better than failing the whole listing for one bad entry.
        continue
      }
      // `stat` follows symlinks, so a link to a directory lists as a directory —
      // and stepping into it is confined by `confineToWorkspace` on the next
      // request, which realpaths both sides.
      const relative = parsed.directory === '' ? entry.name : `${parsed.directory}/${entry.name}`
      entries.push({
        name: entry.name,
        path: relative,
        directory: info.isDirectory(),
        size: info.isDirectory() ? 0 : info.size,
        modified: info.mtimeMs,
      })
    }
    const body = JSON.stringify({ directory: parsed.directory, entries, truncated })
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  }
}

export function apply(ctx: Context): void {
  const lookup: SessionLookup = sessionId => ctx.agents.get(sessionId as SessionId)?.session.header.cwd
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: DELIVERABLE_FILE_ROUTE,
    handler: createDeliverableHandler(lookup),
  }), 'dshserver-deliverables: produced-file route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: DELIVERABLE_LIST_ROUTE,
    handler: createListingHandler(lookup),
  }), 'dshserver-deliverables: workspace listing route')
}
