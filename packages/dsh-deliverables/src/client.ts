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

import { DETAILS_PRIORITY } from './contract.js'
import { Preview } from './client/Preview.js'
import { createSelectionStore } from './client/store.js'

export { createSelectionStore, type Selection, type SelectionStore } from './client/store.js'
export { Preview } from './client/Preview.js'
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
    const selection = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
    if (selection === null) return null
    return h(Preview, { sessionId: selection.sessionId, path: selection.path, onClose: close })
  }

  const show = (sessionId: string, path: string): void => {
    store.select({ sessionId, path })
    // The details panel is a single seat, so the registration is held only
    // while a preview is open — otherwise this plugin would keep the seat from
    // whatever else a deployment puts there for the rest of the session.
    mounted ??= ctx.slots.inject('details', () => ctx.slots.register({
      name: 'details',
      priority: DETAILS_PRIORITY,
    }, DetailsPreview))
    ctx.layout.openDetails()
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

  ctx.effect(() => () => {
    workspaces.openPath = original
    mounted?.()
    mounted = undefined
  }, 'dshserver-deliverables: open-path takeover')
}
