/**
 * Browser plugin composition root: restore the user's presentation choices,
 * accept prepared sentences from the embedding business system, and contribute
 * the tenant policy card to DSH's native settings page.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createElement as h } from 'react'

import { persistTheme, restoreTheme, THEME_STORAGE_KEY, type ThemeFace, type ThemeSnapshot } from './theme.js'
import {
  COMPOSER_CHANNEL, COMPOSER_PROTOCOL_VERSION, ComposerBridge, composerReady,
  type ComposerReply, type ComposerTarget,
} from './composer-bridge.js'
import {
  CONNECTOR_SETTINGS_NAMESPACE, ConnectorSettingsCard, connectorDraftProblem,
  type ConnectorDraft, type ConnectorSettings,
} from './settings-card.js'

export const inject = ['theme', 'slots', 'connection', 'remote', 'settingsScope', 'sessions']

export { persistTheme, restoreTheme, THEME_STORAGE_KEY }
export { CONNECTOR_SETTINGS_NAMESPACE, connectorDraftProblem }
export { COMPOSER_CHANNEL, COMPOSER_PROTOCOL_VERSION }
export type { ConnectorDraft }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'theme/change'(snapshot: ThemeSnapshot): void
  }
}

/**
 * Structural face of DSH's native conversation service. Resolved lazily
 * through `ctx.get`, so a runtime composed without the conversation UI keeps
 * the rest of this plugin alive instead of failing to activate.
 */
interface ConversationFace {
  readonly input: {
    for(actx: object): {
      readonly state: { getSnapshot(): { readonly draft: string; readonly phase: string } }
      setDraft(text: string): void
    }
  }
}

/** Resolve the current session's composer, or undefined while none is live. */
function composerTarget(client: ClientContext): ComposerTarget | undefined {
  const sessionId = client.sessions.list.getSnapshot().current
  if (sessionId === undefined) return undefined
  const conversation = client.get('conversation') as ConversationFace | undefined
  if (conversation === undefined) return undefined
  const actx = client.sessions.scope(sessionId)
  if (actx === undefined) return undefined
  try {
    const input = conversation.input.for(actx)
    return {
      read: () => {
        const state = input.state.getSnapshot()
        return {
          draft: state.draft,
          busy: state.phase === 'adjudicating' || state.phase === 'submitting',
        }
      },
      write: (draft) => { input.setDraft(draft) },
    }
  } catch {
    // The session left the list between the two reads; treat it as no composer.
    return undefined
  }
}

function post(target: Window | null, message: ComposerReply): void {
  if (target === null) return
  try {
    target.postMessage(message, window.location.origin)
  } catch {
    // The business page may have navigated away; a lost reply is not an error.
  }
}

/**
 * Accept one prepared sentence from the embedding business system and put it
 * in the composer. Same-origin only, and only from the window that embedded
 * this one: the deployment fronts both surfaces on the Gateway origin, so a
 * cross-origin sender is always someone else.
 * @param ctx - the browser plugin context.
 */
export function installComposerBridge(ctx: Context): void {
  if (typeof window === 'undefined') return
  const client = ctx as ClientContext
  const bridge = new ComposerBridge(() => composerTarget(client))

  const listener = (event: MessageEvent<unknown>): void => {
    const source = event.source as Window | null
    if (event.origin !== window.location.origin) return
    if (source === null || source === window) return
    if (source !== window.parent && source !== window.opener) return
    bridge.receive(event.data, (reply) => { post(source, reply) })
  }

  ctx.effect(() => {
    window.addEventListener('message', listener)
    return () => { window.removeEventListener('message', listener) }
  }, 'dshserver-preferences: composer handoff')

  // A sentence can arrive before a session or the conversation UI exists. Both
  // arrivals are a chance to deliver what the bridge is still holding.
  ctx.effect(() => client.sessions.list.subscribe(() => { bridge.flush() }),
    'dshserver-preferences: composer handoff flush')
  ctx.inject(['conversation'], () => { bridge.flush() })

  // Announce the bridge so the business system can stop guessing whether the
  // embedded assistant supports the handoff.
  if (window.parent !== window) post(window.parent, composerReady())
  post(window.opener as Window | null, composerReady())
}

export function apply(ctx: Context): void {
  const theme = ctx.get('theme') as ThemeFace | undefined
  if (theme === undefined) throw new Error('dshserver-preferences: theme service missing')
  restoreTheme(theme)
  persistTheme(theme.getTheme())
  ctx.on('theme/change', (snapshot) => { persistTheme(snapshot) })

  installComposerBridge(ctx)

  const client = ctx as ClientContext
  const scope = client.settingsScope.bind<ConnectorSettings>({ namespace: CONNECTOR_SETTINGS_NAMESPACE })
  client.slots.inject('settings.plugin.item', () => client.slots.register({
    name: 'settings.plugin.item',
    id: CONNECTOR_SETTINGS_NAMESPACE,
    order: 30,
  }, () => h(ConnectorSettingsCard, { scope })))
}
