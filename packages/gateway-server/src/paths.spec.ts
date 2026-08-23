import { describe, expect, it } from 'vitest'

import { isDshHttpPath, pathnameOf, runtimeTarget } from './paths.js'

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
    ]) {
      expect(isDshHttpPath(path), path).toBe(true)
    }
  })

  it('leaves the web app manifest to the host', () => {
    // Browsers fetch a manifest without credentials, so proxying it behind
    // authentication turns every page load into a console 401.
    expect(isDshHttpPath('/manifest.webmanifest')).toBe(false)
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

describe('assistant mount rewriting', () => {
  it('maps the mount point onto the Runtime web app at the root', () => {
    // A Runtime serves its app at `/`; `/assistant` is only where the deployment
    // exposes it. Forwarding the mount path unchanged yields a 404 from the app.
    expect(runtimeTarget('/assistant')).toBe('/')
    expect(runtimeTarget('/assistant/')).toBe('/')
    expect(runtimeTarget('/assistant/settings')).toBe('/settings')
  })

  it('keeps the query string across the rewrite', () => {
    expect(runtimeTarget('/assistant?session=abc')).toBe('/?session=abc')
  })

  it('leaves absolute app paths alone', () => {
    // These already carry the path the app asked for; rewriting would break them.
    for (const path of ['/api/session.create', '/assets/index-abc.js', '/plugins/x/panel.js', '/favicon.svg']) {
      expect(runtimeTarget(path), path).toBe(path)
    }
  })

  it('does not treat a longer name as the mount point', () => {
    expect(runtimeTarget('/assistantship')).toBe('/assistantship')
  })
})
