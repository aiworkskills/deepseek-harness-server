/**
 * The process backend against a real child process.
 *
 * The contract under test is the one the manager depends on: the target
 * answers, the exit cause is observable both ways, output is retained for
 * failure reports, and stop() actually ends the child.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ProcessRuntimeBackend } from './backend-process.js'
import { runtimeLayout } from './runtime-provision.js'
import type { RuntimeHandle } from './runtime-backend.js'
import type { RuntimePrincipal } from './types.js'

const principal: RuntimePrincipal = {
  issuer: 'https://iam.example.com', tenantId: 'acme', subject: 'user-1', teamId: 'sales',
  clientId: 'business-web', name: 'User One', role: 'employee', expiresAt: 1_900_000_000, tokenId: 'token-1',
  scopes: ['assistant:use'], presetRole: 'employee', tools: [],
  models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], policyRevision: 1, canConfigureDsh: false,
}

/** A stand-in CLI: honours `--port` like the real one, so the probe is genuine. */
const FAKE_CLI = `
const http = require('node:http')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
console.log('fake runtime starting')
http.createServer((request, response) => { response.end('ok') }).listen(port, '127.0.0.1')
`

const CRASHING_CLI = `
console.error('refusing to start')
process.exit(7)
`

let root: string | undefined
const handles: RuntimeHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async handle => { await handle.stop() }))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function startWith(cliSource: string): Promise<RuntimeHandle> {
  root = await mkdtemp(join(tmpdir(), 'dshserver-backend-'))
  // No package.json in the temp tree, so `.js` resolves as CommonJS.
  const layout = runtimeLayout(
    { projectRoot: root, dshSourceRoot: join(root, 'harness'), runtimeRoot: join(root, 'users') },
    'subject-key',
    principal,
  )
  await mkdir(dirname(layout.cli), { recursive: true })
  await mkdir(layout.workspace, { recursive: true })
  await writeFile(layout.cli, cliSource)
  const handle = await new ProcessRuntimeBackend().start({
    key: 'subject-key',
    layout,
    env: { PATH: process.env.PATH },
    publicHost: '127.0.0.1:4173',
  })
  handles.push(handle)
  return handle
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new Error('condition not reached in time')
}

describe('process runtime backend', () => {
  it('starts a child whose target answers and whose output is retained', async () => {
    const handle = await startWith(FAKE_CLI)
    expect(handle.exitCause()).toBeNull()
    await eventually(async () => {
      try {
        return (await fetch(handle.target, { signal: AbortSignal.timeout(300) })).ok
      } catch {
        return false
      }
    })
    await eventually(() => handle.logTail(10).some(line => line.includes('fake runtime starting')))
  })

  it('reports the exit cause both synchronously and as a promise', async () => {
    const handle = await startWith(CRASHING_CLI)
    await expect(handle.exited).resolves.toBe(7)
    expect(handle.exitCause()).toBe(7)
    expect(handle.logTail(10).join('\n')).toContain('refusing to start')
  })

  it('stop() ends the child and is idempotent', async () => {
    const handle = await startWith(FAKE_CLI)
    await handle.stop()
    expect(handle.exitCause()).not.toBeNull()
    await handle.stop()
  })
})
