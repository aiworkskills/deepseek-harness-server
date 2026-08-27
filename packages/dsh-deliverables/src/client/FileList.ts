/**
 * Browse one session's workspace in the details panel.
 *
 * This is the surface that does not care how a file came to exist. DSH's chips
 * and file mentions both read the produced-file accumulator, which recognises a
 * mutation by render intent — a diff card, or a generic card whose kind is
 * `edit`. A model that types out an HTML report gets a chip; the same report
 * written as `.docx` or `.pptx` gets none, because a binary format can only be
 * produced by running a script and a terminal produces nothing by that rule.
 *
 * The split is invisible and reads as a broken feature: same request, same
 * session, one result clickable and the other not. Listing the workspace closes
 * it without touching DSH's rule, which is correct for what it does.
 *
 * `createElement` rather than JSX, and no imports beyond React: this bundle is
 * linked into a profile with no `node_modules` beside it (`tests/bundle.spec.ts`
 * holds that line).
 */
import { createElement as h, useEffect, useState, type ReactNode } from 'react'

import { deliverableListUrl, type DeliverableEntry } from '../contract.js'

const FOLDER_ICON = 'M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z'
const FILE_ICON = 'M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z'
const UP_ICON = 'M19 12H5M12 19l-7-7 7-7'
const CLOSE_ICON = 'M18 6 6 18M6 6l12 12'

function icon(path: string): ReactNode {
  return h('svg', {
    width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, focusable: false, style: { flexShrink: 0, opacity: 0.75 },
  }, h('path', { d: path }))
}

const ACTION_STYLE = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '26px', height: '26px', borderRadius: '6px',
  background: 'none', border: 'none', padding: 0,
  color: 'inherit', cursor: 'pointer',
} as const

const ROW_STYLE = {
  display: 'flex', alignItems: 'center', gap: '8px',
  width: '100%', padding: '7px 12px',
  background: 'none', border: 'none', color: 'inherit',
  font: 'inherit', fontSize: '13px', textAlign: 'left', cursor: 'pointer',
} as const

/** Bytes as something a person reads at a glance. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] as string}`
}

/** The parent of a workspace-relative directory, or null at the root. */
export function parentOf(directory: string): string | null {
  if (directory === '') return null
  const cut = directory.lastIndexOf('/')
  return cut < 0 ? '' : directory.slice(0, cut)
}

interface Listing {
  readonly entries: readonly DeliverableEntry[]
  readonly truncated: boolean
}

function useListing(url: string): { listing: Listing | null; error: string | null } {
  const [state, setState] = useState<{ listing: Listing | null; error: string | null }>({ listing: null, error: null })
  useEffect(() => {
    const abort = new AbortController()
    setState({ listing: null, error: null })
    void fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        return await response.json() as Listing
      })
      .then(listing => { setState({ listing, error: null }) })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setState({ listing: null, error: error instanceof Error ? error.message : String(error) })
      })
    return () => { abort.abort() }
  }, [url])
  return state
}

/**
 * Directories first, then most recently changed.
 *
 * Recency rather than name because of what this panel is for: the file someone
 * opens it to find is almost always the one just produced.
 */
export function sortEntries(entries: readonly DeliverableEntry[]): DeliverableEntry[] {
  return [...entries].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1
    return right.modified - left.modified
  })
}

export interface FileListProps {
  readonly sessionId: string
  readonly directory: string
  readonly onOpenDirectory: (directory: string) => void
  readonly onOpenFile: (path: string) => void
  readonly onClose: () => void
}

export function FileList({ sessionId, directory, onOpenDirectory, onOpenFile, onClose }: FileListProps) {
  const { listing, error } = useListing(deliverableListUrl(sessionId, directory))
  const parent = parentOf(directory)

  const rows: ReactNode[] = []
  if (parent !== null) {
    rows.push(h('button', {
      key: '..', type: 'button', style: ROW_STYLE,
      onClick: () => { onOpenDirectory(parent) },
    }, icon(UP_ICON), h('span', { style: { opacity: 0.75 } }, '返回上一级')))
  }
  for (const entry of listing === null ? [] : sortEntries(listing.entries)) {
    rows.push(h('button', {
      key: entry.path, type: 'button', style: ROW_STYLE, title: entry.path,
      onClick: () => { entry.directory ? onOpenDirectory(entry.path) : onOpenFile(entry.path) },
    },
    icon(entry.directory ? FOLDER_ICON : FILE_ICON),
    h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
    entry.directory
      ? null
      : h('span', { style: { flexShrink: 0, opacity: 0.55, fontSize: '11px' } }, humanSize(entry.size))))
  }

  let content: ReactNode
  if (error !== null) content = h('div', { style: { padding: '16px', opacity: 0.7, fontSize: '13px' } }, `读取失败：${error}`)
  else if (listing === null) content = h('div', { style: { padding: '16px', opacity: 0.7, fontSize: '13px' } }, '正在读取…')
  else if (rows.length === 0) content = h('div', { style: { padding: '16px', opacity: 0.7, fontSize: '13px' } }, '这个目录是空的。')
  else {
    content = h('div', { style: { display: 'flex', flexDirection: 'column' } }, ...rows,
      // Said rather than implied: a listing that silently stopped at the cap
      // reads as "this is everything".
      listing.truncated
        ? h('div', { key: '__more', style: { padding: '8px 12px', opacity: 0.55, fontSize: '11px' } }, '条目过多，仅显示前 500 项。')
        : null)
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', padding: '8px 12px', borderBottom: '1px solid rgba(127,127,127,0.2)',
      },
    },
    h('span', {
      title: directory === '' ? '工作区' : directory,
      style: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, directory === '' ? '工作区文件' : directory),
    h('button', {
      type: 'button', onClick: onClose,
      title: '关闭', 'aria-label': '关闭', style: ACTION_STYLE,
    }, h('svg', {
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, h('path', { d: CLOSE_ICON })))),
    h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' } }, content))
}
