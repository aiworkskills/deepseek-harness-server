/**
 * Browser half: a session's files, viewable in the browser.
 *
 * DSH's own produced-file chips hand a path to the *Host's* desktop opener.
 * That is right when the browser and the Host are one machine; in a hosted
 * deployment they are not, so the call reaches a server with no desktop and
 * the file stays out of reach. This plugin adds a door the browser can
 * actually walk through: a sidebar entry that lists what the session wrote and
 * shows any of it in the details panel.
 *
 * It deliberately does not try to replace those chips. Doing so would mean
 * re-registering the accumulator that decides what one turn "produced", and
 * that lives inside DSH's deliverables plugin — reachable in its repository,
 * absent from its published package (its `files` ships `lib` only). A second
 * implementation would have to re-derive it from internal event shapes and
 * would drift silently the first time they changed. Listing the workspace
 * needs none of that, and shows earlier turns' work too.
 */
import { createElement as h, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

import { deliverableListUrl, type DeliverableEntry } from './contract.js'
import { FileList } from './client/FileList.js'
import { Preview } from './client/Preview.js'
import { createSelectionStore, type SelectionStore } from './client/store.js'

export { createSelectionStore, type Selection, type SelectionStore } from './client/store.js'
export { FileList } from './client/FileList.js'
export { Preview } from './client/Preview.js'
export { basename } from './client/basename.js'

export const inject = ['slots', 'layout', 'sessions']

async function fetchListing(sessionId: string, signal: AbortSignal): Promise<readonly DeliverableEntry[]> {
  const response = await fetch(deliverableListUrl(sessionId), {
    cache: 'no-store', credentials: 'same-origin', signal,
  })
  if (!response.ok) throw new Error(`列出文件失败(HTTP ${String(response.status)})`)
  const body = await response.json() as { files?: readonly DeliverableEntry[] }
  return body.files ?? []
}

function Panel({ store, sessionId, onClose }: {
  store: SelectionStore
  sessionId: string
  onClose: () => void
}) {
  const selection = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [files, setFiles] = useState<readonly DeliverableEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setError(null)
    void fetchListing(sessionId, abort.signal)
      .then(setFiles)
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { abort.abort() }
  }, [sessionId, nonce])

  // The agent keeps working while the panel is open, so a refresh has to be
  // available; polling instead would fight the agent for the same disk.
  const refresh = useCallback(() => { setNonce(value => value + 1) }, [])

  if (selection !== null) {
    return h(Preview, {
      sessionId: selection.sessionId,
      path: selection.path,
      onBack: () => { store.clear() },
      onClose,
    })
  }
  return h(FileList, {
    files,
    error,
    onRefresh: refresh,
    onClose,
    onOpen: (path: string) => { store.select({ sessionId, path }) },
  })
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

  const open = (): void => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) return
    // The details panel is a single seat, so the registration is held only
    // while the panel is open — otherwise this plugin would take it from
    // whatever else a deployment puts there for the whole session.
    mounted ??= ctx.slots.inject('details', () => ctx.slots.register({
      name: 'details',
      priority: -20,
    }, () => h(Panel, { store, sessionId, onClose: close })))
    ctx.layout.openDetails()
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dshserver-deliverables',
    order: 30,
    inject: () => ({ open }),
  }, function DeliverablesAction({ open: openPanel }: { open: () => void }) {
    return h('button', {
      type: 'button',
      onClick: openPanel,
      title: '本会话产生的文件',
      style: {
        display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
        padding: '6px 8px', background: 'none', border: 'none',
        color: 'inherit', cursor: 'pointer', fontSize: '13px', textAlign: 'left',
      },
    }, '文件')
  }))

  ctx.effect(() => () => { mounted?.(); mounted = undefined }, 'dshserver-deliverables: details seat')
}
