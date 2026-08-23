/**
 * Which request paths belong to the embedded DSH UI.
 *
 * The list is closed on purpose. A gateway that forwarded everything would also
 * forward the host application's own routes into a Runtime, so anything not
 * named here stays with the host.
 */

/** Exact paths DSH serves at the root. */
const EXACT = new Set([
  '/assistant',
  '/favicon.svg',
  '/manifest.webmanifest',
])

/** Prefixes DSH serves a tree under. */
const PREFIXES = [
  '/assistant/',
  '/api/',
  '/plugins/',
  '/assets/',
]

/**
 * True when the path is served by a Runtime rather than the host application.
 *
 * Takes a pathname, never a full URL: a query string or an absolute-form target
 * would defeat the prefix comparison.
 */
export function isDshHttpPath(pathname: string): boolean {
  return EXACT.has(pathname) || PREFIXES.some(prefix => pathname.startsWith(prefix))
}

/**
 * The pathname of an incoming request, without query or fragment.
 *
 * `request.url` on a server carries an origin-form target, so parsing it against
 * a placeholder base is enough to isolate the path. An unparsable target yields
 * `/`, which matches no DSH path and therefore falls through to the host.
 */
export function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://placeholder.invalid').pathname
  } catch {
    return '/'
  }
}

/** Where the deployment exposes the Runtime's web app. */
const ASSISTANT_MOUNT = '/assistant'

/**
 * Translate a request target into the path the Runtime expects.
 *
 * A Runtime serves its web app at the root; `/assistant` is only the mount point
 * a deployment exposes it under. Everything else — `/api`, `/assets`, `/plugins`
 * — already carries the absolute path the app asks for and passes through
 * untouched, so rewriting those would break them.
 */
export function runtimeTarget(url: string | undefined): string {
  const target = url ?? '/'
  const pathname = pathnameOf(target)
  if (pathname !== ASSISTANT_MOUNT && !pathname.startsWith(`${ASSISTANT_MOUNT}/`)) return target
  const rewritten = target.slice(ASSISTANT_MOUNT.length)
  return rewritten.startsWith('/') ? rewritten : `/${rewritten}`
}
