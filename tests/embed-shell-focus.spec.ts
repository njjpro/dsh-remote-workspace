// @vitest-environment jsdom
/**
 * Embedded-shell composer focus (inner half).
 *
 * The regression these assertions pin: the embedded pane is a cross-origin
 * iframe, so it opens with nothing focused inside it — focus is still in the
 * parent shell, on the sidebar row the user just clicked — and keystrokes then
 * reach no element. The user experiences that as "the input box does not accept
 * typing" even though the composer is enabled.
 *
 * Design points these tests protect, each of which a plausible-looking variant
 * gets wrong:
 *
 * - The watchdog does not stop after a first success. Switching away moves focus
 *   back out to the parent, so every re-activation needs the composer focused
 *   again; a one-shot driver leaves the pane broken after a switch back, which
 *   is the reported symptom.
 * - It does not act while the frame is unfocused, and it never takes focus from
 *   a control the user already focused inside the frame.
 * - It is a watchdog, not a listener on the frame's `focus` event: that event
 *   was observed not to arrive on a parent grant, so an event-driven driver
 *   would stay silent in exactly the failing case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMBED_COMPOSER_SELECTOR,
  focusEmbedComposer,
  shouldFocusEmbedComposer,
  startEmbedComposerFocus,
} from '../src/client/embed-shell-focus.ts'

/**
 * Build a body with one composer whose focus() records calls.
 * @returns an object exposing the composer and the recorded call count.
 */
function buildDom(): { composer: HTMLElement; calls: () => number } {
  document.body.innerHTML = ''
  const composer = document.createElement('div')
  composer.setAttribute('contenteditable', 'true')
  composer.textContent = ''
  document.body.appendChild(composer)
  let calls = 0
  ;(composer as HTMLElement & { focus: () => void }).focus = function focus(this: HTMLElement) {
    calls += 1
  }
  return { composer, calls: () => calls }
}

describe('embed composer focus', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('targets the official composer host', () => {
    expect(EMBED_COMPOSER_SELECTOR).toBe('[contenteditable="true"]')
  })

  it('reports failure when there is no composer yet', () => {
    document.body.innerHTML = '<div>still booting</div>'
    expect(focusEmbedComposer({ root: document })).toBe(false)
  })

  it('reports success only once the composer actually holds focus', () => {
    const { composer } = buildDom()
    let active: Element | null = null
    expect(focusEmbedComposer({ root: document, activeElement: () => active })).toBe(false)
    active = composer
    expect(focusEmbedComposer({ root: document, activeElement: () => active })).toBe(true)
  })

  it('does not touch the composer while this frame is unfocused', () => {
    // Acting then is pointless (keystrokes go to the focused frame) and would
    // fight a user working in the parent shell.
    buildDom()
    vi.useFakeTimers()
    const stop = startEmbedComposerFocus({
      root: document,
      hasFocus: () => false,
      activeElement: () => document.body,
      pollMs: 100,
    })
    vi.advanceTimersByTime(2000)
    expect(shouldFocusEmbedComposer({ root: document, hasFocus: () => false, activeElement: () => document.body })).toBe(false)
    stop()
  })

  it('focuses the composer as soon as the frame is focused', () => {
    const { calls } = buildDom()
    vi.useFakeTimers()
    let frameFocused = false
    const stop = startEmbedComposerFocus({
      root: document,
      hasFocus: () => frameFocused,
      activeElement: () => document.body,
      pollMs: 100,
    })
    vi.advanceTimersByTime(500)
    expect(calls()).toBe(0) // no browser focus yet
    frameFocused = true
    vi.advanceTimersByTime(300)
    expect(calls()).toBeGreaterThan(0)
    stop()
  })

  it('keeps watching, so a switch back focuses the composer again', () => {
    // The reported symptom: frames stay mounted, so re-opening a session gives
    // the pane no new focus. A driver that stopped after one success would look
    // correct here and still leave the pane unable to take typing.
    const { composer, calls } = buildDom()
    vi.useFakeTimers()
    let frameFocused = true
    const stop = startEmbedComposerFocus({
      root: document,
      hasFocus: () => frameFocused,
      activeElement: () => (calls() > 0 ? composer : document.body),
      pollMs: 100,
    })
    vi.advanceTimersByTime(200)
    const afterFirst = calls()
    expect(afterFirst).toBeGreaterThan(0)

    // The user switches away (frame loses focus), then comes back.
    frameFocused = false
    vi.advanceTimersByTime(500)
    const whileAway = calls()
    frameFocused = true
    // Focus has left the composer again, as it does on a switch.
    const composerFocused = { value: false }
    const stop2 = startEmbedComposerFocus({
      root: document,
      hasFocus: () => true,
      activeElement: () => (composerFocused.value ? composer : document.body),
      pollMs: 100,
    })
    vi.advanceTimersByTime(200)
    expect(calls()).toBeGreaterThan(whileAway)
    expect(calls()).toBeGreaterThan(afterFirst)
    stop()
    stop2()
  })

  it('waits for the composer to mount instead of giving up', () => {
    document.body.innerHTML = '<div>still booting</div>'
    vi.useFakeTimers()
    const stop = startEmbedComposerFocus({
      root: document,
      hasFocus: () => true,
      activeElement: () => document.body,
      pollMs: 100,
    })
    vi.advanceTimersByTime(2000)
    // Now it appears; the watchdog must pick it up.
    const { composer, calls } = buildDom()
    vi.advanceTimersByTime(400)
    expect(calls()).toBeGreaterThan(0)
    expect(shouldFocusEmbedComposer({ root: document, hasFocus: () => true, activeElement: () => composer })).toBe(false)
    stop()
  })

  it('never steals focus from another control inside the frame', () => {
    const { calls } = buildDom()
    const button = document.createElement('button')
    document.body.appendChild(button)
    vi.useFakeTimers()
    const stop = startEmbedComposerFocus({
      root: document,
      hasFocus: () => true,
      activeElement: () => button,
      pollMs: 100,
    })
    vi.advanceTimersByTime(1500)
    expect(calls()).toBe(0)
    expect(shouldFocusEmbedComposer({ root: document, hasFocus: () => true, activeElement: () => button })).toBe(false)
    stop()
  })

  it('leaves an already-focused composer alone', () => {
    const { composer } = buildDom()
    expect(shouldFocusEmbedComposer({
      root: document,
      hasFocus: () => true,
      activeElement: () => composer,
    })).toBe(false)
  })

  it('stops entirely once disposed', () => {
    const { calls } = buildDom()
    vi.useFakeTimers()
    const stop = startEmbedComposerFocus({
      root: document,
      hasFocus: () => true,
      activeElement: () => document.body,
      pollMs: 100,
    })
    vi.advanceTimersByTime(200)
    const before = calls()
    stop()
    vi.advanceTimersByTime(5000)
    expect(calls()).toBe(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tolerates a composer whose focus() throws', () => {
    const { composer } = buildDom()
    ;(composer as HTMLElement & { focus: () => void }).focus = () => { throw new Error('detached') }
    expect(focusEmbedComposer({ root: document })).toBe(false)
  })

  it('survives a document that cannot be queried', () => {
    const hostile = { querySelector: () => { throw new Error('gone') } } as unknown as ParentNode
    expect(() => shouldFocusEmbedComposer({ root: hostile, hasFocus: () => true })).toThrow()
    // The watchdog swallows that per tick, so it must keep running.
    vi.useFakeTimers()
    const stop = startEmbedComposerFocus({ root: hostile, hasFocus: () => true, pollMs: 100 })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    stop()
  })
})
