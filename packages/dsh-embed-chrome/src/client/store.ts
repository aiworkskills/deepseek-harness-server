/**
 * The chrome the embedding page has supplied, as an external store.
 *
 * It arrives asynchronously (fetch the trusted origin, then a round trip to the
 * page) and is read by two unrelated slot occupants in different parts of the
 * tree, so it lives outside React. `useSyncExternalStore` is how React reads
 * one without tearing.
 */
import type { ChromeState } from '../contract.js'

export interface ChromeStore {
  subscribe(listener: () => void): () => void
  snapshot(): ChromeState | null
  set(state: ChromeState): void
}

export function createChromeStore(): ChromeStore {
  let current: ChromeState | null = null
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    // Identity-stable while unchanged: useSyncExternalStore re-renders whenever
    // the snapshot differs, so a fresh object per call would spin forever.
    snapshot: () => current,
    set(state) {
      current = state
      for (const listener of [...listeners]) listener()
    },
  }
}
