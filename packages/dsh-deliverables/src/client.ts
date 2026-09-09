/**
 * Browser half: a produced file opens in the Sidebar, not on the server.
 *
 * In a hosted deployment the browser and the Runtime host are different
 * machines, and that host has no desktop and nobody sitting at it. So "open
 * this file" cannot mean "hand the path to the host's opener" — the only
 * possible answer would be a refusal, for a file the user was just told about.
 *
 * This plugin registers one right-Sidebar tab type that draws such a file in
 * the browser instead. It claims by extension, and only the kinds the Sidebar's
 * builtin text viewer cannot show: a rendered page, an image, and the
 * office/PDF formats it would print as mojibake. Markdown, JSON and source fall
 * through to that builtin, which pages them and tracks lines.
 *
 * Closing the host-desktop exit is a separate, load-bearing job that this
 * plugin cannot do from the browser: it lives in the Gateway's RPC blocklist
 * (`session.openWorkspacePath`) and the profile's `open-in-app` switch. See
 * this package's README — a deployment that registers the tab type but leaves
 * that exit open has fixed nothing.
 */
import { createElement as h, memo, useMemo, type ReactNode } from 'react'
// Type-only, all of it: this bundle is linked into a profile with no
// `node_modules` beside it and may import nothing at runtime but React.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

import {
  DELIVERABLE_TAB_ID, DELIVERABLE_TAB_KIND, DELIVERABLE_TAB_PATTERNS, parseSessionFileAddress,
} from './contract.js'
import { Preview } from './client/Preview.js'
import { basename } from './client/basename.js'

/** Same tree for the same file; the layout churn above must not redraw it. */
const MemoPreview = memo(Preview)

export {
  DELIVERABLE_TAB_ID, DELIVERABLE_TAB_KIND, DELIVERABLE_TAB_PATTERNS, PREVIEWED_EXTENSIONS,
  parseSessionFileAddress,
} from './contract.js'

export const inject = ['slots', 'sidebarRightTabs']

/** The body's composed props: the tab hook and the session standard kit. */
export type DeliverablePreviewProps = PropsRuntime<'sidebar.right.pane.tab'>

/**
 * What this type IS, as the registry lists it.
 *
 * No `priority`: the default is `extension`, which is the honest band for a type
 * from outside the product and the one that outranks the builtin viewer.
 * @returns the definition to register.
 */
export function deliverableTabDefinition(): SidebarRightTabDefinition {
  return {
    id: DELIVERABLE_TAB_ID,
    kind: DELIVERABLE_TAB_KIND,
    patterns: DELIVERABLE_TAB_PATTERNS,
    // The globs match on extension alone, which says nothing about scope. An
    // `absolute` address is a real file the builtin can still show, so declining
    // it here is what keeps it viewable rather than broken.
    canOpen: (address) => parseSessionFileAddress(address) !== null,
    title: (address) => {
      const parsed = parseSessionFileAddress(address)
      return parsed === null ? address : basename(parsed.path)
    },
  }
}

/**
 * One produced file's tab body.
 *
 * The address is the content identity, so the path comes from it rather than
 * from any state this plugin keeps: a tab restored into a new page load draws
 * the same file without this plugin having persisted anything.
 * @param props - composed slot props.
 * @returns the file, or nothing when the address is not one this type opens.
 */
export function DeliverablePreview({ useTabInfo }: DeliverablePreviewProps): ReactNode {
  const { tab } = useTabInfo()
  // `useTabInfo` re-memoizes on the whole sidebar layout, so a split drag hands
  // us a new `tab` on every pointer-move. The address is the only input that
  // matters, and re-parsing it per frame is pure waste.
  const parsed = useMemo(() => parseSessionFileAddress(tab.contentId), [tab.contentId])
  // Defensive: `canOpen` declined these, so only a restored tab could arrive here.
  if (parsed === null) return null
  return h(MemoPreview, { sessionId: parsed.sessionId, path: parsed.path })
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(deliverableTabDefinition()),
    'dshserver-deliverables: produced-file tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: DELIVERABLE_TAB_ID },
    DeliverablePreview,
  )), 'dshserver-deliverables: produced-file tab body')
}
