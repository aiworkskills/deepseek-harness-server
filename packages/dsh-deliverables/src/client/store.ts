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
  /**
   * The directory to return to, or null when the file was opened from the
   * conversation.
   *
   * This is what makes "back" honest. A file reached by browsing has somewhere
   * to go back to; a file reached by clicking a chip does not, and offering a
   * back button that lands somewhere the user never was is worse than not
   * offering one.
   */
  readonly from?: string | null
}

/** Browsing the workspace rather than showing one file. */
export interface Browsing {
  readonly sessionId: string
  readonly directory: string
}

export type View =
  | { readonly mode: 'file'; readonly selection: Selection }
  | { readonly mode: 'browse'; readonly browsing: Browsing }

export interface SelectionStore {
  subscribe(listener: () => void): () => void
  snapshot(): View | null
  select(selection: Selection): void
  browse(browsing: Browsing): void
  clear(): void
}

export function createSelectionStore(): SelectionStore {
  let current: View | null = null
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
      const shown = current?.mode === 'file' ? current.selection : null
      if (shown?.sessionId === selection.sessionId && shown.path === selection.path
        && shown.from === selection.from) return
      current = { mode: 'file', selection }
      publish()
    },
    browse(browsing) {
      const shown = current?.mode === 'browse' ? current.browsing : null
      if (shown?.sessionId === browsing.sessionId && shown.directory === browsing.directory) return
      current = { mode: 'browse', browsing }
      publish()
    },
    clear() {
      if (current === null) return
      current = null
      publish()
    },
  }
}
