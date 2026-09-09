/**
 * The process backend: one Runtime = one child process of the gateway.
 *
 * This is the original and default execution posture. It shares the gateway's
 * kernel, user id and filesystem, so it isolates *state* (per-Runtime home and
 * workspace) but not *reach* — appropriate for a single operator's machine or a
 * trusted team, and explicitly not for hosting strangers. A deployment that
 * serves mutually untrusting users should supply a backend with a kernel
 * boundary instead; the manager will not notice the difference.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

import { startupTokenOf, type RuntimeBackend, type RuntimeHandle, type RuntimeStart } from './runtime-backend.js'

/** How many output lines a handle retains for failure reports. */
const LOG_LINES = 200

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || address === null) {
        server.close()
        reject(new Error('failed to allocate a runtime port'))
        return
      }
      const port = address.port
      server.close(error => error === undefined ? resolvePort(port) : reject(error))
    })
  })
}

export class ProcessRuntimeBackend implements RuntimeBackend {
  readonly isolation = 'dedicated-process-and-home'

  async start({ layout, env, publicHost }: RuntimeStart): Promise<RuntimeHandle> {
    const port = await availablePort()
    const child = spawn(process.execPath, [
      layout.cli,
      '--profile', 'web',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--trusted-host', publicHost,
      // A managed Runtime must never reach the operator's desktop: the web
      // profile opens the default browser on startup unless this is passed,
      // which would also hand out a Gateway-free URL to the raw Runtime port.
      '--no-open',
    ], {
      cwd: layout.workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const logs: string[] = []
    // The token arrives on stdout at some point after spawn, and the caller
    // needs it before it can authenticate. A promise settled by whichever comes
    // first — the announcement or the exit — lets the caller await it without
    // risking a wait that never ends.
    let announceToken: (value: string | undefined) => void = () => {}
    const announced = new Promise<string | undefined>(resolve => { announceToken = resolve })
    const append = (source: string, chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        logs.push(`[${source}] ${line}`)
        const token = startupTokenOf(line)
        if (token !== undefined) announceToken(token)
      }
      if (logs.length > LOG_LINES) logs.splice(0, logs.length - LOG_LINES)
    }
    child.stdout?.on('data', (chunk: Buffer) => { append('stdout', chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { append('stderr', chunk) })

    let cause: number | string | null = null
    const exited = new Promise<number | string | null>(resolveExit => {
      child.once('exit', (code, signal) => {
        cause = code ?? signal ?? 'exit'
        // A Runtime that died before announcing has no token and never will.
        announceToken(undefined)
        resolveExit(cause)
      })
    })

    return {
      target: `http://127.0.0.1:${String(port)}`,
      exitCause: () => cause,
      exited,
      logTail: async lines => logs.slice(-lines),
      startupToken: async () => announced,
      async stop() {
        if (cause !== null) return
        child.kill('SIGTERM')
        await Promise.race([
          exited,
          new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
        ])
        if (cause === null) child.kill('SIGKILL')
      },
    }
  }
}
