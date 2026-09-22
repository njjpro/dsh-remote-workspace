/**
 * Device-facing peer inventory: the endpoints a PAIRED remote DSH instance
 * calls to browse this instance's workspace (its projects and sessions).
 * The fence is the device credential — the same cookie/header family the
 * cookieless app landing uses — never the loopback control plane: the whole
 * point is that another machine's plugin (paired like any device) can read
 * the session index. The payload is metadata only (ids, titles, workspaces,
 * activity times); transcripts stay behind the embedded GUI.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest } from './loopback.ts'
import type { PeerLink, PeerSnapshot } from './peer.ts'
import type { EmbedTickets, PeerRequestTrace } from './peer-proxy.ts'

/**
 * Structural face of the host's pairing service. This package never imports the
 * pairing package: the official plugin publishes the same predicate as a cordis
 * service (`remoteWebUiPairing`) and the host half adapts it to this shape. Without
 * that plugin the face is absent and every peer route fails closed.
 *
 * Deliberately NOT the shared `isPairedOrLoopbackAllowed` fence: that one also
 * admits loopback, which would widen the trust boundary this fence has always had
 * (a live paired-device credential, nothing else).
 */
export interface PeerPairingFace {
  /** Whether the request carries a live paired-device cookie. */
  isPairedDevice(request: IncomingMessage): boolean
}

/** Duck-typed face of the host session controller feed (cold sessions in). */
export interface PeerFeedFace {
  list(request: unknown, signal: AbortSignal): Promise<{
    items?: readonly {
      sessionId?: string
      updatedAt?: number
      running?: boolean
      blank?: boolean
      origin?: string
      cwd?: string
    }[]
  }>
  /**
   * Create or adopt one session in a workspace. Optional: a peer whose host does
   * not expose it simply cannot start conversations remotely, and the route
   * reports that instead of failing opaquely.
   */
  create?(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId?: string }>
}

/** Duck-typed face of the host workspace registry (projects). */
export interface PeerRegistryFace {
  list(): readonly { id: string; path: string; title: string; sessionIds: readonly string[] }[]
  /**
   * The registry's durable state, where the archive plugin keeps its id set.
   * Optional: the seam is feature-detected, and archives must not reach a remote
   * browser whether or not it is present.
   */
  requireState?(): unknown
  /** Direct archive-set property, when the registry exposes it that way. */
  archivedSessionIds?: readonly string[]
}

/**
 * Collect the ids the workspace registry considers archived.
 *
 * The archive plugin reads and writes this set through the registry's durable
 * state (`requireState().archivedSessionIds`), not as a direct property, so that
 * is the primary source; a direct property is accepted as a fallback for faces
 * that expose one.
 * @param registry - the resolved registry face, when available.
 * @returns every archived id, in both the bare and `session-`-prefixed spelling.
 */
export function archivedSessionIdsOf(registry: PeerRegistryFace | undefined): Set<string> {
  const archived = new Set<string>()
  const absorb = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') continue
      // The archive set may key a session with or without the "session-" prefix,
      // and so may the feed and the workspace rows, so index both spellings.
      archived.add(id)
      archived.add(id.startsWith('session-') ? id.slice('session-'.length) : `session-${id}`)
    }
  }
  try {
    const state = typeof registry?.requireState === 'function' ? registry.requireState() : undefined
    const fromState = (state as { archivedSessionIds?: unknown } | undefined)?.archivedSessionIds
    if (Array.isArray(fromState)) absorb(fromState as string[])
  } catch {
    // An unavailable seam must not break the inventory; fall through.
  }
  if (archived.size === 0 && Array.isArray(registry?.archivedSessionIds)) {
    absorb(registry.archivedSessionIds)
  }
  return archived
}

export interface PeerRemoteDeps {
  /**
   * The host's pairing predicate, resolved per request: the official plugin
   * registers `remoteWebUiPairing` asynchronously, so a one-shot read could cache
   * `undefined` and then refuse every peer forever.
   */
  pairing: () => PeerPairingFace | undefined
  dshHome: string
  /**
   * Accessors resolved PER REQUEST: the host faces register asynchronously
   * and may be absent while this plugin's apply runs (a boot-order race on
   * slower machines), so a one-shot probe would cache `undefined` forever.
   */
  getFeed: () => PeerFeedFace | undefined
  getRegistry: () => PeerRegistryFace | undefined
}

/** One session row on the peer inventory wire. */
export interface PeerSessionRow {
  id: string
  title?: string
  cwd?: string
  updatedAt?: number
  running: boolean
  blank: boolean
  subagent: boolean
}

/** One workspace (project) row: title, path, and its session membership. */
export interface PeerWorkspaceRow {
  id: string
  title: string
  path: string
  sessionIds: string[]
}

export interface PeerInventory {
  generatedAt: number
  sessions: PeerSessionRow[]
  workspaces: PeerWorkspaceRow[]
}

interface ProjcacheRecord {
  identity?: { createdAt?: unknown; cwd?: unknown }
  rows?: { title?: { val?: unknown } }
}

/** Titles/cwd from the harness projection cache (aggregate index + files). */
function readProjcacheTitles(dshHome: string): Map<string, { title?: string; cwd?: string }> {
  const facts = new Map<string, { title?: string; cwd?: string }>()
  const absorb = (id: string, record: ProjcacheRecord): void => {
    const title = typeof record.rows?.title?.val === 'string' && record.rows.title.val !== '' ? record.rows.title.val : undefined
    const cwd = typeof record.identity?.cwd === 'string' && record.identity.cwd !== '' ? record.identity.cwd : undefined
    if (title === undefined && cwd === undefined) return
    facts.set(id, { ...(title !== undefined ? { title } : {}), ...(cwd !== undefined ? { cwd } : {}) })
  }
  try {
    const indexPath = join(dshHome, 'storages', 'session_projcache.json')
    if (existsSync(indexPath)) {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { tables?: { sessions?: Record<string, ProjcacheRecord> } }
      for (const [id, record] of Object.entries(parsed.tables?.sessions ?? {})) absorb(id, record)
    }
  } catch {
    // Aggregate index unreadable: per-session files below still enrich.
  }
  try {
    const dir = join(dshHome, 'storages', 'session_projcache', 'sessions')
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const id = name.slice(0, -'.json'.length)
        if (facts.has(id) && facts.get(id)?.title !== undefined) continue
        try {
          const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { record?: ProjcacheRecord } & ProjcacheRecord
          absorb(id, parsed.record ?? parsed)
        } catch {
          // Single unreadable file: skip it, keep the rest.
        }
      }
    }
  } catch {
    // Directory listing failure: aggregate index facts (if any) remain.
  }
  return facts
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Build the inventory document from whatever faces resolved (feed first). */
export async function buildPeerInventory(deps: PeerRemoteDeps, signal: AbortSignal): Promise<PeerInventory | undefined> {
  const feed = deps.getFeed()
  if (feed === undefined) return undefined
  const response = await feed.list({}, signal)
  const titles = readProjcacheTitles(deps.dshHome)
  const registry = deps.getRegistry()
  // Archived sessions must not reach a remote browser. The archive plugin keeps
  // them in the session feed and (for some rows) still lists them inside a
  // workspace's sessionIds, so both paths below have to drop them: a remote
  // shell filters archived sessions out while resolving a workspace, so listing
  // one produces a row that cannot be opened — it opens onto the shell's
  // "select a workspace" screen instead of its history.
  const archived = archivedSessionIdsOf(registry)
  const isArchived = (id: string): boolean => archived.has(id)
  const sessions: PeerSessionRow[] = []
  for (const item of response.items ?? []) {
    if (typeof item.sessionId !== 'string' || item.sessionId === '') continue
    if (isArchived(item.sessionId)) continue
    const facts = titles.get(item.sessionId)
    sessions.push({
      id: item.sessionId,
      ...(facts?.title !== undefined ? { title: facts.title } : {}),
      ...(typeof item.cwd === 'string' && item.cwd !== '' ? { cwd: item.cwd } : {}),
      ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
      running: item.running === true,
      blank: item.blank === true,
      subagent: item.origin === 'subagent',
    })
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id))
  const workspaces: PeerWorkspaceRow[] = []
  if (registry !== undefined) {
    for (const entity of registry.list()) {
      workspaces.push({
        id: entity.id,
        title: entity.title,
        path: entity.path,
        sessionIds: [...entity.sessionIds].filter(id => !isArchived(id)),
      })
    }
  }
  return { generatedAt: Date.now(), sessions, workspaces }
}

/**
 * One authenticated peer request: a live paired-device credential is required, and
 * loopback is NOT a bypass. The predicate is the host's own pairing check, so a
 * request that could not pair with this instance cannot read its inventory either.
 */
function peerFence(deps: PeerRemoteDeps, req: IncomingMessage, res: ServerResponse): boolean {
  if (deps.pairing()?.isPairedDevice(req) === true) return true
  writeJson(res, 401, { ok: false, code: 'unpaired' })
  return false
}

/**
 * Mount the peer inventory routes. Registered on every instance that ships
 * this build: an instance without peers configured simply never gets called.
 * @param deps - pairing service, dsh home, and the resolved host faces.
 * @returns the route list for the webServer registration.
 */
export function makePeerRemoteRoutes(deps: PeerRemoteDeps): WebRoute[] {
  let cache: { at: number; inventory: PeerInventory | undefined } | undefined
  const inventory = async (res: ServerResponse, signal: AbortSignal): Promise<void> => {
    if (cache !== undefined && Date.now() - cache.at < 3_000) {
      writeJson(res, 200, { ok: true, ...(cache.inventory ?? {}) })
      return
    }
    try {
      const built = await buildPeerInventory(deps, signal)
      // Only successful builds are cached: a feed-unavailable 503 must not
      // pin the cold state while the host faces finish registering.
      if (built === undefined) {
        writeJson(res, 503, { ok: false, code: 'feed-unavailable' })
        return
      }
      cache = { at: Date.now(), inventory: built }
      writeJson(res, 200, { ok: true, ...built })
    } catch {
      if (signal.aborted) return
      writeJson(res, 500, { ok: false, code: 'inventory-failed' })
    }
  }
  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: '/pair-remote/ping',
      handler: (req, res) => {
        if (!peerFence(deps, req, res)) return
        // The fence is the pairing predicate itself, so reaching here means the
        // credential is live and the device is known; it also refreshes presence,
        // which is the point: a polling peer stays deliberately alive, like a
        // heartbeat. `known` is therefore constant true and kept only for wire
        // compatibility with peers already reading that field.
        writeJson(res, 200, { ok: true, known: true })
      },
    },
    {
      kind: 'exact',
      path: '/pair-remote/inventory',
      handler: (req, res) => {
        if (!peerFence(deps, req, res)) return
        void inventory(res, AbortSignal.timeout(8_000))
      },
    },
    {
      // Start a conversation in one of this instance's workspaces, so a paired
      // browser can begin a new session without a pre-existing session id. Same
      // trust boundary as the embed pane itself: a paired device can already
      // open a session there and send prompts, and this only mints the empty
      // session that pane would then drive.
      kind: 'exact',
      path: '/pair-remote/session',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
          return
        }
        if (!peerFence(deps, req, res)) return
        void (async () => {
          const body = await readJsonObject(req)
          if (body === undefined) {
            writeJson(res, 400, { ok: false, code: 'bad-payload' })
            return
          }
          const workspaceId = body.workspaceId
          if (workspaceId !== undefined && typeof workspaceId !== 'string') {
            writeJson(res, 400, { ok: false, code: 'bad-workspace' })
            return
          }
          // Only a workspace this instance actually has may be named, so a
          // caller cannot steer creation at an arbitrary path.
          if (typeof workspaceId === 'string' && workspaceId !== '') {
            const registry = deps.getRegistry()
            const known = registry?.list().some(entity => entity.id === workspaceId) === true
            if (!known) {
              writeJson(res, 404, { ok: false, code: 'unknown-workspace' })
              return
            }
          }
          const feed = deps.getFeed()
          if (feed?.create === undefined) {
            writeJson(res, 501, { ok: false, code: 'create-unavailable' })
            return
          }
          try {
            const created = await feed.create(
              typeof workspaceId === 'string' && workspaceId !== '' ? { workspaceId } : {},
            )
            const sessionId = created?.sessionId
            if (typeof sessionId !== 'string' || sessionId === '') {
              writeJson(res, 502, { ok: false, code: 'create-empty' })
              return
            }
            writeJson(res, 200, { ok: true, sessionId })
          } catch {
            if (!res.headersSent) writeJson(res, 502, { ok: false, code: 'create-failed' })
          }
        })().catch(() => {
          if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'create-failed' })
        })
      },
    },
  ]
  return routes
}

export interface PeerControlDeps {
  /** The live peer link (undefined when no peer is configured). */
  link: () => PeerLink | undefined
  tickets: EmbedTickets
  proxyPort: () => number
  /** The embed proxy's request ring, for the diagnostics endpoint. */
  requestLog?: () => PeerRequestTrace[]
  /** Hands a verified embed URL to the OS default browser. The desktop
   *  window's transparency material does not composite iframe layers, so
   *  the browser-side fallback opens sessions top-level in a real browser. */
  openExternal?: (url: string) => void
}

/** One small JSON body read (bounded, object-only). */
async function readJsonObject(req: IncomingMessage, maxBytes = 16_384): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) return undefined
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Loopback-only control plane for the browser half: the device bar polls the
 * peer snapshot (workspaces + sessions) and mints one-shot embed tickets.
 * @param deps - accessors for the live peer link, the ticket store, the proxy port.
 * @returns the route list for the webServer registration.
 */
export function makePeerControlRoutes(deps: PeerControlDeps): WebRoute[] {
  const loopbackOnly = (req: IncomingMessage, res: ServerResponse): boolean => {
    // The control plane stays loopback-only. `isLoopbackRequest` is the shared
    // fence: socket address AND Host header must both be loopback, so a LAN origin
    // cannot reach the mint/ticket endpoints even with a forged Host.
    if (isLoopbackRequest(req)) return true
    writeJson(res, 403, { ok: false, code: 'forbidden' })
    return false
  }
  return [
    {
      kind: 'exact',
      path: '/api/pair/peer',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
          return
        }
        if (!loopbackOnly(req, res)) return
        const snapshot: PeerSnapshot = deps.link()?.snapshot() ?? { configured: false, online: false }
        writeJson(res, 200, { ok: true, ...snapshot })
      },
    },
    {
      kind: 'exact',
      path: '/api/pair/peer/embed-ticket',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
          return
        }
        if (!loopbackOnly(req, res)) return
        void (async () => {
          const body = await readJsonObject(req)
          if (body === undefined) {
            writeJson(res, 400, { ok: false, code: 'bad-payload' })
            return
          }
          const sessionId = body.sessionId
          const snapshot = deps.link()?.snapshot()
          if (snapshot?.online !== true || snapshot.inventory === undefined) {
            writeJson(res, 503, { ok: false, code: 'peer-offline' })
            return
          }
          if (typeof sessionId !== 'string' || sessionId === '' || !snapshot.inventory.sessions.some(row => row.id === sessionId)) {
            writeJson(res, 404, { ok: false, code: 'unknown-session' })
            return
          }
          const token = deps.tickets.issue()
          writeJson(res, 200, {
            ok: true,
            url: `http://127.0.0.1:${String(deps.proxyPort())}/?dsh-remote-embed=1&dsh-remote-session=${encodeURIComponent(sessionId)}&embedToken=${token}`,
          })
        })().catch(() => {
          if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'ticket-failed' })
        })
      },
    },
    {
      kind: 'exact',
      path: '/api/pair/peer/new-session',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
          return
        }
        if (!loopbackOnly(req, res)) return
        void (async () => {
          const body = await readJsonObject(req)
          if (body === undefined) {
            writeJson(res, 400, { ok: false, code: 'bad-payload' })
            return
          }
          const workspaceId = body.workspaceId
          if (workspaceId !== undefined && typeof workspaceId !== 'string') {
            writeJson(res, 400, { ok: false, code: 'bad-workspace' })
            return
          }
          const link = deps.link()
          const snapshot = link?.snapshot()
          if (link === undefined || snapshot?.online !== true) {
            writeJson(res, 503, { ok: false, code: 'peer-offline' })
            return
          }
          // The peer creates the session; only it can, and it validates the
          // workspace against its own registry. This half then mints the embed
          // ticket for the id it returned, so the pane opens like any other.
          const sessionId = await link.createSession(
            typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : undefined,
          )
          if (sessionId === undefined) {
            writeJson(res, 502, { ok: false, code: 'create-failed', detail: link.snapshot().lastError ?? '' })
            return
          }
          // Refresh so the new session is in the cached inventory before the
          // pane asks to open it (the open path checks membership).
          await link.refreshInventory()
          const token = deps.tickets.issue()
          writeJson(res, 200, {
            ok: true,
            sessionId,
            url: `http://127.0.0.1:${String(deps.proxyPort())}/?dsh-remote-embed=1&dsh-remote-session=${encodeURIComponent(sessionId)}&embedToken=${token}`,
          })
        })().catch(() => {
          if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'create-failed' })
        })
      },
    },
    {
      kind: 'exact',
      path: '/api/pair/peer/embed-log',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
          return
        }
        if (!loopbackOnly(req, res)) return
        writeJson(res, 200, { ok: true, traces: deps.requestLog?.() ?? [] })
      },
    },
    {
      kind: 'exact',
      path: '/api/pair/peer/open-external',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
          return
        }
        if (!loopbackOnly(req, res)) return
        void (async () => {
          const body = await readJsonObject(req)
          if (body === undefined || typeof body.url !== 'string') {
            writeJson(res, 400, { ok: false, code: 'bad-payload' })
            return
          }
          // Only the local embed proxy may be handed to the OS: the fallback
          // exists to escape the desktop window's compositing, not to become
          // an arbitrary URL launcher.
          let parsed: URL
          try {
            parsed = new URL(body.url)
          } catch {
            writeJson(res, 400, { ok: false, code: 'bad-url' })
            return
          }
          const host = parsed.hostname
          const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
          const port = parsed.port === '' ? '80' : parsed.port
          if (parsed.protocol !== 'http:' || !loopback || port !== String(deps.proxyPort()) || parsed.pathname !== '/') {
            writeJson(res, 403, { ok: false, code: 'url-not-embed-proxy' })
            return
          }
          if (deps.openExternal === undefined) {
            writeJson(res, 501, { ok: false, code: 'open-external-unavailable' })
            return
          }
          deps.openExternal(body.url)
          writeJson(res, 200, { ok: true })
        })().catch(() => {
          if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'open-external-failed' })
        })
      },
    },
  ]
}
