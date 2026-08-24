/**
 * These cover socket lifetime, not the forwarding itself.
 *
 * An upgraded connection leaves the HTTP server's care entirely, and `pipe()`
 * carries data but not failures. That combination is how a single reset client
 * became an unhandled exception that ended a multi-user gateway — a class of
 * bug that no amount of successful proxying will reveal.
 */
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { endSocket, guardSocket, proxyUpgrade } from './proxy.js'

/** `emit('error')` throws when nothing is listening, which is the whole point here. */
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })

describe('detached socket handling', () => {
  it('contains a failure to the connection it happened on', () => {
    const socket = new PassThrough()
    guardSocket(socket)
    expect(() => socket.emit('error', reset())).not.toThrow()
    expect(socket.destroyed).toBe(true)
  })

  it('takes the peer down with it, so no half of a pipe is left writing into nothing', () => {
    const client = new PassThrough()
    const upstream = new PassThrough()
    guardSocket(client, upstream)
    guardSocket(upstream, client)

    client.emit('error', reset())
    expect(upstream.destroyed).toBe(true)
  })

  it('stays quiet when the client is already gone', () => {
    // Refusing an upgrade can mean starting a Runtime first, which takes long
    // enough that the client is regularly gone by the time there is a verdict.
    const socket = new PassThrough()
    guardSocket(socket)
    socket.destroy()
    expect(() => { endSocket(socket, 401) }).not.toThrow()
  })

  it('still answers a client that is still there', () => {
    const socket = new PassThrough()
    const written: Buffer[] = []
    socket.on('data', chunk => written.push(chunk as Buffer))
    endSocket(socket, 403)
    expect(Buffer.concat(written).toString()).toContain('HTTP/1.1 403 Forbidden')
  })
})

const servers: Server[] = []
const accepted: Socket[] = []

afterEach(async () => {
  // Upgrading detaches a socket from the server, so `close()` on its own waits
  // for a connection it no longer tracks and never settles. Hold every accepted
  // socket and tear them down here instead.
  for (const socket of accepted.splice(0)) socket.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => { resolve() })
  })))
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.on('connection', socket => { accepted.push(socket) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

describe('an established channel over real sockets', () => {
  it('survives a client that resets it', async () => {
    // The unit cases above emit `error` by hand. This one produces a genuine
    // ECONNRESET on a connection that reached 101 and was piped — the shape of
    // the failure that actually took the gateway down, where the reset surfaces
    // inside Node's read callback on a socket nobody is listening to.
    const upstream = createServer()
    upstream.on('upgrade', (_request, socket) => {
      guardSocket(socket)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    const upstreamPort = await listen(upstream)

    const front = createServer()
    front.on('upgrade', (request, socket, head) => {
      void proxyUpgrade(request, socket, head, { target: `http://127.0.0.1:${upstreamPort}` })
    })
    const frontPort = await listen(front)

    const escaped: unknown[] = []
    const watch = (error: unknown) => { escaped.push(error) }
    process.on('uncaughtException', watch)
    try {
      await new Promise<void>(resolve => {
        const client = connect(frontPort, '127.0.0.1', () => {
          client.write('GET /plugins/events HTTP/1.1\r\nHost: gateway.test\r\n'
            + 'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
        })
        client.on('error', () => {})
        // Reset only after the 101 arrives: the crash was on a channel that had
        // been established, not on a handshake that never completed.
        client.once('data', () => {
          client.resetAndDestroy()
          resolve()
        })
      })
      // Give the reset time to reach both halves of the pipe.
      await new Promise(resolve => { setTimeout(resolve, 150) })
    } finally {
      process.off('uncaughtException', watch)
    }

    expect(escaped).toEqual([])
  })
})
