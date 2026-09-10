/**
 * Replace the blank-session headline with the deployment's own line.
 *
 * Not a clean seam, and this file says so plainly. DSH exposes the hero's *mark*
 * as a slot but keeps the headline and the preview badge as locale strings
 * inside the component, and its locale registry refuses a second owner for a
 * namespace — registering over `hero.headline` throws rather than overrides. So
 * the supported half carries our text (the mark slot) and the rest is CSS.
 *
 * **Putting text in the mark slot is not enough on its own.** Without these
 * rules DSH's own headline renders right beside ours — two headlines, one of
 * them the wrong product's. That is the whole reason this file exists.
 *
 * Two facts from the host that the rules are built on, both load-bearing:
 *
 *   1. Every slot render site is wrapped in `<div data-slot="<key>"
 *      style="display:contents">`. That wrapper is documented upstream as "the
 *      addressable seam dynamic styles target" — it is the intended handle, so
 *      the rule keys off it and never off a hashed CSS-module class name.
 *      (A version matching `:has(> [marker])` silently never fired, because the
 *      wrapper makes our element a *grandchild*.)
 *
 *   2. The headline is a three-column grid whose first track is a hard-coded
 *      `34px` — sized for the fish logo. Text dropped into that track overflows
 *      on top of the second column instead of pushing it aside, so hiding the
 *      siblings is not enough: the track itself has to be re-sized.
 *
 * Everything is scoped by {@link HERO_MARKER}, which only exists once this
 * plugin actually rendered a headline. Without that scope the rules would hide
 * DSH's headline for deployments that compose the plugin but supply no
 * `headline` — a blank hero, far worse than the original one.
 *
 * If upstream reshapes the hero, the selectors stop matching and the stock
 * headline returns: visible and harmless, never blank.
 *
 * Near-duplicate of `dsh-embed-chrome/src/client/hero.ts`. Kept separate rather
 * than shared because the marker attribute — the thing every rule is scoped by —
 * has to name the plugin that rendered it, so the two can never hide each
 * other's hero. Fix a selector here and check that file too.
 */

/** Marks our occupant. Also the scope for every rule below. */
export const HERO_MARKER = 'data-dshserver-brand-hero'

const STYLE_ID = 'dshserver-brand-hero'

/** The slot whose occupant we are; the wrapper upstream puts around it. */
const MARK_SLOT = '[data-slot="conversation.hero.brand.mark"]'

/** The mark's own cell — the element holding the slot wrapper. */
const CELL = `:has(> ${MARK_SLOT} [${HERO_MARKER}])`

/** The grid that lays the headline row out — the cell's parent. */
const ROW = `:has(> * > ${MARK_SLOT} [${HERO_MARKER}])`

/**
 * The rules themselves.
 *
 * Exported because they *are* the contract with DSH's hero markup — the
 * selectors are the fragile part, and a test that cannot read them can only
 * assert that a `<style>` element exists.
 */
export const HERO_CSS = `
/* The row is grid-template-columns: 34px auto auto — a track sized for a logo.
   Our text is a headline, so the row becomes a single content-sized track. */
*${ROW} { grid-template-columns: auto !important; }

/* Everything after the mark is the stock headline and its preview badge. */
*${CELL} ~ * { display: none !important; }

/* The cell is sized and centred for a 34px mark; let the text set its own box. */
*${CELL} {
  grid-column: 1 / -1 !important;
  width: auto !important;
  height: auto !important;
  min-width: 0 !important;
}
`

/**
 * Install the rule once; returns a disposer.
 *
 * Injected into `document.head` rather than shipped as a CSS module: this
 * package builds its browser half with plain esbuild and has no style pipeline,
 * and a rule that must reach outside its own component's subtree does not
 * belong to that component anyway.
 * @returns a disposer that removes the stylesheet again.
 */
export function installHeroStyle(): () => void {
  if (typeof document === 'undefined') return () => undefined
  if (document.getElementById(STYLE_ID) !== null) return () => undefined
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = HERO_CSS
  document.head.append(style)
  return () => { style.remove() }
}
