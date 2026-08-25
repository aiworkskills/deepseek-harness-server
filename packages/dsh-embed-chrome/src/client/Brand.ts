/**
 * The sidebar brand line: which workspace this is, and a way to leave it.
 *
 * The constraint that shapes this whole file: the sidebar's brand area is not a
 * container, it is the New Session button, and its contents carry
 * `aria-hidden="true"`. Upstream markup, roughly:
 *
 *     <button onClick={startSession} class="brand">        // overflow: hidden
 *       <span class="brandIdentity" aria-hidden="true">
 *         <span class="brandName">{renderSlot('sidebar.brand.name')}</span>
 *
 * So a control placed here lives inside a button that wants every click, inside
 * a clipping box, inside a subtree screen readers cannot see. Three consequences,
 * each answered deliberately below:
 *
 *   1. **The menu is portalled to `document.body`.** The first version rendered
 *      it in place as `position: fixed` and it never appeared. Rather than keep
 *      guessing which ancestor was responsible — a clipping `overflow`, a
 *      containing block, stacking order, button content model — the menu simply
 *      stops being a descendant. `react-dom` is a preloaded client external, so
 *      this costs nothing.
 *
 *   2. **Activation is on `pointerdown`, with the default prevented.**
 *      `pointerdown` precedes `click`, so the button's activation behaviour is
 *      cancelled before it can begin rather than raced afterwards.
 *
 *   3. **A screen reader cannot reach this.** `aria-hidden` applies to the whole
 *      subtree and a descendant cannot opt back in. Deployments that need an
 *      accessible switcher should put one in `sidebar.footer.action`, which is
 *      an ordinary region. This occupant exists because the identity of the
 *      current workspace belongs visually at the top.
 *
 * Written with `createElement` rather than JSX to match the other browser
 * halves in this repository: one fewer build mode, same bundle either way.
 */
import {
  createElement as h, useEffect, useLayoutEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import type { ChromeState, ChromeWorkspace } from '../contract.js'

export interface BrandProps {
  readonly state: ChromeState
  readonly onSwitch: (workspaceId: string) => void
}

const MENU_WIDTH = 240

const TRIGGER_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  maxWidth: '100%',
  font: 'inherit',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const MENU_STYLE = {
  position: 'fixed',
  // Above everything: this is a transient layer over an app that owns its own
  // stacking, and it is portalled out of that app's tree.
  zIndex: 2147483000,
  width: `${String(MENU_WIDTH)}px`,
  maxHeight: '60vh',
  overflowY: 'auto',
  padding: '4px',
  borderRadius: '10px',
  border: '1px solid rgba(127,127,127,0.24)',
  // System colours rather than DSH design tokens: this element is portalled to
  // document.body, outside whatever element scopes the theme's custom properties.
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
} as const

function itemStyle(active: boolean) {
  return {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    border: 'none',
    borderRadius: '7px',
    background: active ? 'rgba(127,127,127,0.16)' : 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: '14px',
    fontWeight: active ? 600 : 400,
    textAlign: 'left',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const
}

/** Place a portalled menu under `anchor`, kept inside the viewport. */
function useAnchoredBox(anchor: HTMLElement | null, open: boolean): { left: number; top: number } {
  const [box, setBox] = useState({ left: -9999, top: -9999 })
  // Layout effect, not effect: the menu must never paint at its placeholder
  // position first.
  useLayoutEffect(() => {
    if (!open || anchor === null) return
    const place = (): void => {
      const rect = anchor.getBoundingClientRect()
      setBox({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
        top: rect.bottom + 6,
      })
    }
    place()
    // The sidebar scrolls and the window resizes underneath an open menu, and
    // neither re-renders this component.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, open])
  return box
}

export function Brand({ state, onSwitch }: BrandProps): ReactNode {
  const [open, setOpen] = useState(false)
  // State, not a ref: the anchored-box effect has to re-run once the element
  // exists, and a ref mutation does not re-render.
  const [trigger, setTrigger] = useState<HTMLElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const box = useAnchoredBox(trigger, open)
  const workspaces: readonly ChromeWorkspace[] = state.workspaces ?? []
  const switchable = workspaces.length > 1
  const label = state.brand
    ?? workspaces.find(workspace => workspace.id === state.currentWorkspaceId)?.name
    ?? ''

  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (trigger?.contains(target) === true) return
      if (menu.current?.contains(target) === true) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, trigger])

  if (label === '' && !switchable) return null

  /**
   * Cancel the host button before it acts.
   *
   * `preventDefault` on `pointerdown` stops the button's activation behaviour
   * at its source; `stopPropagation` keeps the synthetic event from reaching
   * the button's own React handler. Both, because they guard different paths.
   */
  const claim = (event: { preventDefault: () => void; stopPropagation: () => void }): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  const trigger_ = h('span', {
    ref: setTrigger,
    style: switchable ? { ...TRIGGER_STYLE, cursor: 'pointer' } : { ...TRIGGER_STYLE, cursor: 'inherit' },
    ...(switchable
      ? {
        role: 'button',
        tabIndex: 0,
        onPointerDown: (event: ReactPointerEvent) => { claim(event); setOpen(value => !value) },
        // The click that follows our pointerdown must not reach the button either.
        onClick: claim,
        onKeyDown: (event: ReactKeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          claim(event)
          setOpen(value => !value)
        },
      }
      : {}),
  },
  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
  switchable ? h('span', { style: { opacity: 0.55, fontSize: '11px', flexShrink: 0 } }, '▾') : null)

  return h('span', { style: { display: 'inline-flex', minWidth: 0, maxWidth: '100%' } },
    trigger_,
    open && typeof document !== 'undefined'
      // Portalled to the body: as a descendant this menu sat inside a button
      // with `overflow: hidden`, and never appeared.
      ? createPortal(
        h('div', {
          ref: menu,
          style: { ...MENU_STYLE, left: `${String(box.left)}px`, top: `${String(box.top)}px` },
        }, workspaces.map(workspace => h('button', {
          key: workspace.id,
          type: 'button',
          style: itemStyle(workspace.id === state.currentWorkspaceId),
          title: workspace.name,
          onClick: () => {
            setOpen(false)
            if (workspace.id !== state.currentWorkspaceId) onSwitch(workspace.id)
          },
        }, workspace.name))),
        document.body,
      )
      : null)
}
