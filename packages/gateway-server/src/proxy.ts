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

/** Read a request body fully, so it can be inspected or rewritten before forwarding. */
export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export interface ProxyRequestOptions extends ProxyTarget {
  /**
   * A body already read from the request. When present it is sent instead of
   * piping, and content-length is restated to match — a rewritten body almost
   * never has the length the client announced.
   */
  readonly body?: Buffer
}

/** Forward one HTTP request upstream and stream the response back. */
export async function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyRequestOptions,
): Promise<void> {
  const upstream = new URL(request.url ?? '/', options.target)
  const headers = forwardableHeaders(request.headers)
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
  options: ProxyTarget,
): Promise<void> {
  const upstream = new URL(request.url ?? '/', options.target)
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
      socket.write(`${statusLine.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.byteLength > 0) socket.write(upstreamHead)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
      // Resolving here hands the sockets over; both ends are torn down by the
      // pipes above once either side closes.
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
