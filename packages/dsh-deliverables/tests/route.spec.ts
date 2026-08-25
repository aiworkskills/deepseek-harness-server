/**
 * The route serves files out of a Subject's workspace, so containment is the
 * property under test. Everything else here is plumbing; an escape is a
 * cross-tenant read.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { confineToWorkspace, createDeliverableHandler } from '../src/index.js'
import {
  DELIVERABLE_FILE_ROUTE, contentTypeOf, deliverableFileUrl, deliverableKind, parseDeliverableRequest,
} from '../src/contract.js'

let root: string
let workspace: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deliverables-'))
  workspace = join(root, 'workspace')
  outside = join(root, 'outside')
  await mkdir(join(workspace, 'drafts'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'drafts', 'article.html'), '<p>hi</p>')
  await writeFile(join(outside, 'secret.txt'), 'tenant-owned-secret')
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

interface Captured { status: number; headers: Record<string, unknown>; body: string }

function mockResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' }
  const res = {
    setHeader() {},
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      captured.headers = headers ?? {}
      return res
    },
    end(chunk?: string) { if (chunk !== undefined) captured.body += chunk },
    on() { return res },
    once() { return res },
    emit() { return false },
    write(chunk: string) { captured.body += chunk; return true },
  } as unknown as ServerResponse
  return { res, captured }
}

async function call(url: string, method = 'GET'): Promise<Captured> {
  const handler = createDeliverableHandler(sessionId => (sessionId === 's1' ? workspace : undefined))
  const { res, captured } = mockResponse()
  await handler({ method, url } as IncomingMessage, res)
  return captured
}

describe('workspace confinement', () => {
  it('resolves a file inside the workspace', async () => {
    expect(await confineToWorkspace(workspace, 'drafts/article.html')).toContain('article.html')
  })

  it('refuses to climb out with ..', async () => {
    expect(await confineToWorkspace(workspace, '../outside/secret.txt')).toBeNull()
    expect(await confineToWorkspace(workspace, 'drafts/../../outside/secret.txt')).toBeNull()
  })

  it('refuses an absolute path', async () => {
    expect(await confineToWorkspace(workspace, join(outside, 'secret.txt'))).toBeNull()
  })

  it('refuses a symlink that points out of the workspace', async () => {
    // The escape a produced file can arrange for itself: the path stays inside,
    // the target does not. Comparing resolved strings alone would admit it.
    await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.txt'))
    expect(await confineToWorkspace(workspace, 'escape.txt')).toBeNull()
  })

  it('refuses a NUL byte rather than handing it to the filesystem', async () => {
    expect(await confineToWorkspace(workspace, 'drafts/\0article.html')).toBeNull()
  })
})

describe('deliverable route', () => {
  it('serves a file from the addressed session workspace', async () => {
    const result = await call(deliverableFileUrl('s1', 'drafts/article.html'))
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('text/html; charset=utf-8')
    // Sniffing off, so the declared type is the one the browser honours.
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(result.headers['cache-control']).toBe('no-store')
  })

  it('never serves a file outside the workspace, however the climb is spelled', async () => {
    // Two independent barriers, and it is worth knowing which one catches what.
    // Dot segments never reach this code at all: the URL parser removes them
    // while normalizing the pathname, and it does so for `%2e%2e` too — the URL
    // standard treats `%2e` as `.` when deciding what is a double-dot segment.
    // What survives normalization is a path that looks ordinary and resolves
    // elsewhere, which is what the containment check is for.
    for (const url of [
      `${DELIVERABLE_FILE_ROUTE}/s1/../outside/secret.txt`,
      `${DELIVERABLE_FILE_ROUTE}/s1/%2e%2e/outside/secret.txt`,
      `${DELIVERABLE_FILE_ROUTE}/s1/drafts/%2e%2e/%2e%2e/outside/secret.txt`,
    ]) {
      const result = await call(url)
      expect(result.status).toBe(404)
      expect(result.body).not.toContain('tenant-owned-secret')
    }
  })

  it('refuses a symlink escape through the route, not just the helper', async () => {
    await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.txt'))
    const result = await call(deliverableFileUrl('s1', 'escape.txt'))
    expect(result.status).toBe(404)
    expect(result.body).not.toContain('tenant-owned-secret')
  })

  it('refuses an unknown session', async () => {
    expect((await call(deliverableFileUrl('other', 'drafts/article.html'))).status).toBe(404)
  })

  it('refuses a method that is not a read', async () => {
    expect((await call(deliverableFileUrl('s1', 'drafts/article.html'), 'POST')).status).toBe(405)
  })
})

describe('request shape', () => {
  it('round-trips a session and path through the URL path', () => {
    // Path-shaped on purpose: a produced article refers to its images
    // relatively, and only a path-shaped URL resolves those to this route.
    const url = deliverableFileUrl('s1', 'drafts/a b/article.html')
    expect(parseDeliverableRequest(url)).toEqual({ sessionId: 's1', path: 'drafts/a b/article.html' })
  })

  it('declines anything that is not this route', () => {
    expect(parseDeliverableRequest('/plugins/other/file/s1/a.html')).toBeNull()
    expect(parseDeliverableRequest('/plugins/dshserver/deliverables/file/s1')).toBeNull()
  })
})

describe('kind and content type', () => {
  it('routes each extension to how the browser half should show it', () => {
    expect(deliverableKind('a/b.html')).toBe('html')
    expect(deliverableKind('cover.PNG')).toBe('image')
    expect(deliverableKind('notes.md')).toBe('markdown')
    expect(deliverableKind('data.json')).toBe('json')
    expect(deliverableKind('run.py')).toBe('text')
    expect(deliverableKind('archive.zip')).toBe('binary')
    expect(deliverableKind('Makefile')).toBe('binary')
  })

  it('declares octet-stream for anything it cannot name', () => {
    expect(contentTypeOf('archive.zip')).toBe('application/octet-stream')
    expect(contentTypeOf('page.html')).toBe('text/html; charset=utf-8')
  })
})

