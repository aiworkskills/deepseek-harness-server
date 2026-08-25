/** Route and vocabulary shared by the Host half and the browser half. */

/**
 * Where produced files are served from.
 *
 * Path-shaped, not query-shaped, and that is load-bearing: a produced
 * `article.html` refers to its images relatively (`<img src="cover.png">`),
 * and a relative reference resolves against the document's own URL. Under
 * `…/file?path=article.html` every such reference would resolve to
 * `…/cover.png` — a URL this route does not serve — and the preview would show
 * a page of broken images. With the workspace path carried in the URL path,
 * relative references land exactly where the file itself did.
 */
export const DELIVERABLE_FILE_ROUTE = '/plugins/dshserver/deliverables/file'

/**
 * Where the workspace listing is served from.
 *
 * A listing rather than a per-turn chip row: the accumulator that decides what
 * one turn "produced" lives in DSH's own deliverables plugin and is not part of
 * its published surface, so a second implementation would have to re-derive it
 * from internal event shapes and would drift the moment they changed. What a
 * session actually wrote is answerable from the workspace itself, needs no
 * coupling, and shows work from earlier turns too.
 */
export const DELIVERABLE_LIST_ROUTE = '/plugins/dshserver/deliverables/list'

/** One file in a workspace listing. */
export interface DeliverableEntry {
  /** Workspace-relative, forward-slashed. */
  readonly path: string
  readonly size: number
  /** Last modification, epoch milliseconds; the listing is newest first. */
  readonly modified: number
  readonly kind: DeliverableKind
}

/** How the browser half decides what to render. */
export type DeliverableKind = 'html' | 'image' | 'markdown' | 'text' | 'json' | 'binary'

/** Extension → kind, lowercase and without the dot. */
const KINDS: ReadonlyArray<readonly [DeliverableKind, readonly string[]]> = [
  ['html', ['html', 'htm']],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']],
  ['markdown', ['md', 'markdown']],
  ['json', ['json']],
  ['text', [
    'txt', 'log', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'env', 'sql',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'py', 'rb', 'go',
    'rs', 'java', 'kt', 'c', 'h', 'cpp', 'sh', 'bash', 'zsh', 'xml', 'svgz',
  ]],
]

/** Content types for the kinds served as documents rather than downloads. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
}

export function extensionOf(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** What the browser half should render for this path. */
export function deliverableKind(path: string): DeliverableKind {
  const extension = extensionOf(path)
  for (const [kind, extensions] of KINDS) {
    if (extensions.includes(extension)) return kind
  }
  return 'binary'
}

/**
 * Content type for a served file.
 *
 * Unknown extensions are `application/octet-stream` rather than a guess:
 * sniffing is off (`X-Content-Type-Options: nosniff`), so a wrong guess would
 * be honoured by the browser instead of corrected.
 */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? 'application/octet-stream'
}

/** URL of the listing for one session's workspace. */
export function deliverableListUrl(sessionId: string): string {
  return `${DELIVERABLE_LIST_ROUTE}/${encodeURIComponent(sessionId)}`
}

/** URL for one produced file inside one session's workspace. */
export function deliverableFileUrl(sessionId: string, path: string): string {
  const relative = path.replace(/^[/\\]+/, '').split(/[/\\]+/).map(encodeURIComponent).join('/')
  return `${DELIVERABLE_FILE_ROUTE}/${encodeURIComponent(sessionId)}/${relative}`
}

/** Parse a request path back into its session and workspace-relative path. */
export function parseDeliverableRequest(url: string): { sessionId: string; path: string } | null {
  return parseUnder(url, DELIVERABLE_FILE_ROUTE, 2)
}

/** The session a listing request names, or null when the URL is not one. */
export function parseListRequest(url: string): string | null {
  return parseUnder(url, DELIVERABLE_LIST_ROUTE, 1)?.sessionId ?? null
}

function parseUnder(url: string, route: string, minimum: number): { sessionId: string; path: string } | null {
  const pathname = new URL(url, 'http://localhost').pathname
  if (!pathname.startsWith(`${route}/`)) return null
  const rest = pathname.slice(route.length + 1)
  const segments = rest.split('/').filter(segment => segment !== '')
  if (segments.length < minimum) return null
  const [rawSession, ...rawPath] = segments
  try {
    const sessionId = decodeURIComponent(rawSession as string)
    const path = rawPath.map(decodeURIComponent).join('/')
    if (sessionId === '' || (minimum > 1 && path === '')) return null
    return { sessionId, path }
  } catch {
    // A malformed percent-escape is not a path we can resolve.
    return null
  }
}
