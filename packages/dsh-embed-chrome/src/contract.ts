/**
 * Route and message vocabulary shared by the Host half and the browser half.
 *
 * The problem this package solves: a hosted Runtime is usually shown inside a
 * page the deployment already owns — its own navigation, its own account, its
 * own name for what the user is doing. DSH's own chrome (the sidebar brand, the
 * blank-session headline) is correct for the standalone product and wrong
 * inside that frame, where it appears as a second, competing identity.
 *
 * The embedding page is the only thing that knows what belongs there, so the
 * page supplies it. Not configuration: the page can change its mind (the user
 * renames a workspace, switches account) without restarting the Runtime.
 */

/** Where the browser half learns which page it may talk to. */
export const EMBED_CHROME_ROUTE = '/plugins/dshserver/embed-chrome/host'

/**
 * The one deployment fact the browser half cannot work out for itself.
 *
 * The framing page is on a different origin — that is the normal case, since
 * the Runtime is reached through a gateway and the product lives on the
 * deployment's own domain — so "same origin" cannot be the trust rule the way
 * it can for a same-site widget. The Host names the origin instead, from
 * configuration only a deployment operator can write.
 */
export interface EmbedHostInfo {
  /** Origin allowed to supply chrome and to be sent requests. Empty disables embedding. */
  readonly hostOrigin: string
}

export const CHROME_PROTOCOL = 1
export const CHROME_MESSAGE_SOURCE = 'dsh-embed-chrome'

/** One switchable workspace as the page describes it. */
export interface ChromeWorkspace {
  readonly id: string
  readonly name: string
}

/**
 * What the embedding page tells the browser half to render.
 *
 * Every field is optional and an absent field means "leave DSH's own chrome
 * alone". A page that sends `{type:'chrome'}` and nothing else changes nothing,
 * which is what makes a partially-implemented host safe.
 */
export interface ChromeState {
  readonly type: 'chrome'
  /** Sidebar brand line — typically the current workspace's name. */
  readonly brand?: string
  /** Headline on a blank session, replacing the product's own. */
  readonly headline?: string
  /** Switchable workspaces. Fewer than two renders no switcher. */
  readonly workspaces?: readonly ChromeWorkspace[]
  /** Which of `workspaces` this Runtime serves. */
  readonly currentWorkspaceId?: string
}

/** Browser half → embedding page. */
export type ChromeRequest =
  /** Sent once the browser half is listening; the page answers with `chrome`. */
  | { readonly type: 'ready' }
  /**
   * The user picked a different workspace.
   *
   * A request, not a command: switching workspace means a different Runtime
   * behind a different token, and only the page can mint one. The browser half
   * does not change anything locally — it asks, and waits to be reloaded.
   */
  | { readonly type: 'switch'; readonly workspaceId: string }

/** Envelope both directions share, so a page can filter its own message bus. */
interface Envelope {
  readonly source: typeof CHROME_MESSAGE_SOURCE
  readonly version: typeof CHROME_PROTOCOL
}

export type ChromeStateMessage = Envelope & ChromeState
export type ChromeRequestMessage = Envelope & ChromeRequest

/** Wrap a request for `postMessage`. */
export function chromeRequest(request: ChromeRequest): ChromeRequestMessage {
  return { source: CHROME_MESSAGE_SOURCE, version: CHROME_PROTOCOL, ...request }
}

function isWorkspace(value: unknown): value is ChromeWorkspace {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ChromeWorkspace>
  return typeof candidate.id === 'string' && candidate.id !== ''
    && typeof candidate.name === 'string' && candidate.name !== ''
}

/**
 * Validate a message from the embedding page, or null.
 *
 * Strict about the envelope and lenient about the payload: an unknown protocol
 * version is refused outright rather than half-read, while a malformed
 * individual field is dropped so one bad value cannot cost the page the whole
 * update.
 */
export function parseChromeState(data: unknown): ChromeState | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Partial<ChromeStateMessage>
  if (message.source !== CHROME_MESSAGE_SOURCE) return null
  if (message.version !== CHROME_PROTOCOL) return null
  if (message.type !== 'chrome') return null
  const workspaces = Array.isArray(message.workspaces) && message.workspaces.every(isWorkspace)
    ? message.workspaces
    : undefined
  return {
    type: 'chrome',
    ...(typeof message.brand === 'string' && message.brand !== '' ? { brand: message.brand } : {}),
    ...(typeof message.headline === 'string' && message.headline !== '' ? { headline: message.headline } : {}),
    ...(workspaces === undefined ? {} : { workspaces }),
    ...(typeof message.currentWorkspaceId === 'string' && message.currentWorkspaceId !== ''
      ? { currentWorkspaceId: message.currentWorkspaceId }
      : {}),
  }
}

/**
 * The origin of an absolute URL, or null.
 *
 * A configured host is written as a URL by operators (`https://example.com`, or
 * a full page address by mistake); only its origin is ever used, and comparing
 * origins avoids treating `https://example.com` and `https://example.com/` as
 * two different trusted parties.
 */
export function originOf(url: string): string | null {
  if (url.trim() === '') return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}
