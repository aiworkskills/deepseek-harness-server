/**
 * Render one produced file in its Sidebar tab, by kind.
 *
 * Written with `createElement` rather than JSX to match the rest of this
 * repository's browser halves: one fewer build mode, and the bundle is the
 * same either way.
 */
import { createElement as h, type ReactNode } from 'react'

import { deliverableFileUrl, deliverableKind, type DeliverableKind } from '../contract.js'
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
}

/**
 * 一个产出文件的正文，按类型。
 *
 * 只有三种：这个插件在侧栏 tab 注册表里只认领网页、图片和 PDF/Office，其余交回内置
 * 文本预览。所以这里没有"读取中"和"读取失败"——需要 fetch 才能显示的类型不归本插件。
 * @param kind - 该路径的渲染类型。
 * @param url - 产出文件路由上的地址。
 * @returns 要渲染的正文。
 */
function body(kind: DeliverableKind, url: string): ReactNode {
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
  return h('div', { style: { padding: '16px', opacity: 0.7 } },
    h('p', null, '这个类型不预览。'),
    h('a', { href: url, download: true }, '下载文件'))
}

export function Preview({ sessionId, path }: PreviewProps) {
  const kind = deliverableKind(path)
  const url = deliverableFileUrl(sessionId, path)

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
      // No close control: this renders inside a Sidebar tab, and closing is the
      // tab chrome's — two close buttons would be two gestures for one thing.
      h('a', {
        href: url, download: true,
        title: '下载', 'aria-label': '下载', style: ACTION_STYLE,
      }, icon(DOWNLOAD_ICON)))),
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' } },
      body(kind, url)))
}
