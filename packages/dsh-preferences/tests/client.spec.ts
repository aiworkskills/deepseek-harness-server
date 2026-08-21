import { describe, expect, it, vi } from 'vitest'
import { connectorDraftProblem, persistTheme, restoreTheme, THEME_STORAGE_KEY } from '../src/client.js'

function storage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next }),
  }
}

describe('browser theme preference', () => {
  it('restores a supported preference', () => {
    const theme = { getTheme: () => ({ preference: 'system' }), setTheme: vi.fn() }
    restoreTheme(theme, storage('dark'))
    expect(theme.setTheme).toHaveBeenCalledWith('dark')
  })

  it('ignores unsupported stored values', () => {
    const theme = { getTheme: () => ({ preference: 'system' }), setTheme: vi.fn() }
    restoreTheme(theme, storage('sepia'))
    expect(theme.setTheme).not.toHaveBeenCalled()
  })

  it('persists supported theme changes', () => {
    const target = storage()
    persistTheme({ preference: 'light' }, target)
    expect(target.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'light')
  })
})

describe('connector settings draft', () => {
  const valid = {
    requestTimeoutMs: '15000',
    writeOperationsEnabled: true,
    minimumWriteReasonLength: '2',
  }

  it('accepts the documented tenant defaults', () => {
    expect(connectorDraftProblem(valid)).toBeUndefined()
  })

  it('rejects out-of-range and fractional numeric values', () => {
    expect(connectorDraftProblem({ ...valid, requestTimeoutMs: '999' })).toMatch(/1000/)
    expect(connectorDraftProblem({ ...valid, minimumWriteReasonLength: '2.5' })).toMatch(/整数/)
  })
})
