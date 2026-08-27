/**
 * Which produced file the details panel is showing.
 *
 * The chips live in the conversation and the preview lives in the details
 * panel, so the selection has to exist outside both. A minimal external store
 * — subscribe, read, set — is enough, and `useSyncExternalStore` is how React
 * reads one without tearing.
 */

export interface Selection {
  readonly sessionId: string
  readonly path: string
}

export interface SelectionStore {
  subscribe(listener: () => void): () => void
  snapshot(): Selection | null
  select(selection: Selection): void
  clear(): void
}

export function createSelectionStore(): SelectionStore {
  let current: Selection | null = null
  const listeners = new Set<() => void>()
  const publish = (): void => { for (const listener of [...listeners]) listener() }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    // Returned by identity while unchanged: useSyncExternalStore re-renders
    // whenever the snapshot differs, so a fresh object each call would spin.
    snapshot: () => current,
    select(selection) {
      if (current?.sessionId === selection.sessionId && current.path === selection.path) return
      current = selection
      publish()
    },
    clear() {
      if (current === null) return
      current = null
      publish()
    },
  }
}
