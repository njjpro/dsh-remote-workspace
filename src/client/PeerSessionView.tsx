/**
 * The peer session view: peer GUI iframes mounted over the official center
 * column. Every opened peer session keeps its own iframe (mounted, not
 * destroyed, when another session is visible), so switching between peer
 * sessions — or back to a local one — preserves the loaded conversation.
 * There is no explicit close control: opening a local session collapses
 * the view naturally, which is the whole interaction the shell needs.
 * The view paints nothing while collapsed; the local shell shows through.
 */
import { useEffect, useRef, useState } from 'react'
import { peerSessionStore } from './peer-session-store.ts'
import css from './peer-federation.module.css'

/**
 * Render the open peer session frames.
 * @returns the view element tree (nothing when no entry is open).
 */
export function PeerSessionView() {
  const [state, setState] = useState(() => peerSessionStore.getState())
  const framesRef = useRef<Map<string, HTMLIFrameElement>>(new Map())

  useEffect(() => peerSessionStore.subscribe(() => {
    setState(peerSessionStore.getState())
  }), [])

  // The desktop app runs in GPU compatibility (software rendering) mode,
  // where iframe composition can miss its initial paint and leave a blank
  // white surface even though the frame's document is fully alive. Nudge
  // the focused frame with a sub-pixel transform flip once it loads and
  // whenever it becomes focused: this forces the compositor to re-record
  // the layer and repaint the real content.
  const activeId = state.activeSessionId
  useEffect(() => {
    if (activeId === undefined) return
    const frame = framesRef.current.get(activeId)
    if (frame === undefined) return
    let cancelled = false
    // Occlusion probe (diagnostic): report the frame's layout rect and which
    // element actually sits at the frame's center point, so a white pane can
    // be attributed to real occlusion versus a composition failure.
    const probeOcclusion = (): void => {
      if (cancelled) return
      try {
        const rect = frame.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const el = document.elementFromPoint(cx, cy)
        const chain: string[] = []
        let cur: Element | null = el
        while (cur !== null && chain.length < 4) {
          const cls = typeof cur.className === 'string' ? cur.className.slice(-30) : ''
          chain.push(`${cur.tagName}${cls === '' ? '' : '.' + cls}z${getComputedStyle(cur).zIndex}`)
          cur = cur.parentElement
        }
        const summary = `rect${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.top)}_${encodeURIComponent(chain.join('>')).slice(0, 70)}`
        new Image().src = `http://127.0.0.1:43121/assets/__probe_occl-${summary}_${Date.now()}.gif`
      } catch {
        // diagnostics are best-effort
      }
    }
    const timers = [2500, 7000].map(delay => window.setTimeout(probeOcclusion, delay))
    const nudge = (): void => {
      if (cancelled) return
      frame.style.transform = 'translateZ(0)'
      requestAnimationFrame(() => {
        if (cancelled) return
        frame.style.transform = ''
      })
    }
    if (frame.dataset.loaded === 'true') nudge()
    else frame.addEventListener('load', nudge, { once: true })
    // Parent half of the embedded composer's focus handoff, and the fix for
    // "switching back to an already-opened session leaves the pane unable to
    // take typing": frames are kept mounted across switches (opacity flips, no
    // unmount), so a re-opened session inserts no new iframe and is never
    // granted browser focus a second time. Only the parent can grant it — it
    // owns the element, and a frame cannot claim top-level focus for itself.
    // The frame's own client then moves DOM focus onto its composer, which the
    // parent cannot do across origins.
    const grantFrameFocus = (): void => {
      if (cancelled) return
      // Never take focus from a user who is typing in the local shell itself:
      // this runs on every activation change, and pulling focus out of the
      // local composer mid-sentence would be worse than the pane bug. The
      // editable test reads the attribute as well as isContentEditable, which
      // jsdom does not implement.
      const focused = document.activeElement
      if (focused !== null && focused !== frame) {
        const editable = (focused as HTMLElement).isContentEditable === true
          || focused.getAttribute('contenteditable') === 'true'
        const textual = focused instanceof HTMLInputElement
          || focused instanceof HTMLTextAreaElement
          || focused instanceof HTMLSelectElement
        if (editable || textual) return
      }
      try {
        frame.focus()
      } catch {
        // A detached or navigated-away frame has nothing to grant.
      }
    }
    // This effect already re-runs whenever the active session changes, so the
    // grant covers first open and every switch back alike. It is unconditional:
    // gating it on document.hasFocus() looked safer but silently skipped the
    // grant whenever the check could not answer (and jsdom always answers
    // false), which is exactly the state the fix exists to repair.
    grantFrameFocus()
    // On a first open the element is brand new, so the grant above can land
    // while it still has no document to receive focus; the load listener gives
    // that case a second attempt. (A switch back needs no listener: that frame
    // is already loaded, and the immediate grant is the one that matters.)
    if (frame.dataset.loaded !== 'true') frame.addEventListener('load', grantFrameFocus, { once: true })
    return () => {
      cancelled = true
      frame.removeEventListener('load', nudge)
      frame.removeEventListener('load', grantFrameFocus)
      timers.forEach(t => window.clearTimeout(t))
    }
  }, [activeId, state.entries.length])

  if (state.entries.length === 0) return null

  // Never leave every frame at opacity 0. Visibility is driven purely by
  // `data-active`, so an activeSessionId that matches no mounted entry blanks
  // the whole pane (the container's own background stays opaque) while the
  // DOM and hit-testing still look healthy. Fall back to the newest entry.
  const focusId = activeId !== undefined && state.entries.some(entry => entry.sessionId === activeId)
    ? activeId
    : state.entries[state.entries.length - 1]?.sessionId

  return (
    <div
      className={css.view}
      data-dsh-plugin="remote-workspace"
      data-dsh-part="peer-session-view"
      data-collapsed={activeId === undefined ? 'true' : 'false'}
    >
      {state.entries.map(entry => {
        const active = focusId === entry.sessionId
        return (
          <iframe
            key={entry.sessionId}
            // Stacked with opacity switching, never the hidden attribute: a
            // hidden-then-shown iframe repaints as a blank white surface.
            // Opacity keeps every frame in the render pipeline all along.
            ref={node => {
              if (node === null) framesRef.current.delete(entry.sessionId)
              else framesRef.current.set(entry.sessionId, node)
            }}
            className={css.frame}
            src={entry.url}
            title={entry.sessionId}
            data-active={active ? 'true' : 'false'}
            data-dsh-part="peer-session-frame"
            onLoad={event => {
              (event.target as HTMLIFrameElement).dataset.loaded = 'true'
            }}
          />
        )
      })}
    </div>
  )
}
