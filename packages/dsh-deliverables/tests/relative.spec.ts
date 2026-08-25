/**
 * The chat resolves a produced path against the session cwd before opening it,
 * so what this plugin intercepts is absolute. Turning it back into a
 * workspace-relative path is what decides whether a click is ours to answer.
 */
import { describe, expect, it } from 'vitest'

import { workspaceRelative } from '../src/client/relative.js'

describe('workspace-relative path', () => {
  it('relativizes a file inside the workspace', () => {
    expect(workspaceRelative('/srv/ws', '/srv/ws/drafts/article.html')).toBe('drafts/article.html')
    // A trailing separator on the cwd must not shift the slice.
    expect(workspaceRelative('/srv/ws/', '/srv/ws/a.txt')).toBe('a.txt')
  })

  it('declines the workspace root itself', () => {
    // `openFile('.')` — the show-in-folder gesture. A directory has no preview,
    // so it belongs to the original opener, not here.
    expect(workspaceRelative('/srv/ws', '/srv/ws')).toBeNull()
    expect(workspaceRelative('/srv/ws', '/srv/ws/')).toBeNull()
  })

  it('declines anything outside the workspace', () => {
    expect(workspaceRelative('/srv/ws', '/etc/passwd')).toBeNull()
    // A sibling that merely shares the prefix string is not inside it.
    expect(workspaceRelative('/srv/ws', '/srv/ws-other/a.txt')).toBeNull()
  })

  it('declines a relative half that climbs back out', () => {
    expect(workspaceRelative('/srv/ws', '/srv/ws/../outside/x')).toBeNull()
  })

  it('normalizes Windows separators to the route spelling', () => {
    expect(workspaceRelative('C:\\ws', 'C:\\ws\\drafts\\a.html')).toBe('drafts/a.html')
  })
})
