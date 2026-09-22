/**
 * Embed-shell composer focus (peer GUI inside the device workspace).
 *
 * Two separate defects make the embedded pane refuse typing, and both must be
 * fixed for the pane to behave:
 *
 * 1. FIRST OPEN. The pane is a CROSS-ORIGIN iframe and opens with nothing
 *    focused inside it — focus is still in the parent shell, on the sidebar row
 *    the user just clicked. Keystrokes reach no element.
 * 2. SWITCHING BACK. `PeerSessionView` deliberately keeps every opened session's
 *    iframe mounted (switching flips opacity, it never unmounts). A session
 *    opened a SECOND time therefore inserts no new iframe, and browser focus —
 *    which a frame is granted when it is inserted — is never handed back to it.
 *    This is why only some sessions misbehave: the ones already opened once.
 *
 * Restoring typing needs BOTH halves, measured in a real cross-origin
 * composition rather than reasoned about, because each half alone fails in a
 * way that looks like it should work:
 *
 * - The parent must give the FRAME element browser focus on every activation
 *   (`frame.focus()`), which only the parent can do: it owns the element, and
 *   the frame cannot claim top-level focus for itself. Alone it is not enough:
 *   the frame then reports `document.hasFocus() === true` while its body keeps
 *   DOM focus, so characters are still dropped. That half lives in
 *   `PeerSessionView`, next to the frame elements.
 * - The frame must then put DOM focus on the composer, which only the frame can
 *   do: the same-origin rule forbids the parent from reaching into its
 *   document. Alone it is not enough either, because a frame without browser
 *   focus receives no keystrokes to route. That half is this module.
 *
 * This half is a small watchdog rather than a reaction to the frame's `focus`
 * event. Two reasons, both observed rather than assumed: a grant from the parent
 * does not reliably deliver a `focus` event to the frame (one was recorded while
 * the frame's own listener stayed silent), and gating on `document.hasFocus()`
 * before a first attempt never fires, because the focus call is part of what
 * makes the frame focused. Polling is therefore the dependable trigger, and the
 * watchdog is written so it is harmless while it waits: it only ever acts when
 * this frame holds browser focus, the composer exists, and the user is not
 * already working with something else inside the frame.
 */

/** The official composer's editable host (the only editable in the shell). */
export const EMBED_COMPOSER_SELECTOR = '[contenteditable="true"]'

/** Delay between watchdog checks, in ms. */
export const EMBED_FOCUS_POLL_MS = 250

/** Injectable environment for the focus watchdog (tests drive these). */
export interface EmbedFocusDeps {
  /** Document to search; defaults to the live one. */
  root?: ParentNode
  /** Whether this frame currently holds browser focus. */
  hasFocus?: () => boolean
  /** Current focused element; defaults to the live document's. */
  activeElement?: () => Element | null
  /** Delay between checks, in ms. */
  pollMs?: number
  /** Timer primitives; default to the window's. */
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (handle: number) => void
}

function defaultRoot(): ParentNode | undefined {
  return typeof document === 'undefined' ? undefined : document
}

function defaultHasFocus(): boolean {
  return typeof document === 'undefined' ? false : document.hasFocus()
}

function defaultActiveElement(): Element | null {
  return typeof document === 'undefined' ? null : document.activeElement
}

/**
 * Move focus onto the embedded shell's composer.
 * @param deps - injectable environment (root and active-element reader).
 * @returns true when the composer was found and now holds DOM focus.
 */
export function focusEmbedComposer(deps: EmbedFocusDeps = {}): boolean {
  const root = deps.root ?? defaultRoot()
  if (root === undefined) return false
  const target = root.querySelector(EMBED_COMPOSER_SELECTOR)
  if (target === null) return false
  const focus = (target as { focus?: unknown }).focus
  if (typeof focus !== 'function') return false
  try {
    ;(target as HTMLElement).focus()
  } catch {
    return false
  }
  const active = deps.activeElement ?? defaultActiveElement
  return active() === target
}

/**
 * Should the watchdog put focus on the composer right now?
 *
 * Kept separate from the effect so the decision is directly testable. The answer
 * is yes only when this frame holds browser focus, a composer exists, and no
 * other control inside the frame holds focus — the last condition is what keeps
 * the watchdog from fighting a user who is already using something in here.
 * @param deps - injectable environment.
 * @returns true when the composer should now be focused.
 */
export function shouldFocusEmbedComposer(deps: EmbedFocusDeps = {}): boolean {
  const hasFocus = deps.hasFocus ?? defaultHasFocus
  if (!hasFocus()) return false
  const root = deps.root ?? defaultRoot()
  if (root === undefined) return false
  const target = root.querySelector(EMBED_COMPOSER_SELECTOR)
  if (target === null) return false
  const active = (deps.activeElement ?? defaultActiveElement)()
  if (active === target) return false
  if (active !== null && active.tagName !== 'BODY') return false
  return true
}

/**
 * Keep the composer focused for as long as the embedded pane is in use.
 *
 * The watchdog never stops on its own: the pane can be re-activated any number
 * of times (every switch back to this session), and each activation needs the
 * composer focused again, because switching moves focus out to the parent. It
 * costs one cheap check per interval and does nothing at all while the frame is
 * unfocused or while the user is working with another control in here.
 * @param deps - injectable environment and timing.
 * @returns a disposer that stops the watchdog.
 */
export function startEmbedComposerFocus(deps: EmbedFocusDeps = {}): () => void {
  const pollMs = deps.pollMs ?? EMBED_FOCUS_POLL_MS
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: number) => { window.clearTimeout(handle) })

  let disposed = false
  let handle: number | undefined

  const tick = (): void => {
    handle = undefined
    if (disposed) return
    try {
      if (shouldFocusEmbedComposer(deps)) focusEmbedComposer(deps)
    } catch {
      // A detached or half-torn-down document: try again next tick.
    }
    if (!disposed) handle = setTimer(tick, pollMs)
  }

  handle = setTimer(tick, pollMs)

  return () => {
    disposed = true
    if (handle !== undefined) {
      clearTimer(handle)
      handle = undefined
    }
  }
}
