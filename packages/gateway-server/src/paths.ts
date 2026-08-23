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
