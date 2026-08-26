/**
 * A minimal HTTP and WebSocket reverse proxy, built on `node:http` alone.
 *
 * This deliberately does not pull in a proxy library. The component sits on the
 * authorization boundary — every byte between a browser and a Runtime passes
 * through it — and the established options in this space are either unmaintained
 * or carry a dependency tree of their own. What a Runtime proxy actually needs is
 * narrow: one upstream, no rewriting beyond the request line, and an upgrade that
 * is two sockets piped together.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Headers that describe one connection rather than the message, and so must not
 * be forwarded to the next hop (RFC 9110 §7.6.1). `connection` additionally names
 * further headers to drop, which is why it is read before the list is applied.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardableHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const dropped = new Set(HOP_BY_HOP)
  const connection = headers.connection
  if (typeof connection === 'string') {
    for (const name of connection.split(',')) dropped.add(name.trim().toLowerCase())
  }
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || dropped.has(name.toLowerCase())) continue
    result[name] = value
  }
  return result
}

export interface ProxyTarget {
  /** Upstream origin, e.g. `http://127.0.0.1:41234`. */
  readonly target: string
}

/**
 * Attach the `error` listener a detached socket cannot go without.
 *
 * `server.on('upgrade')` hands the socket over: from that moment the HTTP server
 * no longer handles its errors, and `pipe()` does not forward them either. An
 * `error` with no listener is rethrown by `EventEmitter`, so one client that
 * goes away — a closed tab, a tunnel blip, a Runtime reaped while its channel is
 * open — becomes an unhandled exception that ends the process, and with it every
 * other Subject's session. A per-connection fault has to stay per-connection.
 *
 * `peer` is the socket on the other side of the pipe: once one end is gone the
 * other has nowhere left to write, so it is torn down rather than left half-open.
 */
export function guardSocket(socket: Duplex, peer?: Duplex): void {
  socket.on('error', () => {
    socket.destroy()
    if (peer !== undefined) peer.destroy()
  })
}

/** Read a request body fully, so it can be inspected or rewritten before forwarding. */
export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export interface ProxyRequestOptions extends ProxyTarget {
  /** Request target sent upstream. Defaults to `request.url` unchanged. */
  readonly path?: string

  /**
   * A body already read from the request. When present it is sent instead of
   * piping, and content-length is restated to match — a rewritten body almost
   * never has the length the client announced.
   */
  readonly body?: Buffer

  /**
   * Re-address the request to this authority.
   *
   * Off by default, and that default is the important half: Harness derives
   * absolute URLs from `Host`, so a gateway that rewrote it everywhere would
   * hand out links pointing at `127.0.0.1`. Set it only where the upstream
   * treats a particular authority as an authorization signal and the caller
   * has already been authorized by other means.
   *
   * Setting it also drops `Origin` and `Sec-Fetch-Site`, and that is not a
   * separate decision — it follows. Both headers describe the browser's
   * relationship to the authority it *thought* it was addressing. Once that
   * authority is replaced they no longer describe anything the upstream can
   * check, and forwarding them guarantees a mismatch: an upstream comparing
   * `Origin` against `Host` sees two different authorities and refuses. The
   * protection they carry — CSRF and DNS rebinding — has to have been
   * re-established by whoever sets this, which is why it is off by default.
   */
  readonly host?: string
}

/**
 * Headers that describe the caller's relationship to the authority it
 * addressed. Meaningless — and actively harmful — once that authority is
 * replaced. See {@link ProxyRequestOptions.host}.
 */
const AUTHORITY_BOUND = ['origin', 'sec-fetch-site']

/**
 * The loopback authority naming a Runtime reachable at `target`.
 *
 * Keeps `target`'s port and throws its hostname away, and that asymmetry is
 * the whole point: the container backend addresses a Runtime by container
 * name, which is not loopback and would fail the very check this value exists
 * to satisfy. The header does not have to name the host we connect to — the
 * socket still goes to `target` — and only the header is read.
 */
export function loopbackAuthorityOf(target: string): string {
  const port = new URL(target).port
  return port === '' ? '127.0.0.1' : `127.0.0.1:${port}`
}

/** Forward one HTTP request upstream and stream the response back. */
export async function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyRequestOptions,
): Promise<void> {
  const upstream = new URL(options.path ?? request.url ?? '/', options.target)
  const headers = forwardableHeaders(request.headers)
  if (options.host !== undefined) {
    headers.host = options.host
    for (const name of AUTHORITY_BOUND) delete headers[name]
  }
  if (options.body !== undefined) headers['content-length'] = String(options.body.byteLength)

  await new Promise<void>((resolve, reject) => {
    const forwarded = httpRequest(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: `${upstream.pathname}${upstream.search}`,
        headers,
      },
      upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
        upstreamResponse.once('end', resolve)
        upstreamResponse.once('error', reject)
      },
    )
    forwarded.once('error', reject)
    // A client that disappears mid-response leaves the upstream request open;
    // without this the Runtime keeps producing a body nobody will read.
    response.once('close', () => { forwarded.destroy() })

    if (options.body === undefined) request.pipe(forwarded)
    else forwarded.end(options.body)
  })
}

/**
 * Forward a WebSocket upgrade and then get out of the way.
 *
 * After the upstream answers 101 the connection stops being HTTP, so the two
 * sockets are simply piped together. `head` carries any bytes the client already
 * sent past the handshake and has to be replayed first, or the first frame is lost.
 */
export async function proxyUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: ProxyTarget & { readonly path?: string },
): Promise<void> {
  const upstream = new URL(options.path ?? request.url ?? '/', options.target)
  const headers = forwardableHeaders(request.headers)

  await new Promise<void>((resolve, reject) => {
    const forwarded = httpRequest({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: `${upstream.pathname}${upstream.search}`,
      headers: {
        ...headers,
        connection: 'Upgrade',
        upgrade: typeof request.headers.upgrade === 'string' ? request.headers.upgrade : 'websocket',
      },
    })

    forwarded.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const statusLine = [`HTTP/1.1 101 ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue
        for (const item of Array.isArray(value) ? value : [value]) statusLine.push(`${name}: ${item}`)
      }
      // Before the first byte: past 101 both sockets are detached from any HTTP
      // machinery, and a reset on either one has nowhere else to go.
      guardSocket(upstreamSocket, socket)
      guardSocket(socket, upstreamSocket)
      socket.write(`${statusLine.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.byteLength > 0) socket.write(upstreamHead)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
      // Resolving here hands the sockets over; both ends are torn down by the
      // pipes above once either side closes cleanly, and by the guards above
      // when either one fails.
      resolve()
    })

    // The upstream answering with a normal response means the upgrade was
    // refused. Relay that verdict rather than leaving the client hanging.
    forwarded.once('response', upstreamResponse => {
      endSocket(socket, upstreamResponse.statusCode ?? 502)
      resolve()
    })
    forwarded.once('error', reject)

    if (head.byteLength > 0) forwarded.write(head)
    forwarded.end()
  })
}

/** Close an upgrade attempt with a status line, the only reply available pre-101. */
export function endSocket(socket: Duplex, status: number, message = ''): void {
  // The client is often already gone by the time a refusal is decided — deciding
  // it can mean starting a Runtime first. Writing to a destroyed socket raises
  // ERR_STREAM_DESTROYED, so say nothing when there is nobody left to say it to.
  if (socket.destroyed) return
  const reason = message.length > 0 ? message : statusText(status)
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function statusText(status: number): string {
  if (status === 401) return 'Unauthorized'
  if (status === 403) return 'Forbidden'
  if (status === 502) return 'Bad Gateway'
  return 'Error'
}
