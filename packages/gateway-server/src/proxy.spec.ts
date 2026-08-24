/**
 * These cover socket lifetime, not the forwarding itself.
 *
 * An upgraded connection leaves the HTTP server's care entirely, and `pipe()`
 * carries data but not failures. That combination is how a single reset client
 * became an unhandled exception that ended a multi-user gateway — a class of
 * bug that no amount of successful proxying will reveal.
 */
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { endSocket, guardSocket } from './proxy.js'

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
