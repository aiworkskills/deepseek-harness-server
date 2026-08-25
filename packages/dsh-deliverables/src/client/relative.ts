/**
 * A workspace-relative path for a file the chat asked to open, or null.
 *
 * The chat resolves a produced path against the session's cwd before calling
 * `openPath`, so what arrives is absolute. The file route addresses files
 * relative to the workspace, and only files: a request for the workspace root
 * itself is the "show in folder" gesture, which has no preview.
 */
export function workspaceRelative(cwd: string, absolute: string): string | null {
  const root = cwd.replace(/[/\\]+$/, '')
  if (root === '' || absolute === root) return null
  const separator = absolute.includes('\\') && !absolute.includes('/') ? '\\' : '/'
  if (!absolute.startsWith(`${root}${separator}`)) return null
  const relative = absolute.slice(root.length + 1).split(/[/\\]+/).filter(Boolean).join('/')
  // A climb back out through the relative half would be resolved by the route
  // anyway, but there is no reason to send one.
  return relative === '' || relative.split('/').includes('..') ? null : relative
}
