/** Browser-local theme persistence; presentation choices never leave the browser. */

export const THEME_STORAGE_KEY = 'dshserver.theme-preference.v1'

const THEME_PREFERENCES = new Set(['light', 'dark', 'system'])

export interface ThemeSnapshot {
  readonly preference: string
}

export interface ThemeFace {
  getTheme(): ThemeSnapshot
  setTheme(id: string): void
}

interface StorageFace {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): StorageFace | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function restoreTheme(theme: ThemeFace, storage = browserStorage()): void {
  if (storage === undefined) return
  try {
    const preference = storage.getItem(THEME_STORAGE_KEY)
    if (preference !== null && THEME_PREFERENCES.has(preference)) theme.setTheme(preference)
  } catch {
    // Storage may be disabled by browser privacy policy.
  }
}

export function persistTheme(snapshot: ThemeSnapshot, storage = browserStorage()): void {
  if (storage === undefined || !THEME_PREFERENCES.has(snapshot.preference)) return
  try {
    storage.setItem(THEME_STORAGE_KEY, snapshot.preference)
  } catch {
    // A quota or privacy failure must not break theme switching.
  }
}
