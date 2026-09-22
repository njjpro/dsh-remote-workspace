import { describe, expect, it, vi } from 'vitest'
import { PEER_MAX_LIVE_PANES, createPeerSessionStore } from '../src/client/peer-session-store.ts'

describe('peer session store', () => {
  it('opens a peer session once, focuses repeats, and keeps entries across collapses', async () => {
    const store = createPeerSessionStore()
    const fetcher = vi.fn().mockResolvedValue('https://proxy/pair-app?ticket=1')
    store.setFetcher(fetcher)
    const events: string[] = []
    store.subscribe(() => { events.push('change') })

    await store.openRemote('sess-1')
    expect(fetcher).toHaveBeenCalledWith('sess-1')
    expect(store.getState().entries).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', url: 'https://proxy/pair-app?ticket=1' }),
    ])
    expect(store.getState().activeSessionId).toBe('sess-1')

    await store.openRemote('sess-1')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.getState().entries).toHaveLength(1)

    await store.openRemote('sess-2')
    expect(store.getState().entries).toHaveLength(2)
    expect(store.getState().activeSessionId).toBe('sess-2')

    store.collapse()
    expect(store.getState().activeSessionId).toBeUndefined()
    expect(store.getState().entries).toHaveLength(2)
    expect(events.length).toBeGreaterThan(0)
  })

  it('does not create an entry when the fetcher is missing or fails', async () => {
    const bare = createPeerSessionStore()
    await bare.openRemote('sess-x')
    expect(bare.getState().entries).toEqual([])

    const failing = createPeerSessionStore()
    failing.setFetcher(vi.fn().mockResolvedValue(undefined))
    await failing.openRemote('sess-y')
    expect(failing.getState().entries).toEqual([])
    expect(failing.getState().activeSessionId).toBeUndefined()
  })

  it('collapses when a local session becomes active and closes destroy entries', async () => {
    const store = createPeerSessionStore()
    store.setFetcher(vi.fn().mockResolvedValue('url'))
    await store.openRemote('sess-1')
    await store.openRemote('sess-2')

    store.noteLocalSessionActive()
    expect(store.getState().activeSessionId).toBeUndefined()
    expect(store.getState().entries).toHaveLength(2)

    // Collapsed already: a local note is a no-op (no spurious notifications).
    const events: number[] = []
    store.subscribe(() => { events.push(events.length) })
    store.noteLocalSessionActive()
    expect(events).toEqual([])

    await store.openRemote('sess-1')
    store.close('sess-1')
    expect(store.getState().entries.map(entry => entry.sessionId)).toEqual(['sess-2'])
    expect(store.getState().activeSessionId).toBeUndefined()

    await store.openRemote('sess-2')
    store.close('sess-2')
    expect(store.getState().entries).toEqual([])
    expect(store.getState().activeSessionId).toBeUndefined()
  })

  it('clear() resets everything (page teardown path)', async () => {
    const store = createPeerSessionStore()
    store.setFetcher(vi.fn().mockResolvedValue('url'))
    await store.openRemote('sess-1')
    store.clear()
    expect(store.getState()).toEqual({ entries: [] })
  })
})

/**
 * The live-pane bound.
 *
 * The regression these pin: with no bound, every opened peer session stayed
 * mounted as a full peer app on ONE origin, each holding a long-lived
 * EventSource. Browsers allow six concurrent HTTP/1.1 connections per origin, so
 * from the sixth pane on, later panes never finished booting and sat on the
 * shell's "select a workspace" screen - and a reload only helped until the same
 * count was reached again.
 *
 * Measured against the real proxy before this bound existed: panes 1-5 rendered,
 * pane 6 onward stalled, and unmounting the earlier ones made the very same
 * session render again.
 */
describe('peer session store live-pane bound', () => {
  /** A store whose embed URL fetch resolves immediately. */
  function makeStore() {
    const store = createPeerSessionStore()
    store.setFetcher(async (sessionId: string) => `https://proxy/pair-app?ticket=${sessionId}`)
    return store
  }

  /** Open sessions named s-1..s-n in order. */
  async function openMany(store: ReturnType<typeof makeStore>, n: number): Promise<void> {
    for (let i = 1; i <= n; i += 1) await store.openRemote(`s-${String(i)}`)
  }

  it('keeps at most the bounded number of panes mounted', async () => {
    const store = makeStore()
    await openMany(store, PEER_MAX_LIVE_PANES + 7)
    const ids = store.getState().entries.map(entry => entry.sessionId)
    expect(ids.length).toBe(PEER_MAX_LIVE_PANES)
    // The visible session must survive its own eviction pass.
    expect(ids).toContain(`s-${String(PEER_MAX_LIVE_PANES + 7)}`)
    expect(store.getState().activeSessionId).toBe(`s-${String(PEER_MAX_LIVE_PANES + 7)}`)
  })

  it('evicts the least recently used, not the least recently opened', async () => {
    // The bound must not defeat the point of keeping panes warm: the pane the
    // user just came back to has to be the one that survives.
    const store = makeStore()
    await openMany(store, PEER_MAX_LIVE_PANES)
    // Use the OLDEST opened pane again, making it the most recently used.
    await store.openRemote('s-1')
    // Opening a new session must evict some other pane, never s-1.
    await store.openRemote('s-new')
    const ids = store.getState().entries.map(entry => entry.sessionId)
    expect(ids).toContain('s-1')
    expect(ids).toContain('s-new')
    expect(ids.length).toBe(PEER_MAX_LIVE_PANES)
    // s-2 was the least recently used, so it is the one that goes.
    expect(ids).not.toContain('s-2')
  })

  it('does not evict the pane being activated', async () => {
    const store = makeStore()
    await openMany(store, PEER_MAX_LIVE_PANES + 4)
    const active = store.getState().activeSessionId
    expect(store.getState().entries.some(entry => entry.sessionId === active)).toBe(true)
    // Re-focusing an already-open pane keeps it and makes it active.
    await store.openRemote('s-3')
    expect(store.getState().activeSessionId).toBe('s-3')
    expect(store.getState().entries.some(entry => entry.sessionId === 's-3')).toBe(true)
    expect(store.getState().entries.length).toBe(PEER_MAX_LIVE_PANES)
  })

  it('notifies subscribers without ever exceeding the bound', async () => {
    const store = makeStore()
    const seen: number[] = []
    store.subscribe(() => seen.push(store.getState().entries.length))
    await openMany(store, PEER_MAX_LIVE_PANES + 2)
    expect(Math.max(...seen)).toBeLessThanOrEqual(PEER_MAX_LIVE_PANES)
  })

  it('closing frees a slot for the next open', async () => {
    const store = makeStore()
    await openMany(store, PEER_MAX_LIVE_PANES)
    store.close(store.getState().entries[0].sessionId)
    expect(store.getState().entries.length).toBe(PEER_MAX_LIVE_PANES - 1)
    await store.openRemote('s-fresh')
    expect(store.getState().entries.length).toBe(PEER_MAX_LIVE_PANES)
    expect(store.getState().entries.some(entry => entry.sessionId === 's-fresh')).toBe(true)
  })

  it('leaves room for the panes boot traffic under the per-origin limit', () => {
    // Six concurrent HTTP/1.1 connections per origin, one long-lived EventSource
    // per pane: the bound must leave slots for everything else the panes load.
    expect(PEER_MAX_LIVE_PANES).toBeGreaterThanOrEqual(1)
    expect(PEER_MAX_LIVE_PANES).toBeLessThanOrEqual(4)
  })
})

/**
 * Starting a NEW conversation.
 *
 * The gap this closes: the remote sidebar could only open sessions that already
 * existed. The peer's own new-session control lives in the sidebar column the
 * embed CSS hides, and the embed URL only ever names an existing session, so
 * there was no way to begin one. The peer creates the session and this opens
 * whatever id it returns.
 */
describe('peer session store new conversation', () => {
  /** A store with a starter that succeeds for the given workspace. */
  function makeStore(started: Array<string | undefined> = []) {
    const store = createPeerSessionStore()
    store.setStarter(async (workspaceId) => {
      started.push(workspaceId)
      return { sessionId: `fresh-${String(started.length)}`, url: `https://proxy/pair-app?ticket=fresh-${String(started.length)}` }
    })
    return { store, started }
  }

  it('starts a conversation in the named workspace and opens it', async () => {
    const { store, started } = makeStore()
    await store.startRemote('ws-1')
    expect(started).toEqual(['ws-1'])
    const state = store.getState()
    expect(state.activeSessionId).toBe('fresh-1')
    expect(state.entries.map(entry => entry.sessionId)).toEqual(['fresh-1'])
  })

  it('passes no workspace when none is given, letting the peer default', async () => {
    const { store, started } = makeStore()
    await store.startRemote()
    expect(started).toEqual([undefined])
    expect(store.getState().activeSessionId).toBe('fresh-1')
  })

  it('does nothing when no starter is injected', async () => {
    // A build with no new-session route must not invent a local session.
    const store = createPeerSessionStore()
    await store.startRemote('ws-1')
    expect(store.getState()).toEqual({ entries: [] })
  })

  it('leaves no entry behind when the peer refuses to create', async () => {
    const store = createPeerSessionStore()
    store.setStarter(async () => undefined)
    await store.startRemote('ws-1')
    // A failed create must not leave an empty pane or a phantom entry.
    expect(store.getState().entries).toEqual([])
    expect(store.getState().activeSessionId).toBeUndefined()
  })

  it('counts toward the live-pane bound like any other pane', async () => {
    const store = createPeerSessionStore()
    // openRemote needs the embed-URL fetcher; the starter is separate.
    store.setFetcher(async (sessionId: string) => `u:${sessionId}`)
    for (let i = 1; i <= PEER_MAX_LIVE_PANES; i += 1) await store.openRemote(`s-${String(i)}`)
    store.setStarter(async () => ({ sessionId: 's-new', url: 'u' }))
    await store.startRemote('ws-1')
    const ids = store.getState().entries.map(entry => entry.sessionId)
    expect(ids.length).toBe(PEER_MAX_LIVE_PANES)
    expect(ids).toContain('s-new')
    expect(store.getState().activeSessionId).toBe('s-new')
  })

  it('ignores a double click while the peer is still creating', async () => {
    // The session id does not exist yet, so the guard keys on the workspace.
    let release: (() => void) | undefined
    let calls = 0
    const store = createPeerSessionStore()
    store.setStarter(async () => {
      calls += 1
      await new Promise<void>(resolve => { release = resolve })
      return { sessionId: 's-once', url: 'u' }
    })
    const first = store.startRemote('ws-1')
    const second = store.startRemote('ws-1')
    release?.()
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(store.getState().entries.map(entry => entry.sessionId)).toEqual(['s-once'])
    await first
  })
})
