import { describe, expect, it } from 'vitest'

import { isDshHttpPath, pathnameOf } from './paths.js'

describe('DSH path matching', () => {
  it('claims the paths a Runtime serves', () => {
    for (const path of [
      '/assistant',
      '/assistant/anything',
      '/api/session.create',
      '/api/events.mux',
      '/plugins/acme/panel.js',
      '/assets/index-abc123.js',
      '/favicon.svg',
      '/manifest.webmanifest',
    ]) {
      expect(isDshHttpPath(path), path).toBe(true)
    }
  })

  it('leaves the host application its own routes', () => {
    for (const path of ['/', '/auth/start', '/demo', '/apiary', '/assistantship', '/assets']) {
      expect(isDshHttpPath(path), path).toBe(false)
    }
  })

  it('reads the pathname without query or fragment', () => {
    expect(pathnameOf('/api/session.create?trace=1')).toBe('/api/session.create')
    expect(pathnameOf('/assistant#panel')).toBe('/assistant')
  })

  it('falls back to a path no Runtime claims when the target is unusable', () => {
    expect(pathnameOf(undefined)).toBe('/')
    expect(isDshHttpPath(pathnameOf(undefined))).toBe(false)
  })

  it('does not let a traversal-looking target masquerade as a host route', () => {
    // Normalization happens in the URL parser, so `..` cannot walk out of /api
    // and reach a path the gateway would hand to the host unchecked.
    expect(pathnameOf('/api/../assistant')).toBe('/assistant')
  })
})
