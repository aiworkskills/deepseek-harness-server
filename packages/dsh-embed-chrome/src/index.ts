/**
 * Host half: tell this Runtime's own browser half which page may dress it.
 *
 * That is the entire server-side job. The chrome itself never passes through
 * here — it comes from the embedding page at runtime, over `postMessage`, and
 * a page that changes its mind does not need the Runtime restarted.
 *
 * What the Host owns is the trust decision, because it is the only half with
 * configuration: which origin is allowed to speak. Leaving that to the browser
 * would mean either trusting whoever framed the page, or shipping a fixed list
 * that no self-hosting deployment could change.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
// Type-only: declares `ctx.webServer` without emitting a runtime import. A
// plain side-effect import would survive compilation, and a plugin linked into
// a profile has no `node_modules` of its own to resolve it from.
import type {} from '@deepseek-ai/dsh-host-webserver'

import { EMBED_CHROME_ROUTE, originOf, type EmbedHostInfo } from './contract.js'

export {
  CHROME_MESSAGE_SOURCE, CHROME_PROTOCOL, EMBED_CHROME_ROUTE, chromeRequest, originOf,
  parseChromeState,
  type ChromeRequest, type ChromeRequestMessage, type ChromeState, type ChromeStateMessage,
  type ChromeWorkspace, type EmbedHostInfo,
} from './contract.js'

export const name = 'dshserver-embed-chrome'
export const inject = ['webServer']

export interface Config {
  /**
   * Origin of the page allowed to supply chrome, e.g. `https://app.example.com`.
   *
   * Empty — the default — turns the plugin off: it serves the route, answers
   * with no origin, and the browser half leaves every surface as DSH shipped
   * it. A deployment that has not thought about who may dress its Runtime gets
   * the standalone product, not an open door.
   */
  readonly hostOrigin?: string
}

export const Config: z<Config> = z.object({
  hostOrigin: z.string().default(''),
})

function handler(info: EmbedHostInfo) {
  return function respond(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      response.writeHead(405, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'method-not-allowed' }))
      return
    }
    const body = JSON.stringify(info)
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const configured = config.hostOrigin ?? ''
  const hostOrigin = originOf(configured)
  if (configured.trim() !== '' && hostOrigin === null) {
    // Failing loudly at composition beats a silent no-op: a typo here reads to
    // the operator as "the feature does not work", with nothing to look at.
    throw new Error(`hostOrigin must be an absolute http(s) URL: ${configured}`)
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EMBED_CHROME_ROUTE,
    handler: handler({ hostOrigin: hostOrigin ?? '' }),
  }), 'dshserver-embed-chrome: host info route')
}
