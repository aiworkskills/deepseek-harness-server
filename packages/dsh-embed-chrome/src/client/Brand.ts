/**
 * The sidebar brand line: which workspace this is, and a way to leave it.
 *
 * A constraint worth knowing before reading this file: the sidebar's brand area
 * is not a container, it is the New Session button, and its contents carry
 * `aria-hidden="true"`. So a control placed here has to stop its own clicks from
 * reaching that button, and cannot be reached by a screen reader at all —
 * `aria-hidden` applies to the whole subtree and a descendant cannot opt back
 * in. Deployments that need the switcher to be accessible should put it in
 * `sidebar.footer.action`, which is an ordinary region; this occupant exists
 * because the identity of the current workspace belongs visually at the top.
 *
 * Written with `createElement` rather than JSX to match the other browser
 * halves in this repository: one fewer build mode, same bundle either way.
 */
import {
  createElement as h, useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'

import type { ChromeState, ChromeWorkspace } from '../contract.js'

export interface BrandProps {
  readonly state: ChromeState
  readonly onSwitch: (workspaceId: string) => void
}

const TRIGGER_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  maxWidth: '100%',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const MENU_STYLE = {
  position: 'fixed',
  zIndex: 2147483000,
  minWidth: '180px',
  maxWidth: '280px',
  maxHeight: '60vh',
  overflowY: 'auto',
  padding: '4px',
  borderRadius: '10px',
  border: '1px solid rgba(127,127,127,0.24)',
  background: 'var(--dsh-embed-chrome-surface, Canvas)',
  color: 'CanvasText',
  boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
} as const

function itemStyle(active: boolean) {
  return {
    display: 'block',
    width: '100%',
    padding: '7px 10px',
    border: 'none',
    borderRadius: '7px',
    background: active ? 'rgba(127,127,127,0.16)' : 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontWeight: active ? 600 : 400,
    textAlign: 'left',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const
}

/** Anchor a fixed-position menu under `anchor`, kept inside the viewport. */
function useAnchor(anchor: HTMLElement | null, open: boolean): { left: number; top: number } {
  const [box, setBox] = useState({ left: 0, top: 0 })
  useEffect(() => {
    if (!open || anchor === null) return
    const place = (): void => {
      const rect = anchor.getBoundingClientRect()
      setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: rect.bottom + 6 })
    }
    place()
    // The sidebar scrolls and the window resizes underneath an open menu; both
    // move the anchor without re-rendering this component.
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
  const trigger = useRef<HTMLSpanElement | null>(null)
  const box = useAnchor(trigger.current, open)
  const workspaces: readonly ChromeWorkspace[] = state.workspaces ?? []
  const switchable = workspaces.length > 1
  const label = state.brand
    ?? workspaces.find(workspace => workspace.id === state.currentWorkspaceId)?.name
    ?? ''

  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event): void => {
      if (event.target instanceof Node && trigger.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  if (label === '' && !switchable) return null

  // Every handler stops propagation: this subtree sits inside the New Session
  // button, and an un-stopped click would open a new session behind the menu.
  const swallow = (event: { stopPropagation: () => void; preventDefault: () => void }): void => {
    event.stopPropagation()
    event.preventDefault()
  }

  return h('span', { style: { display: 'inline-flex', maxWidth: '100%' } },
    h('span', {
      ref: trigger,
      style: switchable ? TRIGGER_STYLE : { ...TRIGGER_STYLE, cursor: 'default' },
      ...(switchable
        ? {
          role: 'button',
          tabIndex: 0,
          onClick: (event: ReactMouseEvent) => { swallow(event); setOpen(value => !value) },
          onKeyDown: (event: ReactKeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            swallow(event)
            setOpen(value => !value)
          },
        }
        : {}),
    },
    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
    switchable ? h('span', { style: { opacity: 0.55, fontSize: '10px', flexShrink: 0 } }, '▾') : null),
    open
      ? h('div', {
        style: { ...MENU_STYLE, left: `${String(box.left)}px`, top: `${String(box.top)}px` },
        onClick: swallow,
        onPointerDown: (event: ReactPointerEvent) => { event.stopPropagation() },
      }, workspaces.map(workspace => h('button', {
        key: workspace.id,
        type: 'button',
        style: itemStyle(workspace.id === state.currentWorkspaceId),
        title: workspace.name,
        onClick: (event: ReactMouseEvent) => {
          swallow(event)
          setOpen(false)
          if (workspace.id !== state.currentWorkspaceId) onSwitch(workspace.id)
        },
      }, workspace.name)))
      : null)
}
