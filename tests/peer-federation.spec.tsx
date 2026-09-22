// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PeerSessionView } from '../src/client/PeerSessionView.tsx'
import { PeerWorkspacesSection } from '../src/client/PeerWorkspacesSection.tsx'
import { findCenterHost, findSidebarListHost } from '../src/client/peer-mount.tsx'
import { peerSessionStore } from '../src/client/peer-session-store.ts'
import { en, type RemoteKey } from '../src/client/locales.ts'

const t = (key: RemoteKey) => en[key]

function buildSidebarDom(): void {
  document.body.innerHTML = ''
  const col = document.createElement('div')
  col.className = 'abc123_sidebarCol'
  const list = document.createElement('div')
  list.className = 'abc123_list'
  const officialRow = document.createElement('div')
  officialRow.className = 'abc123_sessionRow'
  officialRow.textContent = 'local session'
  list.appendChild(officialRow)
  col.appendChild(list)
  document.body.appendChild(col)
}

const PEER_STATE = {
  configured: true,
  online: true,
  baseUrl: 'https://peer.example',
  inventory: {
    sessions: [
      { id: 's-1', title: 'Refactor auth', updatedAt: 1_700_000_000_000, running: true },
      { id: 's-2', title: 'Fix flaky test', running: false },
      { id: 's-orphan', title: 'Loose session', running: false },
    ],
    workspaces: [
      { id: 'w-1', title: 'dsh-web', path: 'C:/code/dsh-web', sessionIds: ['s-1', 's-2'] },
    ],
  },
}

describe('official anchor lookup', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('finds the sidebar list only inside the sidebar column', () => {
    buildSidebarDom()
    expect(findSidebarListHost(document)?.className).toBe('abc123_list')
    // A list outside the sidebar column is not an anchor.
    const stray = document.createElement('div')
    stray.className = 'zzz_list'
    document.body.appendChild(stray)
    const col = document.querySelector('[class$="_sidebarCol"]')
    col?.remove()
    expect(findSidebarListHost(document)).toBeNull()
  })

  it('finds the center column host and rejects lookalikes elsewhere', () => {
    const center = document.createElement('div')
    center.className = 'q1_centerCol'
    document.body.appendChild(center)
    expect(findCenterHost(document)).toBe(center)
    center.remove()
    expect(findCenterHost(document)).toBeNull()
  })
})
describe('peer workspaces section', () => {
  afterEach(() => {
    cleanup()
    peerSessionStore.clear()
    vi.unstubAllGlobals()
    window.localStorage.clear()
    document.body.innerHTML = ''
  })

  it('offers a new conversation per workspace and starts one through the store', async () => {
    // The gap this covers: the section could only open existing sessions, so
    // there was no way to begin a conversation from the remote workspace.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(PEER_STATE), { status: 200 })))
    peerSessionStore.setFetcher(vi.fn().mockResolvedValue('u'))
    const started: Array<string | undefined> = []
    peerSessionStore.setStarter(async (workspaceId) => {
      started.push(workspaceId)
      return { sessionId: 'session-fresh', url: 'https://proxy/pair-app?ticket=fresh' }
    })

    const { container } = render(<PeerWorkspacesSection t={t} />)
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[class*="newConversationRow"]')
      if (found === null) throw new Error('new-conversation control not rendered yet')
      return found
    })
    // The control names its workspace, so a row's button is unambiguous.
    expect(button.getAttribute('aria-label')).toContain('dsh-web')

    button.click()
    await waitFor(() => expect(started).toEqual(['w-1']))
    await waitFor(() => expect(peerSessionStore.getState().activeSessionId).toBe('session-fresh'))
  })

  it('offers the control on a single-session workspace too', async () => {
    // The two render branches are genuinely different markup (a solo caption row
    // versus a foldable row), so covering only the multi-session fixture leaves the
    // solo branch unexecuted. That branch is exactly where a missing declaration
    // once broke the whole section at render time, so it needs its own case.
    const solo = {
      configured: true,
      online: true,
      inventory: {
        sessions: [{ id: 's-only', title: 'Only session', running: false }],
        workspaces: [{ id: 'w-solo', title: 'solo-project', path: 'C:/code/solo', sessionIds: ['s-only'] }],
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(solo), { status: 200 })))
    peerSessionStore.setFetcher(vi.fn().mockResolvedValue('u'))
    const started: Array<string | undefined> = []
    peerSessionStore.setStarter(async (workspaceId) => {
      started.push(workspaceId)
      return { sessionId: 'session-solo', url: 'https://proxy/pair-app?ticket=solo' }
    })

    const { container } = render(<PeerWorkspacesSection t={t} />)
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[class*="newConversationRow"]')
      if (found === null) throw new Error('solo control not rendered yet')
      return found
    })
    expect(button.getAttribute('aria-label')).toContain('solo-project')

    button.click()
    await waitFor(() => expect(started).toEqual(['w-solo']))
  })

  it('offers no new-conversation control for the unassigned remainder', async () => {
    // "Unassigned" is a presentation bucket, not a workspace: there is no id to
    // start a conversation in, so it must not offer one.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(PEER_STATE), { status: 200 })))
    peerSessionStore.setFetcher(vi.fn().mockResolvedValue('u'))
    const { container } = render(<PeerWorkspacesSection t={t} />)
    const rows = await waitFor(() => {
      const found = [...container.querySelectorAll<HTMLButtonElement>('button[class*="newConversationRow"]')]
      if (found.length === 0) throw new Error('controls not rendered yet')
      return found
    })
    // Only the one real workspace in the fixture gets a control.
    expect(rows.length).toBe(1)
    for (const row of rows) expect(row.getAttribute('aria-label')).not.toContain('Unassigned')
  })

  it('renders workspace groups and opens a session through the store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(PEER_STATE), { status: 200 })))
    const fetcher = vi.fn().mockResolvedValue('https://proxy/pair-app?ticket=7')
    peerSessionStore.setFetcher(fetcher)

    const { container } = render(<PeerWorkspacesSection t={t} />)
    // The section header reads from the en dictionary.
    expect(screen.getByText('Remote workspaces')).toBeTruthy()
    // The header carries no folder icon: a folder glyph is what made the section
    // read as one more local project rather than a peer surface. The only icon the
    // header keeps is the collapse chevron, so exactly one svg may be present.
    const head = container.querySelector('[data-dsh-part="peer-workspace-section"] button')
    expect(head?.querySelectorAll('svg').length).toBe(1)

    const orphanButton = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('[data-dsh-part="peer-workspace-section"] button[class*="sessionRow"]')
      if (found === null) throw new Error('rows not rendered yet')
      return found
    })
    // Single-session groups render open; the "Loose session" orphan is that one.
    expect(orphanButton.textContent).toContain('Loose session')
    // A multi-session workspace starts folded: expand the dsh-web folder first.
    const folderButton = container.querySelector<HTMLButtonElement>('[data-dsh-part="peer-workspace-section"] button[class*="projectRow"]')
    expect(folderButton).not.toBeNull()
    fireEvent.click(folderButton!)
    const refactorButton = await waitFor(() => {
      const found = [...container.querySelectorAll<HTMLButtonElement>('button[class*="sessionRow"]')]
        .find(button => button.textContent?.includes('Refactor auth'))
      if (found === undefined) throw new Error('group rows not expanded yet')
      return found
    })
    refactorButton.click()
    await waitFor(() => {
      expect(peerSessionStore.getState().activeSessionId).toBe('s-1')
    })
    expect(peerSessionStore.getState().entries[0]?.url).toBe('https://proxy/pair-app?ticket=7')
  })

  it('shows the offline copy when the peer source is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ configured: false, online: false }), { status: 200 })))
    render(<PeerWorkspacesSection t={t} />)
    expect(await screen.findByText('Workspace source offline')).toBeTruthy()
  })

  it('toggles collapsed state and persists it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(PEER_STATE), { status: 200 })))
    const { container } = render(<PeerWorkspacesSection t={t} />)
    const head = container.querySelector<HTMLButtonElement>('[data-dsh-part="peer-workspace-section"] > button')
    expect(head).not.toBeNull()
    fireEvent.click(head!)
    expect(window.localStorage.getItem('dsh-peer-workspaces-collapsed')).toBe('1')
    expect(container.querySelector('[data-dsh-part="peer-workspace-section"] [class*="sessionRow"]')).toBeNull()
    fireEvent.click(head!)
    expect(window.localStorage.getItem('dsh-peer-workspaces-collapsed')).toBe('0')
  })
})

describe('peer session view', () => {
  afterEach(() => {
    cleanup()
    peerSessionStore.clear()
    document.body.innerHTML = ''
  })

  it('stops painting when collapsed and keeps only the focused frame visible', async () => {
    peerSessionStore.setFetcher(async () => 'https://proxy/pair-app?ticket=9')
    const view = render(<PeerSessionView />)

    await peerSessionStore.openRemote('s-9')
    const container = () => document.querySelector('[data-dsh-part="peer-session-view"]')!
    await waitFor(() => expect(container().getAttribute('data-collapsed')).toBe('false'))
    const frame = () => container().querySelector('iframe[data-dsh-part="peer-session-frame"]')!
    expect(frame()).not.toBeNull()
    // The focused frame is visible; frames are toggled by opacity (data-active),
    // never the hidden attribute - the desktop app's software rendering repaints
    // a hidden-then-shown iframe as a blank white surface.
    expect(frame().getAttribute('data-active')).toBe('true')
    expect(frame().hasAttribute('hidden')).toBe(false)

    // The user opens a local session: the view collapses. The container kept
    // an opaque full-bleed background, so it blanked the local conversation —
    // collapsed must mean "paints nothing" while the iframe stays mounted.
    peerSessionStore.noteLocalSessionActive()
    await waitFor(() => expect(container().getAttribute('data-collapsed')).toBe('true'))
    expect(frame()).not.toBeNull()

    // Re-opening the peer session shows the same entry again.
    await peerSessionStore.openRemote('s-9')
    await waitFor(() => expect(container().getAttribute('data-collapsed')).toBe('false'))
    expect(frame().getAttribute('data-active')).toBe('true')
    view.unmount()
  })

  it('stacks a second session without hidden iframes', async () => {
    peerSessionStore.setFetcher(async (sessionId) => 'https://proxy/pair-app?ticket=' + sessionId)
    const view = render(<PeerSessionView />)

    await peerSessionStore.openRemote('s-1')
    await peerSessionStore.openRemote('s-2')
    const container = () => document.querySelector('[data-dsh-part="peer-session-view"]')!
    await waitFor(() => expect(container().querySelectorAll('iframe[data-dsh-part="peer-session-frame"]').length).toBe(2))
    const frames = container().querySelectorAll('iframe[data-dsh-part="peer-session-frame"]')
    const states = [...frames].map(f => f.getAttribute('data-active'))
    expect(states.sort()).toEqual(['false', 'true'])
    for (const f of frames) expect(f.hasAttribute('hidden')).toBe(false)
    view.unmount()
  })

  it('grants frame focus again when switching back to an already-open session', async () => {
    // The parent half of the composer focus handoff, and the fix for the
    // reported "only some sessions refuse typing": frames stay mounted across
    // switches, so a re-opened session inserts no new element and would never
    // be granted browser focus a second time. Without this the pane stops
    // accepting keystrokes until the user clicks the input box.
    peerSessionStore.setFetcher(async (sessionId) => 'https://proxy/pair-app?ticket=' + sessionId)
    const view = render(<PeerSessionView />)
    await peerSessionStore.openRemote('s-1')
    await peerSessionStore.openRemote('s-2')
    const container = () => document.querySelector('[data-dsh-part="peer-session-view"]')!
    await waitFor(() => expect(container().querySelectorAll('iframe').length).toBe(2))

    // Record every focus() call the view makes on its frames.
    const focused: string[] = []
    for (const frame of container().querySelectorAll<HTMLIFrameElement>('iframe')) {
      const original = frame.focus.bind(frame)
      frame.focus = () => { focused.push(frame.getAttribute('title') ?? ''); original() }
    }

    // Switch back to the first session: no new iframe is inserted.
    await peerSessionStore.openRemote('s-1')
    await waitFor(() => expect(container().querySelectorAll('iframe').length).toBe(2))
    await waitFor(() => expect(focused).toContain('s-1'))
    view.unmount()
  })

  it('does not pull focus out of the local composer when activating a pane', async () => {
    // The grant runs on every activation change, so without this guard opening
    // or switching a peer pane would interrupt someone typing in the local
    // shell — worse than the bug the grant exists to fix.
    peerSessionStore.setFetcher(async (sessionId) => 'https://proxy/pair-app?ticket=' + sessionId)
    const view = render(<PeerSessionView />)
    await peerSessionStore.openRemote('s-1')
    const container = () => document.querySelector('[data-dsh-part="peer-session-view"]')!
    await waitFor(() => expect(container().querySelectorAll('iframe').length).toBe(1))

    const frame = container().querySelector<HTMLIFrameElement>('iframe')!
    let focusCalls = 0
    frame.focus = () => { focusCalls += 1 }

    // The user is typing in the local composer.
    const local = document.createElement('div')
    local.setAttribute('contenteditable', 'true')
    document.body.appendChild(local)
    local.focus()
    expect(document.activeElement).toBe(local)

    // Activating another pane must leave the local composer alone.
    await peerSessionStore.openRemote('s-2')
    await waitFor(() => expect(container().querySelectorAll('iframe').length).toBe(2))
    expect(focusCalls).toBe(0)
    expect(document.activeElement).toBe(local)
    local.remove()
    view.unmount()
  })
})
