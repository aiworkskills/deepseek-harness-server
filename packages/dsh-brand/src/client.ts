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

import { EMPTY_WORKSPACE_ACTIONS_CSS, hasHeadline, hasMark, hasName, type BrandConfig } from './contract.js'
import { HERO_MARKER, installHeroStyle } from './client/hero.js'

export {
  EMPTY_WORKSPACE_ACTIONS_CSS, hasHeadline, hasMark, hasName, type BrandConfig,
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

export function apply(ctx: ClientContext, config: BrandConfig = {}): void {
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
    ctx.effect(() => ctx.slots.inject('sidebar.brand.mark', () =>
      ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark)),
    'dshserver-brand: sidebar mark')
  }
  if (hasName(config)) {
    ctx.effect(() => ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName)),
    'dshserver-brand: sidebar wordmark')
  }
  if (hasHeadline(config)) {
    // The stylesheet and the occupant are one unit: the rules hide DSH's own
    // headline and only fire on our marker, so installing either alone is a
    // hero with two headlines or none.
    ctx.effect(installHeroStyle, 'dshserver-brand: hero layout')
    ctx.effect(() => ctx.slots.inject('conversation.hero.brand.mark', () =>
      ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Headline)),
    'dshserver-brand: blank-session headline')
  }

  if (config.hideEmptyWorkspaceActions === true && typeof document !== 'undefined') {
    ctx.effect(() => installStyle(EMPTY_WORKSPACE_ACTIONS_CSS), 'dshserver-brand: empty workspace actions')
  }
}
