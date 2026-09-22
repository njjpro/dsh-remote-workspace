/**
 * Peer inventory: the device-facing endpoints a paired remote instance
 * reads. The fence is the device credential (unpaired requests get 401),
 * the inventory document mirrors the host feed + workspace registry with
 * titles from the projection cache, and the loopback control plane mints
 * one-shot embed tickets only for sessions the inventory actually lists.
 *
 * The pairing check is the OFFICIAL plugin's cordis service in production, so the
 * tests supply a local double with the same structural shape
 * (`PeerPairingFace`): that keeps this package free of any dependency on the
 * pairing implementation while still exercising the fence at its real boundary.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { makePeerRemoteRoutes, makePeerControlRoutes, type PeerFeedFace, type PeerPairingFace, type PeerRegistryFace } from '../src/peer-remote.ts'
import { EmbedTickets } from '../src/peer-proxy.ts'

/** The cookie name the official pairing service uses; only the shape matters here. */
const COOKIE_NAME = 'dsh_pair'

/** A live paired-device credential, as the host's pairing service would report it. */
interface PairingDouble extends PeerPairingFace {
  /** The credential a paired caller sends. */
  readonly cookie: string
  /** Revoke it, so the next request is refused. */
  revoke(): void
  /** How many times the fence consulted this double. */
  readonly calls: number
}

/**
 * Build a pairing double accepting exactly one credential.
 * @param deviceId - the device identity the paired cookie carries.
 * @returns the double, with its cookie and a revoke switch.
 */
function makePairing(deviceId = 'dev-1'): PairingDouble {
  let live = true
  let calls = 0
  return {
    cookie: `${COOKIE_NAME}=${deviceId}`,
    get calls() { return calls },
    revoke() { live = false },
    isPairedDevice(request: IncomingMessage): boolean {
      calls += 1
      if (!live) return false
      return (request.headers.cookie ?? '').includes(`${COOKIE_NAME}=${deviceId}`)
    },
  }
}

/** A pairing face that never admits anyone (the plugin-less host). */
const NO_PAIRING: PeerPairingFace = {
  isPairedDevice: () => false,
}


const FAKE_FEED: PeerFeedFace = {
  list: async () => ({
    items: [
      { sessionId: 'sess-live', updatedAt: 500, running: true, blank: false, origin: 'main', cwd: 'C:\\proj' },
      { sessionId: 'sess-old', updatedAt: 100, running: false, blank: true, origin: 'main' },
      { sessionId: 'sess-agent', updatedAt: 300, running: false, blank: false, origin: 'subagent' },
    ],
  }),
}

const FAKE_REGISTRY: PeerRegistryFace = {
  list: () => [
    { id: 'ws-1', title: 'Project One', path: 'C:\\proj', sessionIds: ['sess-live'] },
  ],
}

interface TestServer {
  port: number
  close: () => Promise<void>
}

/** Serve the route family from a real loopback server. */
async function serve(routes: WebRoute[]): Promise<TestServer> {
  const server: Server = createServer((request, response) => {
    const route = routes.find(r => {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname
      return r.kind === 'exact' && r.path === pathname
    })
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    void route.handler(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
  }
}

/** One JSON call against the loopback test server. */
async function call(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
    },
    body: payload,
  })
  const raw = await response.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(raw) as Record<string, unknown> } catch { /* empty body */ }
  return { status: response.status, body: parsed }
}

describe('peer remote routes', () => {
  let home: string
  let server: TestServer | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'peer-remote-'))
    // Titles + cwd for one session come from the projection cache.
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
      tables: { sessions: { 'sess-live': { rows: { title: { val: 'Live session' } }, identity: { cwd: 'C:\\proj' } } } },
    }))
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    rmSync(home, { recursive: true, force: true })
  })

  it('rejects unpaired requests with 401 before touching the faces', async () => {
    const service = makePairing()
    server = await serve(makePeerRemoteRoutes({ pairing: () => service, dshHome: home, getFeed: () => FAKE_FEED, getRegistry: () => FAKE_REGISTRY }))
    expect((await call(server.port, 'GET', '/pair-remote/ping')).status).toBe(401)
    expect((await call(server.port, 'GET', '/pair-remote/inventory')).status).toBe(401)
  })

  it('serves the inventory document to a paired device', async () => {
    const service = makePairing()
    const cookie = service.cookie
    server = await serve(makePeerRemoteRoutes({ pairing: () => service, dshHome: home, getFeed: () => FAKE_FEED, getRegistry: () => FAKE_REGISTRY }))
    const ping = await call(server.port, 'GET', '/pair-remote/ping', { cookie })
    expect(ping.status).toBe(200)
    expect(ping.body).toMatchObject({ ok: true, known: true })
    const inventory = await call(server.port, 'GET', '/pair-remote/inventory', { cookie })
    expect(inventory.status).toBe(200)
    expect(inventory.body.ok).toBe(true)
    const sessions = inventory.body.sessions as { id: string; title?: string; cwd?: string; running: boolean; blank: boolean; subagent: boolean }[]
    expect(sessions.map(row => row.id)).toEqual(['sess-live', 'sess-agent', 'sess-old'])
    expect(sessions[0]).toMatchObject({ title: 'Live session', cwd: 'C:\\proj', running: true, blank: false, subagent: false })
    expect(sessions[2].blank).toBe(true)
    expect((sessions[2] as { title?: string }).title).toBeUndefined()
    expect(sessions[1].subagent).toBe(true)
    const workspaces = inventory.body.workspaces as { id: string; title: string; sessionIds: string[] }[]
    expect(workspaces).toEqual([{ id: 'ws-1', title: 'Project One', path: 'C:\\proj', sessionIds: ['sess-live'] }])
    expect(typeof inventory.body.generatedAt).toBe('number')
  })

  it('reports feed-unavailable (503) when the session feed is cold', async () => {
    const service = makePairing()
    const cookie = service.cookie
    server = await serve(makePeerRemoteRoutes({ pairing: () => service, dshHome: home, getFeed: () => undefined, getRegistry: () => FAKE_REGISTRY }))
    const inventory = await call(server.port, 'GET', '/pair-remote/inventory', { cookie })
    expect(inventory.status).toBe(503)
    expect(inventory.body.code).toBe('feed-unavailable')
  })

  it('resolves the feed lazily: a late-registered face starts answering', async () => {
    const service = makePairing()
    const cookie = service.cookie
    let feed: PeerFeedFace | undefined
    server = await serve(makePeerRemoteRoutes({ pairing: () => service, dshHome: home, getFeed: () => feed, getRegistry: () => FAKE_REGISTRY }))
    const cold = await call(server.port, 'GET', '/pair-remote/inventory', { cookie })
    expect(cold.status).toBe(503)
    feed = FAKE_FEED
    const warm = await call(server.port, 'GET', '/pair-remote/inventory', { cookie })
    expect(warm.status).toBe(200)
    expect((warm.body.sessions as unknown[]).length).toBe(3)
  })

  /**
   * Archived sessions must not reach a remote browser.
   *
   * The regression these pin: archiving a session did not stop it appearing in
   * the peer inventory, so the remote sidebar listed it. A remote shell filters
   * archived sessions out while resolving a workspace, so that row could not be
   * opened - it showed the shell's "select a workspace" screen instead of its
   * history, which reads as "some sessions are blank".
   *
   * Measured on the peer before the fix: all five archived sessions appeared in
   * the remote list, three of them still inside a workspace's sessionIds.
   */
  describe('archived sessions stay out of the peer inventory', () => {
    /** A feed carrying one live and one archived session. */
    const FEED: PeerFeedFace = {
      list: async () => ({
        items: [
          { sessionId: 'session-keep', updatedAt: 500, running: false, blank: false, origin: 'main' },
          { sessionId: 'session-gone', updatedAt: 400, running: false, blank: false, origin: 'main' },
        ],
      }),
    }

    /** A registry that still lists the archived id inside a workspace. */
    const REGISTRY: PeerRegistryFace = {
      list: () => [
        { id: 'ws-1', title: 'Project', path: 'C:\\p', sessionIds: ['session-keep', 'session-gone'] },
      ],
      // The archive plugin reads and writes the set through this durable seam,
      // so this is the shape the inventory must read.
      requireState: () => ({ archivedSessionIds: ['session-gone'] }),
    }

    /** Run one inventory and return the parsed document. */
    async function inventoryOf(registry: PeerRegistryFace): Promise<{ sessions: { id: string }[]; workspaces: { sessionIds: string[] }[] }> {
      const service = makePairing()
      const cookie = service.cookie
      server = await serve(makePeerRemoteRoutes({ pairing: () => service, dshHome: home, getFeed: () => FEED, getRegistry: () => registry }))
      const result = await call(server.port, 'GET', '/pair-remote/inventory', { cookie })
      expect(result.status).toBe(200)
      return result.body as unknown as { sessions: { id: string }[]; workspaces: { sessionIds: string[] }[] }
    }

    it('drops an archived session from the session list', async () => {
      const doc = await inventoryOf(REGISTRY)
      expect(doc.sessions.map(row => row.id)).toEqual(['session-keep'])
    })

    it('drops an archived session from a workspace membership list', async () => {
      // The workspace path matters even with the session list filtered: the
      // remote sidebar groups by workspace.sessionIds, so a stale id there
      // would still render a row that cannot be opened.
      const doc = await inventoryOf(REGISTRY)
      expect(doc.workspaces).toEqual([{ id: 'ws-1', title: 'Project', path: 'C:\\p', sessionIds: ['session-keep'] }])
    })

    it('matches the archive set whether or not it carries the session- prefix', async () => {
      // The archive set and the feed disagree on the prefix in practice, so a
      // bare id must filter the prefixed row too.
      const bare: PeerRegistryFace = {
        list: () => [{ id: 'ws-1', title: 'Project', path: 'C:\\p', sessionIds: ['session-keep', 'session-gone'] }],
        requireState: () => ({ archivedSessionIds: ['gone'] }),
      }
      const doc = await inventoryOf(bare)
      expect(doc.sessions.map(row => row.id)).toEqual(['session-keep'])
      expect(doc.workspaces[0].sessionIds).toEqual(['session-keep'])
    })

    it('accepts a direct archive-set property as a fallback', async () => {
      const direct: PeerRegistryFace = {
        list: () => [{ id: 'ws-1', title: 'Project', path: 'C:\\p', sessionIds: ['session-keep', 'session-gone'] }],
        archivedSessionIds: ['session-gone'],
      }
      const doc = await inventoryOf(direct)
      expect(doc.sessions.map(row => row.id)).toEqual(['session-keep'])
    })

    it('lists everything when the registry exposes no archive set', async () => {
      // The archive plugin is optional; without it nothing may be hidden.
      const noArchive: PeerRegistryFace = {
        list: () => [{ id: 'ws-1', title: 'Project', path: 'C:\\p', sessionIds: ['session-keep', 'session-gone'] }],
      }
      const doc = await inventoryOf(noArchive)
      expect(doc.sessions.map(row => row.id).sort()).toEqual(['session-gone', 'session-keep'])
      expect(doc.workspaces[0].sessionIds).toEqual(['session-keep', 'session-gone'])
    })

    it('keeps serving the inventory when the durable seam throws', async () => {
      // A missing or exploding seam must not take the inventory down.
      const broken: PeerRegistryFace = {
        list: () => [{ id: 'ws-1', title: 'Project', path: 'C:\\p', sessionIds: ['session-keep', 'session-gone'] }],
        requireState: () => { throw new Error('state unavailable') },
      }
      const doc = await inventoryOf(broken)
      expect(doc.sessions.map(row => row.id).sort()).toEqual(['session-gone', 'session-keep'])
    })
  })

  /**
   * Starting a conversation from a paired browser.
   *
   * The gap this closes: the remote sidebar could only open sessions that
   * already existed. The peer's own new-session control lives in the sidebar
   * column the embed CSS hides, and the embed URL only ever names an existing
   * session, so a paired browser had no way to begin one.
   */
  describe('peer-side session creation', () => {
    /** A feed that records the create requests it receives. */
    function feedWithCreate(created: { workspaceId?: string }[], result: string | (() => Promise<string>) ): PeerFeedFace {
      return {
        list: async () => ({ items: [] }),
        create: async (request) => {
          created.push(request)
          const id = typeof result === 'function' ? await result() : result
          return { sessionId: id }
        },
      }
    }

    /** Serve the routes with a given feed + registry and return the server. */
    async function serveWith(feed: PeerFeedFace, registry: PeerRegistryFace | undefined): Promise<{ port: number; cookie: string }> {
      const service = makePairing()
      const cookie = service.cookie
      server = await serve(makePeerRemoteRoutes({ pairing: () => service, dshHome: home, getFeed: () => feed, getRegistry: () => registry }))
      return { port: server.port, cookie }
    }

    it('creates a session in the named workspace and returns its id', async () => {
      const created: { workspaceId?: string }[] = []
      const { port, cookie } = await serveWith(feedWithCreate(created, 'session-new'), FAKE_REGISTRY)
      const result = await call(port, 'POST', '/pair-remote/session', { cookie, body: { workspaceId: 'ws-1' } })
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({ ok: true, sessionId: 'session-new' })
      expect(created).toEqual([{ workspaceId: 'ws-1' }])
    })

    it('refuses a workspace this instance does not have', async () => {
      // Creation must not become a way to name an arbitrary workspace.
      const created: { workspaceId?: string }[] = []
      const { port, cookie } = await serveWith(feedWithCreate(created, 'session-new'), FAKE_REGISTRY)
      const result = await call(port, 'POST', '/pair-remote/session', { cookie, body: { workspaceId: 'ws-does-not-exist' } })
      expect(result.status).toBe(404)
      expect(result.body.code).toBe('unknown-workspace')
      expect(created).toEqual([])
    })

    it('starts with no workspace when none is named, letting the host default', async () => {
      const created: { workspaceId?: string }[] = []
      const { port, cookie } = await serveWith(feedWithCreate(created, 'session-any'), FAKE_REGISTRY)
      const result = await call(port, 'POST', '/pair-remote/session', { cookie, body: {} })
      expect(result.status).toBe(200)
      expect(created).toEqual([{}])
    })

    it('reports create-unavailable when the host exposes no create verb', async () => {
      // An older host simply cannot do this; say so instead of failing opaquely.
      const feed: PeerFeedFace = { list: async () => ({ items: [] }) }
      const { port, cookie } = await serveWith(feed, FAKE_REGISTRY)
      const result = await call(port, 'POST', '/pair-remote/session', { cookie, body: { workspaceId: 'ws-1' } })
      expect(result.status).toBe(501)
      expect(result.body.code).toBe('create-unavailable')
    })

    it('reports a failure when the create verb throws', async () => {
      const feed: PeerFeedFace = {
        list: async () => ({ items: [] }),
        create: async () => { throw new Error('host refused') },
      }
      const { port, cookie } = await serveWith(feed, FAKE_REGISTRY)
      const result = await call(port, 'POST', '/pair-remote/session', { cookie, body: { workspaceId: 'ws-1' } })
      expect(result.status).toBe(502)
      expect(result.body.code).toBe('create-failed')
    })

    it('requires a paired device', async () => {
      const created: { workspaceId?: string }[] = []
      const { port } = await serveWith(feedWithCreate(created, 'session-new'), FAKE_REGISTRY)
      const result = await call(port, 'POST', '/pair-remote/session', { body: { workspaceId: 'ws-1' } })
      expect(result.status).toBe(401)
      expect(created).toEqual([])
    })

    it('rejects a non-string workspace id', async () => {
      const created: { workspaceId?: string }[] = []
      const { port, cookie } = await serveWith(feedWithCreate(created, 'session-new'), FAKE_REGISTRY)
      const result = await call(port, 'POST', '/pair-remote/session', { cookie, body: { workspaceId: 42 } })
      expect(result.status).toBe(400)
      expect(created).toEqual([])
    })

    it('rejects GET', async () => {
      const { port, cookie } = await serveWith(feedWithCreate([], 'x'), FAKE_REGISTRY)
      const result = await call(port, 'GET', '/pair-remote/session', { cookie })
      expect(result.status).toBe(405)
    })
  })
})

describe('peer control routes (loopback)', () => {

  /**
   * The local new-conversation route.
   *
   * It is the one control action that cannot ride the existing-session path: the
   * peer creates the session, and this half then mints an embed ticket for the id
   * it returned.
   */
  describe('new conversation', () => {
    /** A link stub that records createSession calls. */
    function linkStub(options: { online?: boolean; sessionId?: string; fail?: boolean } = {}) {
      const calls: Array<string | undefined> = []
      const state = { online: options.online !== false, refreshCount: 0 }
      const link = {
        calls,
        state,
        snapshot: () => ({
          configured: true,
          online: state.online,
          baseUrl: 'https://peer.example',
          inventory: { generatedAt: 1, sessions: [], workspaces: [] },
          ...(options.fail === true ? { lastError: 'create 502 (create-failed)' } : {}),
        }),
        createSession: async (workspaceId?: string) => {
          calls.push(workspaceId)
          return options.sessionId
        },
        refreshInventory: async () => { state.refreshCount += 1 },
      }
      return link
    }

    it('creates on the peer, refreshes, and returns an embed url for the new id', async () => {
      const tickets = new EmbedTickets()
      const link = linkStub({ sessionId: 'session-created' })
      const proxyPort = 43210
      const server = await serve(makePeerControlRoutes({
        link: () => link as never,
        tickets,
        proxyPort: () => proxyPort,
      }))
      try {
        const result = await call(server.port, 'POST', '/api/pair/peer/new-session', { body: { workspaceId: 'ws-1' } })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ ok: true, sessionId: 'session-created' })
        expect(link.calls).toEqual(['ws-1'])
        // The pane's open path checks membership, so the new session has to be in
        // the cached inventory before the url is handed back.
        expect(link.state.refreshCount).toBe(1)
        const url = String(result.body.url)
        expect(url).toContain(`http://127.0.0.1:${String(proxyPort)}/`)
        expect(url).toContain('dsh-remote-session=session-created')
        const token = new URL(url).searchParams.get('embedToken') ?? ''
        expect(tickets.consume(token)).toBe(true)
      } finally {
        await server.close()
      }
    })

    it('starts with no workspace when the request omits one', async () => {
      const link = linkStub({ sessionId: 'session-any' })
      const server = await serve(makePeerControlRoutes({
        link: () => link as never,
        tickets: new EmbedTickets(),
        proxyPort: () => 43210,
      }))
      try {
        const result = await call(server.port, 'POST', '/api/pair/peer/new-session', { body: {} })
        expect(result.status).toBe(200)
        expect(link.calls).toEqual([undefined])
      } finally {
        await server.close()
      }
    })

    it('reports peer-offline without creating anything', async () => {
      const link = linkStub({ online: false, sessionId: 'session-x' })
      const server = await serve(makePeerControlRoutes({
        link: () => link as never,
        tickets: new EmbedTickets(),
        proxyPort: () => 43210,
      }))
      try {
        const result = await call(server.port, 'POST', '/api/pair/peer/new-session', { body: { workspaceId: 'ws-1' } })
        expect(result.status).toBe(503)
        expect(result.body.code).toBe('peer-offline')
        expect(link.calls).toEqual([])
      } finally {
        await server.close()
      }
    })

    it('surfaces a create failure without a url', async () => {
      const link = linkStub({ sessionId: undefined, fail: true })
      const server = await serve(makePeerControlRoutes({
        link: () => link as never,
        tickets: new EmbedTickets(),
        proxyPort: () => 43210,
      }))
      try {
        const result = await call(server.port, 'POST', '/api/pair/peer/new-session', { body: { workspaceId: 'ws-1' } })
        expect(result.status).toBe(502)
        expect(result.body.code).toBe('create-failed')
        expect(result.body.url).toBeUndefined()
      } finally {
        await server.close()
      }
    })

    it('rejects a non-string workspace and a GET', async () => {
      const link = linkStub({ sessionId: 'session-x' })
      const server = await serve(makePeerControlRoutes({
        link: () => link as never,
        tickets: new EmbedTickets(),
        proxyPort: () => 43210,
      }))
      try {
        const bad = await call(server.port, 'POST', '/api/pair/peer/new-session', { body: { workspaceId: 7 } })
        expect(bad.status).toBe(400)
        const wrongMethod = await call(server.port, 'GET', '/api/pair/peer/new-session')
        expect(wrongMethod.status).toBe(405)
        expect(link.calls).toEqual([])
      } finally {
        await server.close()
      }
    })
  })

  it('mints a one-shot embed ticket for a listed session only', async () => {
    const tickets = new EmbedTickets()
    const link = {
      snapshot: () => ({
        configured: true,
        online: true,
        baseUrl: 'https://peer.example',
        inventory: { generatedAt: 1, sessions: [{ id: 'sess-live', running: false, blank: false, subagent: false }], workspaces: [] },
      }),
    }
    const proxyPort = 43210
    const server = await serve(makePeerControlRoutes({
      link: () => link as never,
      tickets,
      proxyPort: () => proxyPort,
    }))
    try {
      const missing = await call(server.port, 'POST', '/api/pair/peer/embed-ticket', { body: { sessionId: 'nope' } })
      expect(missing.status).toBe(404)
      const ticket = await call(server.port, 'POST', '/api/pair/peer/embed-ticket', { body: { sessionId: 'sess-live' } })
      expect(ticket.status).toBe(200)
      expect(ticket.body.ok).toBe(true)
      const url = String(ticket.body.url)
      expect(url).toContain(`http://127.0.0.1:${String(proxyPort)}/`)
      expect(url).toContain('dsh-remote-embed=1')
      expect(url).toContain('dsh-remote-session=sess-live')
      const token = new URL(url).searchParams.get('embedToken') ?? ''
      // The ticket stays valid for its whole TTL: the embed iframe reloads
      // its document, and a single-use ticket would dead-lock that reload.
      expect(tickets.consume(token)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('refuses embed tickets while the peer link is offline', async () => {
    const tickets = new EmbedTickets()
    const server = await serve(makePeerControlRoutes({
      link: () => undefined,
      tickets,
      proxyPort: () => 43210,
    }))
    try {
      const refused = await call(server.port, 'POST', '/api/pair/peer/embed-ticket', { body: { sessionId: 'sess-live' } })
      expect(refused.status).toBe(503)
      expect(refused.body.code).toBe('peer-offline')
    } finally {
      await server.close()
    }
  })

  it('serves the embed proxy request ring through the diagnostics endpoint', async () => {
    const tickets = new EmbedTickets()
    const traces = [{ at: 7, method: 'GET', path: '/pair-app', verdict: 'ticket' as const, forwarded: true }]
    const server = await serve(makePeerControlRoutes({
      link: () => undefined,
      tickets,
      proxyPort: () => 43210,
      requestLog: () => traces,
    }))
    try {
      const missing = await call(server.port, 'GET', '/api/pair/peer/embed-log')
      expect(missing.status).toBe(200)
      expect(missing.body.traces).toEqual(traces)
      const none = await serve(makePeerControlRoutes({ link: () => undefined, tickets, proxyPort: () => 43210 }))
      try {
        const fallback = await call(none.port, 'GET', '/api/pair/peer/embed-log')
        expect(fallback.status).toBe(200)
        expect(fallback.body.traces).toEqual([])
      } finally {
        await none.close()
      }
    } finally {
      await server.close()
    }
  })

  it('hands only the local embed proxy URL to the external opener', async () => {
    const tickets = new EmbedTickets()
    const opened: string[] = []
    const server = await serve(makePeerControlRoutes({
      link: () => undefined,
      tickets,
      proxyPort: () => 43210,
      openExternal: (url) => { opened.push(url) },
    }))
    try {
      const good = await call(server.port, 'POST', '/api/pair/peer/open-external', {
        body: { url: `http://127.0.0.1:43210/?dsh-remote-embed=1&embedToken=t` },
      })
      expect(good.status).toBe(200)
      expect(opened).toEqual([`http://127.0.0.1:43210/?dsh-remote-embed=1&embedToken=t`])

      const wrongPort = await call(server.port, 'POST', '/api/pair/peer/open-external', {
        body: { url: 'http://127.0.0.1:9999/?dsh-remote-embed=1' },
      })
      expect(wrongPort.status).toBe(403)

      const external = await call(server.port, 'POST', '/api/pair/peer/open-external', {
        body: { url: 'https://peer.example/pair-app' },
      })
      expect(external.status).toBe(403)

      const garbage = await call(server.port, 'POST', '/api/pair/peer/open-external', {
        body: { url: 'not a url' },
      })
      expect(garbage.status).toBe(400)
      expect(opened).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})

describe('EmbedTickets', () => {
  it('expires tickets by TTL', () => {
    const tickets = new EmbedTickets()
    const now = 1_000_000
    const token = tickets.issue(now)
    expect(tickets.consume(token, now + 5 * 60_000)).toBe(true)
    const token2 = tickets.issue(now)
    expect(tickets.consume(token2, now + 5 * 60_000 + 1)).toBe(false)
  })
})
