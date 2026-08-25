/**
 * Replace the blank-session headline with the embedding page's own line.
 *
 * This one is not a clean seam and the file says so plainly. DSH exposes the
 * hero's *mark* as a slot but keeps the headline and the preview badge as
 * locale strings inside the component, and its locale registry refuses a second
 * owner for a namespace — registering over `hero.headline` throws rather than
 * overrides. So the supported half is used for what it covers (the mark slot
 * carries our text) and the two leftover spans are hidden with a structural
 * rule.
 *
 * The rule keys off a marker attribute this package sets, never off DSH's
 * hashed CSS-module class names, so an upstream restyle does not silently break
 * it. If upstream reshapes the hero, the selector stops matching and the
 * original headline comes back — visible and harmless, not a blank hero.
 */

/** Marks our occupant so the rule below can find its siblings. */
export const HERO_MARKER = 'data-dsh-embed-chrome-hero'

const STYLE_ID = 'dsh-embed-chrome-hero'

const HERO_CSS = `
/* The hero headline row is [mark-hitbox][headline][preview badge]. Our text
   replaces the mark, so everything after it in that row goes away. */
span:has(> [${HERO_MARKER}]) ~ span { display: none !important; }
/* The hitbox is sized for a 34px logo; our text needs to size itself. */
span:has(> [${HERO_MARKER}]) { width: auto !important; height: auto !important; }
`

/**
 * Install the rule once; returns a disposer.
 *
 * Injected into `document.head` rather than shipped as a CSS module because
 * this package builds its browser half with plain esbuild and has no style
 * pipeline — and because a rule that must outlive its own component's subtree
 * does not belong to that component.
 */
export function installHeroStyle(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => undefined
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = HERO_CSS
  document.head.append(style)
  return () => { style.remove() }
}
