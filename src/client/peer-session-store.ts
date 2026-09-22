/**
 * Peer session store: the module-level bridge between the sidebar's peer
 * workspace rows and the center-column peer session view. The two faces are
 * separate React roots mounted into different official DOM regions, so the
 * open/active state must live outside React; this tiny store is that state.
 *
 * One iframe entry per open peer session is kept until explicitly closed or
 * evicted by the live-pane bound below — switching back to a local session only
 * collapses the view (the peer GUI keeps its loaded state), matching how a local
 * session switch keeps the conversation mounted.
 */

/**
 * Maximum number of peer panes kept mounted at once.
 *
 * Every open peer session is a full peer application in an iframe served from
 * ONE origin (the loopback embed proxy), and each holds a long-lived EventSource
 * to that origin. Browsers allow six concurrent HTTP/1.1 connections per origin,
 * so with no bound the first six panes' streams take every slot: later panes
 * never finish booting and sit on the shell's "select a workspace" screen
 * forever, while a reload only helps until the same count is reached again.
 *
 * Measured against the real proxy (one EventSource per pane, per-origin limit 6):
 * with no bound the sixth and later panes failed, and freeing older panes made
 * the very same session render again. Keeping at most three mounted rendered
 * every session that can render at all, leaves half the slots for the panes'
 * own boot traffic, and still keeps recent panes warm so switching back does not
 * reload them.
 */
export const PEER_MAX_LIVE_PANES = 3

/** One open peer session (its embed URL is resolved once, on first open). */
export interface PeerSessionEntry {
  sessionId: string
  url?: string
  /**
   * Recency stamp for eviction, incremented on every activation. Entries are
   * stored in open order, which is not activity order, so re-focusing an old
   * entry has to record that it is now the most recent one.
   */
  lastUsedAt?: number
}

/** Immutable store snapshot. */
export interface PeerSessionState {
  entries: PeerSessionEntry[]
  /** The visible entry; undefined = collapsed (local session view shows). */
  activeSessionId?: string
}

/** Resolves the one-shot embed URL for a peer session. */
export type PeerEmbedUrlFetcher = (sessionId: string) => Promise<string | undefined>

/** Starts a conversation in a peer workspace; resolves to its session + embed URL. */
export type PeerNewSessionStarter = (workspaceId?: string) => Promise<{ sessionId: string; url: string } | undefined>

export interface PeerSessionStore {
  getState(): PeerSessionState
  /** Open (or focus) a peer session; resolves once the entry exists. */
  openRemote(sessionId: string): Promise<void>
  /**
   * Start a NEW conversation in a peer workspace and open it. The peer creates
   * the session; this opens whatever id it returns.
   */
  startRemote(workspaceId?: string): Promise<void>
  /** Hide the view without destroying loaded peer sessions. */
  collapse(): void
  /** Destroy one peer session's entry and iframe. */
  close(sessionId: string): void
  /** The user opened a local session: collapse any visible peer view. */
  noteLocalSessionActive(): void
  subscribe(listener: () => void): () => void
  /** Inject the embed-URL fetcher (called once from the client apply). */
  setFetcher(fetcher: PeerEmbedUrlFetcher): void
  /** Inject the new-conversation starter (called once from the client apply). */
  setStarter(starter: PeerNewSessionStarter): void
  /** Drop every entry (unmount teardown). */
  clear(): void
}

interface StoreInternal extends PeerSessionStore {
  /** Pending-open guard: a second click while the ticket resolves is a no-op. */
  pending: Set<string>
  fetcher?: PeerEmbedUrlFetcher
  starter?: PeerNewSessionStarter
  listeners: Set<() => void>
  state: PeerSessionState
  /** Monotonic recency source; injectable so tests can order activations. */
  clock: () => number
}

function emit(self: StoreInternal): void {
  for (const listener of self.listeners) listener()
}

function mutate(self: StoreInternal, next: PeerSessionState): void {
  self.state = next
  emit(self)
}

/**
 * Create a peer session store.
 * @param options - optional overrides (a clock, for deterministic tests).
 * @returns the store.
 */
export function createPeerSessionStore(options: { clock?: () => number } = {}): StoreInternal {
  let tick = 0
  const self: StoreInternal = {
    clock: options.clock ?? (() => { tick += 1; return tick }),
    pending: new Set(),
    listeners: new Set(),
    state: { entries: [] },
    getState() {
      return self.state
    },
    setFetcher(fetcher) {
      self.fetcher = fetcher
    },
    setStarter(starter) {
      self.starter = starter
    },
    async startRemote(workspaceId) {
      const starter = self.starter
      if (starter === undefined) return
      // Keyed by workspace, not by session: the session id does not exist until
      // the peer creates it, so it cannot serve as the pending guard.
      const key = `new:${workspaceId ?? ''}`
      if (self.pending.has(key)) return
      self.pending.add(key)
      try {
        const created = await starter(workspaceId)
        if (created === undefined) return
        const opened: PeerSessionEntry = { sessionId: created.sessionId, url: created.url, lastUsedAt: self.clock() }
        const entries = self.state.entries
          .map((entry, index) => ({
            entry,
            used: entry.lastUsedAt ?? index - self.state.entries.length,
          }))
          .concat([{ entry: opened, used: Number.POSITIVE_INFINITY }])
          .sort((a, b) => b.used - a.used)
          .slice(0, PEER_MAX_LIVE_PANES)
          .map(item => item.entry)
        mutate(self, { entries, activeSessionId: created.sessionId })
      } finally {
        self.pending.delete(key)
      }
    },
    async openRemote(sessionId) {
      if (self.pending.has(sessionId)) return
      const existing = self.state.entries.find(entry => entry.sessionId === sessionId)
      if (existing === undefined && self.fetcher === undefined) return
      if (existing !== undefined) {
        // Re-focusing is use: stamp it so eviction keeps what was used most
        // recently rather than what was opened most recently.
        mutate(self, {
          ...self.state,
          entries: self.state.entries.map(entry => (
            entry.sessionId === sessionId ? { ...entry, lastUsedAt: self.clock() } : entry
          )),
          activeSessionId: sessionId,
        })
        return
      }
      self.pending.add(sessionId)
      try {
        const url = await self.fetcher?.(sessionId)
        if (url === undefined) return
        // Open, then evict down to the bound. The newly opened entry is the most
        // recently used by construction, so it can never evict itself.
        const opened: PeerSessionEntry = { sessionId, url, lastUsedAt: self.clock() }
        const entries = self.state.entries
          .map((entry, index) => ({
            entry,
            // Entries predating the stamp sort oldest by open order.
            used: entry.lastUsedAt ?? index - self.state.entries.length,
          }))
          .concat([{ entry: opened, used: Number.POSITIVE_INFINITY }])
          .sort((a, b) => b.used - a.used)
          .slice(0, PEER_MAX_LIVE_PANES)
          .map(item => item.entry)
        mutate(self, { entries, activeSessionId: sessionId })
      } finally {
        self.pending.delete(sessionId)
      }
    },
    collapse() {
      if (self.state.activeSessionId === undefined) return
      mutate(self, { ...self.state, activeSessionId: undefined })
    },
    close(sessionId) {
      mutate(self, {
        entries: self.state.entries.filter(entry => entry.sessionId !== sessionId),
        ...(self.state.activeSessionId === sessionId
          ? { activeSessionId: undefined }
          : {}),
      })
    },
    noteLocalSessionActive() {
      if (self.state.activeSessionId !== undefined) self.collapse()
    },
    subscribe(listener) {
      self.listeners.add(listener)
      return () => { self.listeners.delete(listener) }
    },
    clear() {
      self.pending.clear()
      self.state = { entries: [] }
      emit(self)
    },
  }
  return self
}

/** The page-wide instance: sidebar rows and the center view share it. */
export const peerSessionStore: PeerSessionStore = createPeerSessionStore()
