/**
 * Browser half: a produced file opens in the details panel, not on the server.
 *
 * DSH's produced-file chips, its inline file mentions and its tool rows all
 * open a file the same way — `workspaces.openPath`, which hands the path to
 * the *Host's* desktop opener. That is right when the browser and the Host are
 * one machine. In a hosted deployment they are not: the call reaches a server
 * with no desktop and no user in front of it, so the only possible answer is a
 * refusal, and the file the user was just told about stays out of reach.
 *
 * So this plugin changes what opening means here, at the one place all three
 * surfaces go through: it decorates `workspaces.openPath` at composition time.
 * A path inside the current session's workspace is shown in the details panel;
 * anything else is delegated to the original, unchanged.
 *
 * The alternative was replacing DSH's deliverables plugin with a copy whose
 * chips call something else. That needs the accumulator deciding what a turn
 * "produced", which lives inside that plugin and is absent from its published
 * package (its `files` ships `lib` only) — so it would have to be re-derived
 * from internal event shapes and would drift silently the first time they
 * changed. Decorating one method leaves that vocabulary where it belongs and
 * fixes the chips, the mentions and the tool rows together.
 */
import { createElement as h, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Declares `conversation.session.header.utilities` in the SlotMap. Type-only, so
// nothing is imported at runtime — this bundle is linked into a profile with no
// `node_modules` beside it. Without it the slot key is not merely unknown, it is
// rejected: the map would only carry the layout package's root-level seats.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

import { DETAILS_PRIORITY } from './contract.js'
import { Preview } from './client/Preview.js'
import { FileList } from './client/FileList.js'
import { createSelectionStore } from './client/store.js'

export {
  createSelectionStore, type Browsing, type Selection, type SelectionStore, type View,
} from './client/store.js'
export { Preview } from './client/Preview.js'
export { FileList, humanSize, parentOf, sortEntries } from './client/FileList.js'
export { basename } from './client/basename.js'
export { workspaceRelative } from './client/relative.js'

import { workspaceRelative } from './client/relative.js'

export const inject = ['slots', 'layout', 'sessions', 'workspaces']

/** The shape this plugin decorates; the runtime service has much more on it. */
interface OpenPathFace {
  openPath(path: string): Promise<void>
}

export function apply(ctx: ClientContext): void {
  const store = createSelectionStore()
  let mounted: (() => void) | undefined

  const close = (): void => {
    store.clear()
    mounted?.()
    mounted = undefined
    ctx.layout.closeDetails()
  }

  function DetailsPreview() {
    const view = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
    if (view === null) return null
    if (view.mode === 'browse') {
      const { sessionId, directory } = view.browsing
      return h(FileList, {
        sessionId,
        directory,
        onOpenDirectory: next => { store.browse({ sessionId, directory: next }) },
        onOpenFile: path => { store.select({ sessionId, path, from: directory }) },
        onClose: close,
      })
    }
    const { sessionId, path, from } = view.selection
    return h(Preview, {
      sessionId,
      path,
      onClose: close,
      onBack: from === undefined || from === null
        ? undefined
        : () => { store.browse({ sessionId, directory: from }) },
    })
  }

  // The details panel is a single seat, so the registration is held only while
  // something of ours is open — otherwise this plugin would keep the seat from
  // whatever else a deployment puts there for the rest of the session.
  const takeSeat = (): void => {
    mounted ??= ctx.slots.inject('details', () => ctx.slots.register({
      name: 'details',
      priority: DETAILS_PRIORITY,
    }, DetailsPreview))
    ctx.layout.openDetails()
  }

  const show = (sessionId: string, path: string): void => {
    store.select({ sessionId, path })
    takeSeat()
  }

  const browse = (sessionId: string, directory: string): void => {
    store.browse({ sessionId, directory })
    takeSeat()
  }

  const workspaces = ctx.workspaces as unknown as OpenPathFace
  const original = workspaces.openPath.bind(workspaces)

  workspaces.openPath = async (path: string): Promise<void> => {
    const sessions = ctx.sessions.list.getSnapshot()
    const sessionId = sessions.current
    const cwd = sessionId === undefined ? undefined : sessions.byId[sessionId]?.cwd
    const relative = cwd === undefined ? null : workspaceRelative(cwd, path)
    if (sessionId === undefined || relative === null) {
      // A directory, or something outside this session's workspace. Not ours to
      // show, and swallowing it would turn a real failure into silence.
      await original(path)
      return
    }
    show(sessionId, relative)
  }

  /**
   * The one entry point that does not depend on how a file was made.
   *
   * Everything else here reacts to DSH deciding a turn produced something, and
   * that decision reads render intent: an edit card counts, a terminal card does
   * not. So a report the model typed out as HTML is clickable and the same
   * report as `.docx` is not — the binary can only come from running a script.
   * A button that just lists the workspace has no such blind spot.
   */
  function WorkspaceButton() {
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) return null
    return h('button', {
      type: 'button',
      title: '工作区文件',
      'aria-label': '工作区文件',
      onClick: () => { browse(sessionId, '') },
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '28px', height: '28px', borderRadius: '6px',
        background: 'none', border: 'none', padding: 0,
        color: 'inherit', cursor: 'pointer',
      },
    }, h('svg', {
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, h('path', { d: 'M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z' })))
  }

  // The composer tool row, not the session header.
  //
  // Both are `list` seats and the header is where this belongs semantically —
  // it is session-level, and DSH's own "download session log" action sits there.
  // But a slot exists only while the entry declaring it is mounted, and those
  // two entries are not equally certain: `conversation.session.header.utilities`
  // needs the session *header* mounted, while this one needs only
  // `conversation` — the centre column, which is present whenever the user can
  // type at all. In the embedded dock the header is not guaranteed, and a button
  // that silently never renders is exactly the failure this whole surface exists
  // to fix. Certain beats tidy.
  //
  // A `list` seat needs an id of its own. No `priority`: the browser-half facade
  // assigns one, and hand-picking it is how two contributions collide.
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dshserver-workspace-files',
  }, WorkspaceButton)), 'dshserver-deliverables: workspace button')

  ctx.effect(() => () => {
    workspaces.openPath = original
    mounted?.()
    mounted = undefined
  }, 'dshserver-deliverables: open-path takeover')
}
