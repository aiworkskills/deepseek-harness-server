/**
 * Host half: validate what the deployment wrote, and serve it to the browser half.
 *
 * The brand itself is entirely a browser concern — see `./client`. Two things
 * still have to happen here, and only here.
 *
 * Validating: a typo in the profile fails the Runtime at load with the
 * offending key named, instead of silently rendering nothing in a sidebar
 * nobody is looking at yet.
 *
 * Serving: the two halves do not share a configuration tree. The browser bundle
 * is loaded by `window.__ModuleLoader__`, while cordis passes profile config to
 * the Host `apply` only — a client plugin that declares a `config` parameter
 * receives the default on every load. That was this plugin's original shape,
 * and it never drew anything: `hasMark({})` is false, so it dutifully took no
 * seat on behalf of a deployment that had in fact supplied artwork, and said
 * nothing, because an empty config is exactly what "supplied nothing" looks
 * like. The config therefore travels over HTTP, the same way
 * `dsh-embed-chrome` hands its host origin across.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Type-only: declares `ctx.webServer` without emitting a runtime import. A
// plain side-effect import would survive compilation, and a plugin linked into
// a profile has no `node_modules` of its own to resolve it from.
import type {} from '@deepseek-ai/dsh-host-webserver'

import { BRAND_ROUTE, assertBrandConfig, type BrandConfig } from './contract.js'

export {
  BRAND_ROUTE, EMPTY_WORKSPACE_ACTIONS_CSS, assertBrandConfig, hasHeadline, hasMark, hasName,
  type BrandConfig,
} from './contract.js'

export const name = 'dshserver-brand'

export const inject = ['webServer']

/** @see BrandConfig — the schema lives there as plain types, for the reason in `assertBrandConfig`. */
export type Config = BrandConfig

function handler(config: BrandConfig) {
  return function respond(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      response.writeHead(405, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'method-not-allowed' }))
      return
    }
    const body = JSON.stringify(config)
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      // An operator edits the profile and restarts; a cached answer would
      // outlive the edit that was meant to replace it.
      'cache-control': 'no-store',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  assertBrandConfig(config)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BRAND_ROUTE,
    handler: handler(config),
  }), 'dshserver-brand: config route')
}
