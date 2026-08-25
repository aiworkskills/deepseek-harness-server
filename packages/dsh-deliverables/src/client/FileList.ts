/** The session's files, newest first, each opening its own preview. */
import { createElement as h, type ReactNode } from 'react'

import type { DeliverableEntry } from '../contract.js'
import { basename } from './basename.js'

export interface FileListProps {
  readonly files: readonly DeliverableEntry[] | null
  readonly error: string | null
  readonly onOpen: (path: string) => void
  readonly onRefresh: () => void
  readonly onClose: () => void
}

/** Bytes as something a person reads, not a number to decode. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const HEADER: Record<string, string> = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: '8px', padding: '8px 12px', borderBottom: '1px solid rgba(127,127,127,0.2)',
}

function note(text: string): ReactNode {
  return h('div', { style: { padding: '16px', opacity: 0.7, fontSize: '13px' } }, text)
}

export function FileList({ files, error, onOpen, onRefresh, onClose }: FileListProps) {
  const rows = (): ReactNode => {
    if (error !== null) return note(error)
    if (files === null) return note('正在读取…')
    if (files.length === 0) return note('这个工作区还没有文件。')
    return h('div', { style: { overflow: 'auto', height: '100%' } },
      ...files.map(file => h('button', {
        key: file.path,
        type: 'button',
        title: file.path,
        onClick: () => { onOpen(file.path) },
        style: {
          display: 'flex', alignItems: 'baseline', gap: '8px', width: '100%',
          padding: '6px 12px', background: 'none', border: 'none',
          borderBottom: '1px solid rgba(127,127,127,0.08)',
          color: 'inherit', cursor: 'pointer', textAlign: 'left', fontSize: '13px',
        },
      },
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, basename(file.path)),
      h('span', { style: { fontSize: '11px', opacity: 0.5, flexShrink: 0 } }, humanSize(file.size)))))
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', { style: HEADER },
      h('span', { style: { fontSize: '13px', fontWeight: 600 } }, '文件'),
      h('span', { style: { display: 'flex', gap: '10px', flexShrink: 0 } },
        h('button', { type: 'button', onClick: onRefresh, style: { fontSize: '12px', cursor: 'pointer', background: 'none', border: 'none', color: 'inherit' } }, '刷新'),
        h('button', { type: 'button', onClick: onClose, style: { fontSize: '12px', cursor: 'pointer', background: 'none', border: 'none', color: 'inherit' } }, '关闭'))),
    h('div', { style: { flex: 1, minHeight: 0 } }, rows()))
}
