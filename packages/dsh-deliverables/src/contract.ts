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
 * Where the session's own workspace is listed.
 *
 * This route exists because DSH's produced-file surfaces cannot see everything a
 * session makes. Its accumulator recognises a mutation by *render intent* — a
 * diff card, or a generic card whose kind is `edit` — so a file the model typed
 * out with an edit tool gets a chip, and a file a script wrote does not: a
 * terminal ran, and by that rule a terminal produces nothing.
 *
 * That rule is right for what it does, but it splits deliverables by how they
 * happened to be made. A report written as HTML is clickable; the same report as
 * `.docx` or `.pptx` is not, because binary formats can only be produced by
 * running something. Browsing the workspace is the surface that does not care:
 * it lists what is there.
 */
export const DELIVERABLE_LIST_ROUTE = '/plugins/dshserver/deliverables/list'

/** One entry in a workspace listing. */
export interface DeliverableEntry {
  readonly name: string
  /** Workspace-relative, `/`-separated; what the file route takes back. */
  readonly path: string
  readonly directory: boolean
  /** Bytes; `0` for directories. */
  readonly size: number
  /** Epoch milliseconds, so the browser half can sort by recency. */
  readonly modified: number
}

/**
 * This plugin's shadowing rank in the `details` slot (ascending, lowest renders).
 *
 * The preview is a *transient overlay*: the registration is held only while a
 * file is open and released on close, so it sits well below the default rank (0)
 * and a persistent panel gets its seat back the moment the preview closes.
 *
 * Exported rather than written inline at the registration, because the number is
 * an assembly-time fact: DSH throws on a second registration at the same slot and
 * the same rank, naming the occupant. A deployment stacking another details panel
 * needs to be able to read this to know whether the two collide, and which wins.
 */
export const DETAILS_PRIORITY = -20

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
  // Office and PDF stay `binary` above — the panel offers a download rather than
  // a preview — but the type is still worth sending: it is what decides which
  // application opens the saved file. These are IANA-registered types for the
  // extension, not the sniffing guess the comment below rules out.
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

/** URL for one produced file inside one session's workspace. */
export function deliverableFileUrl(sessionId: string, path: string): string {
  const relative = path.replace(/^[/\\]+/, '').split(/[/\\]+/).map(encodeURIComponent).join('/')
  return `${DELIVERABLE_FILE_ROUTE}/${encodeURIComponent(sessionId)}/${relative}`
}

/**
 * URL listing one directory inside one session's workspace.
 *
 * `directory` is `''` for the workspace root, which is why this cannot reuse the
 * file URL builder: an empty tail is the common case here and an error there.
 */
export function deliverableListUrl(sessionId: string, directory: string): string {
  const relative = directory.replace(/^[/\\]+/, '').split(/[/\\]+/)
    .filter(segment => segment !== '').map(encodeURIComponent).join('/')
  const base = `${DELIVERABLE_LIST_ROUTE}/${encodeURIComponent(sessionId)}`
  return relative === '' ? base : `${base}/${relative}`
}

/**
 * Parse a listing request back into its session and directory.
 *
 * Unlike {@link parseDeliverableRequest}, an empty tail is valid and means the
 * workspace root.
 */
export function parseDeliverableListRequest(url: string): { sessionId: string; directory: string } | null {
  const pathname = new URL(url, 'http://localhost').pathname
  if (pathname !== DELIVERABLE_LIST_ROUTE && !pathname.startsWith(`${DELIVERABLE_LIST_ROUTE}/`)) return null
  const tail = pathname.slice(DELIVERABLE_LIST_ROUTE.length).replace(/^\//, '')
  const segments = tail.split('/').filter(segment => segment !== '')
  const [rawSession, ...rawPath] = segments
  if (rawSession === undefined) return null
  try {
    const sessionId = decodeURIComponent(rawSession)
    const directory = rawPath.map(decodeURIComponent).join('/')
    return sessionId === '' ? null : { sessionId, directory }
  } catch {
    return null
  }
}

/** Parse a request path back into its session and workspace-relative path. */
export function parseDeliverableRequest(url: string): { sessionId: string; path: string } | null {
  const pathname = new URL(url, 'http://localhost').pathname
  if (!pathname.startsWith(`${DELIVERABLE_FILE_ROUTE}/`)) return null
  const segments = pathname.slice(DELIVERABLE_FILE_ROUTE.length + 1).split('/').filter(segment => segment !== '')
  const [rawSession, ...rawPath] = segments
  if (rawSession === undefined || rawPath.length === 0) return null
  try {
    const sessionId = decodeURIComponent(rawSession)
    const path = rawPath.map(decodeURIComponent).join('/')
    return sessionId === '' || path === '' ? null : { sessionId, path }
  } catch {
    // A malformed percent-escape is not a path we can resolve.
    return null
  }
}
