/**
 * Refuse a locked RPC in the protocol the caller is speaking.
 *
 * A managed deployment locks some RPCs on purpose — installing plugins,
 * rewriting platform credentials, opening a path with the server's desktop.
 * Answering those with a bare HTTP 403 is correct at the transport layer and
 * useless at the product layer: the DSH client throws before it ever reads the
 * body, so the user is shown `transport failure for /api/host.openPath: HTTP
 * 403` — a sentence that names a wire detail and explains nothing. The action
 * did not fail; it is not offered here, and only the deployment can say why.
 *
 * So a locked RPC is answered the way the API itself reports every other
 * business refusal: HTTP 200 carrying `{ ok: false, error }`. The client
 * surfaces `error.message`, which is the one place a deployment can put a
 * sentence a person can act on. Nothing is forwarded to a Runtime either way,
 * and the audit hook still fires — what changes is only who the refusal is
 * legible to.
 *
 * This applies to authenticated callers whose *capability* is locked. An
 * unauthenticated request keeps its 401: no session means no protocol
 * conversation to have.
 */

/** DSH's catch-all error code; its details object is empty by contract. */
const INTERNAL = 'internal'

/**
 * The `rpcId` the caller sent, which the response must echo.
 *
 * The client rejects a mismatched id before looking at the result, so a
 * refusal that guessed would surface as a mismatch error instead of the
 * explanation it was carrying. Returns undefined when the body is not a
 * client request — then there is no conversation to answer and the caller
 * falls back to a plain status.
 */
export function rpcIdOf(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { type?: unknown; rpcId?: unknown }
    if (parsed.type !== 'client-request') return undefined
    return typeof parsed.rpcId === 'string' && parsed.rpcId.length > 0 ? parsed.rpcId : undefined
  } catch {
    return undefined
  }
}

/** A `ServerResponse` envelope whose result is the error branch. */
export function rpcRefusalBody(rpcId: string, message: string): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: INTERNAL, message, details: {} } },
  })
}
