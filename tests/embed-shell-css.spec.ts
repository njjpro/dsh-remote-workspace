/**
 * Embedded-shell layout override (the peer GUI inside a device workspace).
 *
 * The regression these assertions pin: the override used to collapse the
 * official frame to `0 minmax(0,1fr) 0` and only hide `_sidebarCol` /
 * `_detailsCol`. On the current shell the right-hand panel is `_rightbarCol`,
 * so it stayed in flow, took the flexible middle track, and grid
 * auto-placement pushed the chat column into the leading 0-width track — a
 * 0 px center column that paints as a blank white surface while the DOM, the
 * iframe and hit-testing all look healthy.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EMBED_SHELL_ATTR, EMBED_SHELL_STYLE_ID, embedShellCss } from '../src/client/embed-shell-css.ts'

const css = embedShellCss()

/** The full rule line whose selector contains `needle`. */
function ruleLineFor(needle: string): string {
  for (const rule of css.split('\n')) {
    const brace = rule.indexOf('{')
    if (brace === -1) continue
    if (rule.slice(0, brace).includes(needle)) return rule
  }
  throw new Error(`no rule mentioning ${needle}`)
}

/** The declaration block of the first rule whose selector contains `needle`. */
function ruleFor(needle: string): string {
  const rule = ruleLineFor(needle)
  return rule.slice(rule.indexOf('{'))
}

describe('embed shell layout override', () => {
  it('collapses the official frame to a single flexible track', () => {
    const frame = ruleFor('_frame')
    expect(frame).toContain('grid-template-columns:minmax(0,1fr)')
    // The multi-track template is the bug: the chat column would be
    // auto-placed into the leading 0-width track.
    expect(frame).not.toContain('grid-template-columns:0 ')
  })

  it('pins the chat column onto that track instead of relying on auto-placement', () => {
    expect(ruleFor('_centerCol')).toContain('grid-column:1')
  })

  it('hides every known side column, including the right-hand panel name in use today', () => {
    const side = ruleLineFor('_sidebarCol')
    expect(side).toContain('display:none')
    for (const column of ['_sidebarCol', '_detailsCol', '_rightbarCol']) {
      expect(side, column).toContain(column)
    }
  })

  it('scopes every rule to the embed marker and keeps the local surfaces hidden', () => {
    const rules = css.split('\n').filter(line => line.trim() !== '')
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule).toContain(`html[${EMBED_SHELL_ATTR}='1']`)
    }
    expect(ruleFor("data-dsh-plugin='remote-web-ui'")).toContain('display:none')
  })

  it('overrides the official frame rule with !important (it sets its own columns)', () => {
    expect(ruleFor('_frame')).toContain('!important')
  })

  it('keeps the style element id stable for the single-instance guard', () => {
    expect(EMBED_SHELL_STYLE_ID).toBe('dshRemoteEmbedStyle')
  })

  it('is wired into the client apply path through the shared builder', () => {
    const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('embedShellCss()')
    expect(source).toContain('EMBED_SHELL_STYLE_ID')
  })
})
