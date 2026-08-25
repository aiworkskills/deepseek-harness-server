/**
 * The conversation with the embedding page: who may speak, and what is said.
 *
 * Kept free of React and of cordis so the trust rules can be read — and
 * tested — on their own. Three of them, and each exists for a reason:
 *
 *   1. The Host names the origin. The page frames us from a different origin
 *      (the Runtime is reached through a gateway, the product lives on the
 *      deployment's domain), so "same origin" cannot be the test.
 *   2. The sender must be our own parent frame. Origin alone would let any
 *      other window on that origin — a popup the user was navigated to —
 *      dress this Runtime and offer it workspaces.
 *   3. We only ever post to that origin, never to `'*'`. A wildcard target
 *      would hand the workspace list to whoever happened to frame us.
 */
import { chromeRequest, parseChromeState, type ChromeRequest, type ChromeState } from '../contract.js'

export interface EmbedLink {
  /** Stop listening. Idempotent. */
  close(): void
  /** Ask the page for something. No-op once closed. */
  send(request: ChromeRequest): void
}

export interface LinkOptions {
  readonly hostOrigin: string
  readonly onState: (state: ChromeState) => void
  /** Injected for tests; defaults to the real window. */
  readonly view?: Window
}

/**
 * Listen for chrome from `hostOrigin` and announce readiness to it.
 *
 * Returns null when this document is not framed, or the origin is empty —
 * a standalone Runtime, where every surface should stay as DSH shipped it.
 */
export function openEmbedLink(options: LinkOptions): EmbedLink | null {
  const view = options.view ?? (typeof window === 'undefined' ? undefined : window)
  if (view === undefined) return null
  if (options.hostOrigin === '') return null
  const parent = view.parent
  if (parent === view) return null

  let closed = false
  const receive = (event: MessageEvent): void => {
    if (closed) return
    if (event.origin !== options.hostOrigin) return
    if (event.source !== parent) return
    const state = parseChromeState(event.data)
    if (state !== null) options.onState(state)
  }
  view.addEventListener('message', receive)

  const link: EmbedLink = {
    close() {
      if (closed) return
      closed = true
      view.removeEventListener('message', receive)
    },
    send(request) {
      if (closed) return
      parent.postMessage(chromeRequest(request), options.hostOrigin)
    },
  }
  // Announced after the listener is installed, so a page that answers
  // synchronously cannot beat us to it.
  link.send({ type: 'ready' })
  return link
}
