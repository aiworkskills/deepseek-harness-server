/**
 * Browser half: put the deployment's own brand in DSH's generic brand slots.
 *
 * These slots are a designed extension point, not something this plugin is
 * prying open: DSH's own brand is itself a replaceable plugin
 * (`ui-brand-official`), and on any build that is not the official one it
 * registers nothing at all — so on a self-built Runtime the slots stand empty
 * behind a fallback mark, waiting for whoever wants them.
 *
 * **A slot with nothing to put in it is a slot this plugin does not take.**
 * That rule is the whole shape of this file, and it is not fastidiousness: DSH
 * renders `sidebar.brand.mark` inside the collapse toggle as its resting state,
 * with the panel icon appearing only on hover, so an occupant that renders
 * nothing leaves a control invisible until hovered — and, because a slot's
 * fallback applies only while nothing is registered, taking the seat also
 * suppresses the mark that would otherwise have been drawn.
 */
import { createElement as h, type ReactNode } from 'react'
// Type-only: this bundle is linked into a profile with no `node_modules` beside
// it and may import nothing at runtime but React.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

import { BRAND_ROUTE, EMPTY_WORKSPACE_ACTIONS_CSS, hasHeadline, hasMark, hasName, type BrandConfig } from './contract.js'
import { HERO_MARKER, installHeroStyle } from './client/hero.js'

export {
  BRAND_ROUTE, EMPTY_WORKSPACE_ACTIONS_CSS, hasHeadline, hasMark, hasName, type BrandConfig,
} from './contract.js'
export { HERO_MARKER, installHeroStyle } from './client/hero.js'

export const inject = ['slots']

/**
 * Props DSH passes the mark slot. Always supplied — the rail and the expanded
 * row ask for different edges, so there is no sensible default to fall back on.
 */
interface MarkProps {
  readonly size: number
}

/**
 * Install the workaround stylesheet, returning its disposer.
 * @param css - rule text to install.
 * @returns a disposer that removes the element again.
 */
function installStyle(css: string): () => void {
  const style = document.createElement('style')
  style.dataset.dshserverBrand = 'workspace-actions'
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}

/**
 * Ask the Host half what this deployment's brand is.
 *
 * Not a config parameter: cordis passes profile config to the Host `apply`
 * only, so a client plugin that declares one is handed `{}` on every load and
 * takes no seat — indistinguishable from a deployment that supplied nothing.
 * @param signal - abort signal tied to this plugin's lifetime.
 * @returns the deployment's brand, or null when the Host half is not composed.
 */
async function fetchBrandConfig(signal: AbortSignal): Promise<BrandConfig | null> {
  try {
    const response = await fetch(BRAND_ROUTE, {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', signal,
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as BrandConfig
  } catch {
    // The Host half may not be composed at all — a deployment saying "no brand
    // of my own", not an error worth surfacing to a user.
    return null
  }
}

export function apply(ctx: ClientContext): void {
  const abort = new AbortController()
  const mounted: (() => void)[] = []

  /**
   * Take the seats this deployment gave something to fill.
   *
   * Runs once the config has arrived, so every seat is claimed knowing what
   * goes in it. Until then this plugin holds nothing and DSH's own fallback
   * draws — which is the correct thing to show while the answer is in flight,
   * and the reason claiming up front would be wrong.
   */
  function claim(config: BrandConfig): void {
    const alt = config.markAlt ?? config.name ?? ''

    function BrandMark({ size }: MarkProps): ReactNode {
      if (config.markSvg !== undefined && config.markSvg !== '') {
        // The markup is the operator's own, from the profile — never a user's.
        return h('span', {
          style: { display: 'inline-flex', width: size, height: size },
          role: alt === '' ? 'presentation' : 'img',
          ...(alt === '' ? { 'aria-hidden': true } : { 'aria-label': alt }),
          dangerouslySetInnerHTML: { __html: config.markSvg },
        })
      }
      return h('img', {
        src: config.markUrl,
        alt,
        width: size,
        height: size,
        style: { objectFit: 'contain' },
      })
    }

    function BrandName(): ReactNode {
      return h('span', { style: { whiteSpace: 'nowrap' } }, config.name)
    }

    // The marker is what `installHeroStyle`'s rules are scoped by; without it they
    // match nothing and DSH's own headline renders beside ours.
    function Headline(): ReactNode {
      return h('span', { [HERO_MARKER]: '', style: { whiteSpace: 'nowrap' } }, config.headline)
    }

    // Each seat is taken only when this deployment gave something to put in it.
    if (hasMark(config)) {
      mounted.push(ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark)))
    }
    if (hasName(config)) {
      mounted.push(ctx.slots.inject('sidebar.brand.name', () =>
        ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName)))
    }
    if (hasHeadline(config)) {
      // The stylesheet and the occupant are one unit: the rules hide DSH's own
      // headline and only fire on our marker, so installing either alone is a
      // hero with two headlines or none.
      mounted.push(installHeroStyle())
      mounted.push(ctx.slots.inject('conversation.hero.brand.mark', () =>
        ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Headline)))
    }

    if (config.hideEmptyWorkspaceActions === true && typeof document !== 'undefined') {
      mounted.push(installStyle(EMPTY_WORKSPACE_ACTIONS_CSS))
    }
  }

  void fetchBrandConfig(abort.signal).then(config => {
    if (abort.signal.aborted || config === null) return
    claim(config)
  })

  ctx.effect(() => () => {
    abort.abort()
    // Reverse order: the hero stylesheet is only meaningful while its occupant
    // is mounted, and releasing it first would flash DSH's headline back in.
    for (const release of mounted.reverse()) release()
    mounted.length = 0
  }, 'dshserver-brand: release brand seats')
}
