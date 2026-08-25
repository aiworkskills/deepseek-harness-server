/**
 * Render one produced file in the details panel, by kind.
 *
 * Written with `createElement` rather than JSX to match the rest of this
 * repository's browser halves: one fewer build mode, and the bundle is the
 * same either way.
 */
import { createElement as h, useEffect, useState, type ReactNode } from 'react'

import { deliverableFileUrl, deliverableKind } from '../contract.js'
import { basename } from './basename.js'

export interface PreviewProps {
  readonly sessionId: string
  readonly path: string
  readonly onClose: () => void
}

/** Text kinds are fetched rather than framed, so they can be shown as text. */
function useFileText(url: string, enabled: boolean): { text: string | null; error: string | null } {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null })
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    setState({ text: null, error: null })
    void fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        return await response.text()
      })
      .then(text => { setState({ text, error: null }) })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setState({ text: null, error: error instanceof Error ? error.message : String(error) })
      })
    return () => { abort.abort() }
  }, [url, enabled])
  return state
}

function body(kind: ReturnType<typeof deliverableKind>, url: string, text: string | null, error: string | null): ReactNode {
  if (kind === 'html') {
    return h('iframe', {
      // `allow-scripts` without `allow-same-origin`, and never both: with both,
      // the document can remove its own sandbox attribute and the confinement
      // is decorative. Alone, `allow-scripts` gives the file an opaque origin —
      // scripts run, so a produced page or game works, while the session
      // cookie, the `/api` surface and this document stay unreachable. Produced
      // files are written by a model, which is reason enough.
      sandbox: 'allow-scripts',
      src: url,
      style: { width: '100%', height: '100%', border: 'none', background: '#fff' },
    })
  }
  if (kind === 'image') {
    return h('img', { src: url, alt: '', style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } })
  }
  if (kind === 'binary') {
    return h('div', { style: { padding: '16px', opacity: 0.7 } },
      h('p', null, '这个类型不预览。'),
      h('a', { href: url, download: true }, '下载文件'))
  }
  if (error !== null) return h('div', { style: { padding: '16px', opacity: 0.7 } }, `读取失败:${error}`)
  if (text === null) return h('div', { style: { padding: '16px', opacity: 0.7 } }, '正在读取…')
  return h('pre', {
    style: {
      margin: 0, padding: '16px', overflow: 'auto', height: '100%',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', lineHeight: 1.6,
    },
  }, text)
}

export function Preview({ sessionId, path, onClose }: PreviewProps) {
  const kind = deliverableKind(path)
  const url = deliverableFileUrl(sessionId, path)
  const { text, error } = useFileText(url, kind !== 'html' && kind !== 'image' && kind !== 'binary')

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', padding: '8px 12px', borderBottom: '1px solid rgba(127,127,127,0.2)',
      },
    },
    // Full path in the tooltip: two turns can produce files sharing a basename,
    // and the header stays short.
    h('span', { title: path, style: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, basename(path)),
    h('span', { style: { display: 'flex', gap: '10px', flexShrink: 0 } },
      h('a', { href: url, download: true, style: { fontSize: '12px' } }, '下载'),
      h('button', { type: 'button', onClick: onClose, style: { fontSize: '12px', cursor: 'pointer', background: 'none', border: 'none', color: 'inherit' } }, '关闭'))),
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' } },
      body(kind, url, text, error)))
}
