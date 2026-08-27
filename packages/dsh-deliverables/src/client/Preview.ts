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

/**
 * Inline SVG rather than an icon package.
 *
 * This bundle is linked into a profile with no `node_modules` beside it, so the
 * rule is: at runtime, import nothing but Node built-ins and React
 * (`tests/bundle.spec.ts` holds that line). Three glyphs are not worth breaking
 * it for.
 */
function icon(path: string, extra?: ReactNode): ReactNode {
  return h('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, focusable: false,
  }, h('path', { d: path }), extra)
}

const OPEN_ICON = 'M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'
const DOWNLOAD_ICON = 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'
const CLOSE_ICON = 'M18 6 6 18M6 6l12 12'
const BACK_ICON = 'M19 12H5M12 19l-7-7 7-7'

/** Icon-only controls need a name; the tooltip and the accessible name are the same word. */
const ACTION_STYLE = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '26px', height: '26px', borderRadius: '6px',
  background: 'none', border: 'none', padding: 0,
  color: 'inherit', cursor: 'pointer', textDecoration: 'none',
} as const

export interface PreviewProps {
  readonly sessionId: string
  readonly path: string
  readonly onClose: () => void
  /**
   * Return to the listing this file was opened from.
   *
   * Absent when the file was opened from the conversation: a back button that
   * lands somewhere the user was never at is worse than none.
   */
  readonly onBack?: (() => void) | undefined
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

export function Preview({ sessionId, path, onClose, onBack }: PreviewProps) {
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
    h('span', { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
      onBack === undefined
        ? null
        : h('button', {
          type: 'button', onClick: onBack,
          title: '返回文件列表', 'aria-label': '返回文件列表', style: ACTION_STYLE,
        }, icon(BACK_ICON)),
      // Full path in the tooltip: two turns can produce files sharing a basename,
      // and the header stays short.
      h('span', { title: path, style: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, basename(path))),
    h('span', { style: { display: 'flex', gap: '2px', flexShrink: 0 } },
      // Only for the kinds a browser tab can actually render as a document.
      // The response carries `Content-Security-Policy: sandbox allow-scripts`,
      // so the opened tab has an opaque origin — the same confinement the
      // iframe below declares, not a way around it.
      kind === 'html'
        ? h('a', {
          href: url, target: '_blank', rel: 'noopener noreferrer',
          title: '在新标签页打开', 'aria-label': '在新标签页打开', style: ACTION_STYLE,
        }, icon(OPEN_ICON))
        : null,
      h('a', {
        href: url, download: true,
        title: '下载', 'aria-label': '下载', style: ACTION_STYLE,
      }, icon(DOWNLOAD_ICON)),
      h('button', {
        type: 'button', onClick: onClose,
        title: '关闭', 'aria-label': '关闭', style: ACTION_STYLE,
      }, icon(CLOSE_ICON)))),
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' } },
      body(kind, url, text, error)))
}
