/**
 * Browser half: let the page that frames this Runtime own the chrome.
 *
 * Standalone, DSH's sidebar brand and blank-session headline are the product
 * announcing itself. Inside someone else's page they are a second identity
 * competing with the first — the user is in *your* product, and the frame says
 * otherwise. The embedding page is the only thing that knows the right answer,
 * so it supplies one.
 *
 * Nothing is registered until the page actually answers. A deployment that
 * composes this plugin and never implements the page side gets DSH's own chrome
 * unchanged, rather than a set of empty holes where the brand used to be.
 */
import { createElement as h, useSyncExternalStore } from 'react'
// `slots` comes from ui-renderer; the two slot names this plugin fills are
// declared by ui-sidebar and ui-conversation, so those two type-only imports are
// what put the matching `SlotMap` keys on the map.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

import { EMBED_CHROME_ROUTE, type EmbedHostInfo } from './contract.js'
import { Brand } from './client/Brand.js'
import { HERO_MARKER, installHeroStyle } from './client/hero.js'
import { openEmbedLink, type EmbedLink } from './client/link.js'
import { createChromeStore } from './client/store.js'

export {
  CHROME_MESSAGE_SOURCE, CHROME_PROTOCOL, EMBED_CHROME_ROUTE, chromeRequest, originOf,
  parseChromeState,
  type ChromeRequest, type ChromeState, type ChromeWorkspace, type EmbedHostInfo,
} from './contract.js'
export { Brand, type BrandProps } from './client/Brand.js'
export { openEmbedLink, type EmbedLink, type LinkOptions } from './client/link.js'
export { createChromeStore, type ChromeStore } from './client/store.js'
export { HERO_MARKER, installHeroStyle } from './client/hero.js'

export const inject = ['slots']

async function fetchHostInfo(signal: AbortSignal): Promise<EmbedHostInfo | null> {
  try {
    const response = await fetch(EMBED_CHROME_ROUTE, {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', signal,
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null) return null
    const { hostOrigin } = value as Partial<EmbedHostInfo>
    return typeof hostOrigin === 'string' ? { hostOrigin } : null
  } catch {
    // The Host half may not be composed at all. That is a deployment saying
    // "not embedded", not an error worth surfacing to a user.
    return null
  }
}

export function apply(ctx: ClientContext): void {
  const store = createChromeStore()
  const abort = new AbortController()
  let link: EmbedLink | undefined
  let brandMounted: (() => void) | undefined
  let heroMounted: (() => void) | undefined
  let heroStyle: (() => void) | undefined

  function BrandSlot() {
    const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
    if (state === null) return null
    return h(Brand, {
      state,
      onSwitch: (workspaceId: string) => { link?.send({ type: 'switch', workspaceId }) },
    })
  }

  function HeroSlot() {
    const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
    if (state?.headline === undefined) return null
    return h('span', {
      [HERO_MARKER]: '',
      style: { whiteSpace: 'nowrap' },
    }, state.headline)
  }

  /**
   * Take the brand name seat now, before the page has answered.
   *
   * Registering only on the first answer meant the `DSH Local Build <sha>`
   * fallback rendered for the whole round trip — another product's identity,
   * flashing in this one's frame on every load. Being framed at all is a
   * synchronous fact, so the seat is claimed synchronously and renders nothing
   * until there is something to say.
   *
   * The trade is deliberate: a deployment that composes this plugin, frames the
   * Runtime, and then never implements the page side gets a blank brand line
   * instead of DSH's. `release()` below restores the fallback for the one case
   * we can actually detect — no configured origin.
   *
   * **The mark seat is deliberately left to DSH.** Occupying it and rendering
   * nothing looked right in the expanded sidebar and was wrong in the rail: DSH
   * renders that slot inside the collapse toggle as its resting state, with the
   * panel icon appearing only on hover. An empty occupant therefore left a
   * control with no resting visual — and, because a slot's `fallback` applies
   * only when *nothing* is registered, it also suppressed DSH's own mark.
   *
   * There is nothing to put there instead: this plugin's protocol carries a
   * brand *line*, a headline and workspaces, but no image — the embedding page
   * cannot supply a mark even if it wants to. So the honest posture is to leave
   * the seat empty-handed rather than take it empty-handed. Giving the host
   * page real control here means adding a mark to `ChromeState`, not holding a
   * seat we can never fill.
   */
  const claimBrand = (): void => {
    brandMounted ??= ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.register({ name: 'sidebar.brand.name' }, BrandSlot))
  }

  const release = (): void => {
    heroStyle?.()
    heroStyle = undefined
    heroMounted?.()
    heroMounted = undefined
    brandMounted?.()
    brandMounted = undefined
  }

  const receive = (state: Parameters<typeof store.set>[0]): void => {
    store.set(state)
    claimBrand()
    // The hero rule hides DSH's own headline, so it may only exist once we have
    // one to put there — otherwise the hero would render empty.
    if (state.headline !== undefined && heroMounted === undefined) {
      heroStyle = installHeroStyle()
      heroMounted = ctx.slots.inject('conversation.hero.brand.mark', () =>
        ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HeroSlot))
    }
  }

  const framed = typeof window !== 'undefined' && window.parent !== window
  if (framed) claimBrand()

  void fetchHostInfo(abort.signal).then(info => {
    if (abort.signal.aborted) return
    link = info === null ? undefined : openEmbedLink({ hostOrigin: info.hostOrigin, onState: receive }) ?? undefined
    // Not embedded after all — hand the seats back rather than sit on them empty.
    if (link === undefined) release()
  })

  ctx.effect(() => () => {
    abort.abort()
    link?.close()
    heroStyle?.()
    heroMounted?.()
    brandMounted?.()
  }, 'dshserver-embed-chrome: host-supplied chrome')
}
