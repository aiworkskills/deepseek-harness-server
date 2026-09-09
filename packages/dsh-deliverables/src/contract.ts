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
 * This implementation's identity in the Sidebar tab system.
 *
 * The registry keys a type's body seat on its `id`, not its `kind`: a kind is
 * not unique, because an extension may take a builtin's. A package name is the
 * natural value for an id that must not collide with anyone else's.
 */
export const DELIVERABLE_TAB_ID = '@dshserver/dsh-deliverables'

/** Type discriminator for tabs this plugin opens. */
export const DELIVERABLE_TAB_KIND = 'deliverable'

/**
 * How the browser half decides what to render.
 *
 * Three kinds, not six: this plugin claims only what the Sidebar's builtin text
 * viewer cannot show. Markdown, JSON and source text reach that builtin instead
 * (it pages them and tracks lines), so no kind here names them.
 */
export type DeliverableKind = 'html' | 'image' | 'binary'

/**
 * The extension lists, declared once.
 *
 * Everything downstream is derived: {@link deliverableKind} routes rendering,
 * {@link PREVIEWED_EXTENSIONS} decides what this type claims from the builtin
 * viewer, and {@link DELIVERABLE_TAB_PATTERNS} turns that into address globs.
 * They used to be three hand-maintained lists that had to be edited together;
 * adding an extension to one and not the others produced a file the tab claimed
 * but could not render, or one it rendered but never claimed.
 */
const HTML_EXTENSIONS = ['html', 'htm'] as const
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'] as const
/** Claimed so the builtin does not print them as mojibake, then offered as a download. */
const DOWNLOAD_ONLY_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx'] as const

/**
 * Extensions this type claims from the Sidebar's built-in text viewer.
 *
 * Only the kinds that viewer cannot show: a rendered page, an image, and the
 * office/PDF formats it would otherwise print as mojibake. Markdown, JSON and
 * source text are deliberately absent — the builtin reads them a page at a time
 * with line navigation and reload, which is more than the single `<pre>` this
 * plugin drew when it owned every kind.
 *
 * The claim wins by band, not by this list: a definition that names no priority
 * is `extension`, which outranks the builtin's `fallback` for any address both
 * match. Anything absent here falls through to that builtin untouched.
 */
export const PREVIEWED_EXTENSIONS: readonly string[] = [
  ...HTML_EXTENSIONS, ...IMAGE_EXTENSIONS, ...DOWNLOAD_ONLY_EXTENSIONS,
]

/**
 * Resource-address globs for {@link PREVIEWED_EXTENSIONS}.
 *
 * A pattern with no `:` is matched against the address's path at any depth, so
 * `*.html` catches `dsh-resource://file/session/s1/reports/q4.html`.
 */
export const DELIVERABLE_TAB_PATTERNS: readonly string[] =
  PREVIEWED_EXTENSIONS.map(extension => `*.${extension}`)

/**
 * Read a `dsh-resource://file/session/<id>/<path>` address into its parts.
 *
 * A deliberate local copy of DSH's `parseFileAddress`: this package is symlinked
 * into a profile with no `node_modules` beside it, so the browser half may import
 * nothing at runtime but React — `tests/bundle.spec.ts` holds that line, and it
 * has been broken twice already.
 *
 * Only the `session` scope is read. An `absolute` address names a file outside
 * any session workspace, which {@link deliverableFileUrl} cannot address and this
 * plugin's route would refuse; `canOpen` declines those so the builtin keeps them.
 */
export function parseSessionFileAddress(address: string): { sessionId: string; path: string } | null {
  try {
    const url = new URL(address)
    if (url.protocol !== 'dsh-resource:' || url.host !== 'file') return null
    const [, scope, id, ...segments] = url.pathname.split('/')
    if (scope !== 'session' || id === undefined || id === '' || segments.length === 0) return null
    const sessionId = decodeURIComponent(id)
    const path = segments.map(decodeURIComponent).join('/')
    return sessionId === '' || path === '' ? null : { sessionId, path }
  } catch {
    // `new URL` throws on a non-URL and `decodeURIComponent` on a malformed
    // escape; both mean "not an address this type can open".
    return null
  }
}

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
  if ((HTML_EXTENSIONS as readonly string[]).includes(extension)) return 'html'
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return 'image'
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
