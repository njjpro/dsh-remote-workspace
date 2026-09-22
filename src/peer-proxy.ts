/**
 * The embed reverse proxy: a loopback-only HTTP server on its own port that
 * re-publishes the peer instance's GUI at a ROOT path (the official SPA is
 * root-anchored, so a subpath proxy would break every asset URL). Every
 * request rides the peer's device credential (cookie + device header), so
 * the browser side needs no remote cookies at all — the iframe is plain
 * loopback. Auth: the first navigation carries a one-shot embed ticket from
 * the loopback control plane; the proxy answers with a host cookie so later
 * navigations, assets, and WebSocket upgrades authenticate themselves.
 */
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'

/** Live embed tickets: short TTL, reusable within the window, minted by the loopback control plane. */
export class EmbedTickets {
  private readonly live = new Map<string, number>()

  issue(now: number = Date.now()): string {
    const token = randomBytes(24).toString('base64url')
    this.live.set(token, now + 5 * 60_000)
    if (this.live.size > 256) {
      const nowMs = now
      for (const [key, expiresAt] of this.live) {
        if (expiresAt < nowMs) this.live.delete(key)
      }
    }
    return token
  }

  /**
   * Consume one ticket: valid for its whole short TTL (repeat uses allowed).
   * The embed iframe may reload or re-request its document within the
   * window, and a single-use ticket dead-locks that reload into a 403 —
   * while adding no real security, since the proxy is loopback-only and any
   * local process could mint its own ticket through the control plane.
   */
  consume(token: string, now: number = Date.now()): boolean {
    const expiresAt = this.live.get(token)
    if (expiresAt === undefined) return false
    return expiresAt >= now
  }

  clear(): void {
    this.live.clear()
  }
}

/** The credential face the proxy needs per request. */
export interface PeerProxyTarget {
  baseUrl: string
  cookie: string
  deviceId: string
}

export interface PeerProxyDeps {
  port: number
  target: () => PeerProxyTarget | undefined
  tickets: EmbedTickets
  /** Embed cookie name (host-scoped to 127.0.0.1, shared across local ports). */
  cookieName?: string
  /** Diagnostic flight recorder: called for every probe beacon request
   *  (paths containing `__probe`) so client-side boot stages can be observed
   *  from disk even when the desktop renderer cannot open DevTools. */
  probeSink?: (line: string) => void
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'])

/** Query parameter carrying the device credential on rewritten WS upgrades. */
const PEER_EMBED_DEVICE_QUERY = 'device'

/**
 * Static GUI asset prefixes that skip the embed credential entirely. The
 * embedded shell lives in a cross-origin iframe: modern Chromium withholds
 * the third-party embed cookie there, so script/style/font requests would
 * all fence out and leave a blank pane. These paths only ever serve the
 * public GUI bundle (the same files the phone flow serves anonymously) —
 * every API, RPC, and WebSocket path still requires full credentials, and
 * the proxy itself binds to loopback only.
 */
const PUBLIC_ASSET_PREFIXES = ['/assets/', '/plugins/', '/locales/', '/fonts/']

function isPublicAsset(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const pathname = (req.url ?? '/').split('?')[0]
  return PUBLIC_ASSET_PREFIXES.some(prefix => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix))
}

/** How a request satisfied (or failed) the embed fence. */
export type AuthVerdict = 'cookie' | 'ticket' | 'device' | 'denied'

function embedVerdict(req: IncomingMessage, deps: PeerProxyDeps, target: PeerProxyTarget): AuthVerdict {
  const cookieName = deps.cookieName ?? 'dsh_peer_embed'
  const header = req.headers.cookie
  if (typeof header === 'string') {
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === cookieName && rest.join('=') !== '') return 'cookie'
    }
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // First navigation: the embed ticket rides the query string.
  const ticket = url.searchParams.get('embedToken')
  if (ticket !== null && deps.tickets.consume(ticket)) return 'ticket'
  // The boot wrapper rewrites WebSocket upgrades to the gated mirror with the
  // device credential in the query (browsers cannot attach extra headers to a
  // WS handshake, and the iframe is a cross-port context where the embed
  // cookie may be withheld). Accept the query credential when it matches the
  // live target device — it authenticates exactly the same channel.
  const device = url.searchParams.get(PEER_EMBED_DEVICE_QUERY)
  if (device !== null && device === target.deviceId) return 'device'
  return 'denied'
}

function forwardHeaders(req: IncomingMessage, target: PeerProxyTarget, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // The peer credential rides ALONGSIDE the browser's own cookies: the
  // remote fence reads its pairing cookie from this merged header.
  const existing = typeof req.headers.cookie === 'string' ? `${req.headers.cookie}; ` : ''
  headers.cookie = `${existing}${target.cookie}`
  headers['x-dsh-remote-device'] = target.deviceId
  headers.host = new URL(target.baseUrl).host
  return { ...headers, ...extra }
}

/** HTTP(S) request by URL protocol (http.request rejects https URLs). */
function upstreamRequest(url: URL, options: { method?: string; headers: Record<string, string> }, callback?: (res: IncomingMessage) => void): ClientRequest {
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
  return callback === undefined ? requestFn(url, options) : requestFn(url, options, callback)
}

/**
 * Map the bare root to the peer's cookieless shell route. The harness index
 * gate on the peer serves `/` only to a browser-auth cookie minted for the
 * browser's own origin — a proxied request can never hold one (it is
 * authority-bound). `/pair-app` serves the same shell behind the device
 * credential the proxy already attaches, so the bare root maps there; the
 * query string (the embed markers included) rides along untouched.
 */
function upstreamPathOf(incoming: string): string {
  if (incoming === '/' || incoming.startsWith('/?')) return `/pair-app${incoming.slice(1)}`
  return incoming
}

export interface PeerProxy {
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number
  /** The most recent request-level traces (fence verdicts included). */
  requestLog(): PeerRequestTrace[]
}

/** One observed proxy request: how it was judged, and what left the fence. */
export interface PeerRequestTrace {
  at: number
  method: string
  /** Request path without the query string (the query can carry a ticket). */
  path: string
  verdict: AuthVerdict | 'public-asset' | 'offline'
  /** Whether the request left for the peer (false = fenced or offline). */
  forwarded: boolean
}

/** Create (not start) the loopback embed proxy. */
export function createPeerProxy(deps: PeerProxyDeps): PeerProxy {
  const cookieName = deps.cookieName ?? 'dsh_peer_embed'
  // Request-level observation ring: the fence verdict of every proxied
  // request, surfaced through the loopback control plane for diagnosing
  // embedded-shell loading problems that only reproduce inside the user's
  // real shell (headless probes behave differently there).
  const log: PeerRequestTrace[] = []
  // Every client socket is tracked explicitly: upgraded sockets detach from
  // the HTTP server's connection table, so stop() must destroy them itself.
  const sockets = new Set<Duplex>()
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.socket !== undefined) track(req.socket)
    const trace = (verdict: PeerRequestTrace['verdict'], forwarded: boolean): void => {
      const path = (req.url ?? '/').split('?')[0]
      log.push({ at: Date.now(), method: req.method ?? 'GET', path, verdict, forwarded })
      if (log.length > 64) log.splice(0, log.length - 64)
      if (path.includes('__probe') && deps.probeSink !== undefined) {
        deps.probeSink(`${new Date().toISOString()} http ${verdict} forwarded=${forwarded} ${path}`)
      }
    }
    const target = deps.target()
    if (target === undefined) {
      trace('offline', false)
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('peer workspace source is offline')
      return
    }
    const verdict = embedVerdict(req, deps, target)
    const authed = verdict !== 'denied' || isPublicAsset(req)
    if (!authed) {
      trace(verdict, false)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('forbidden')
      return
    }
    trace(verdict !== 'denied' ? verdict : 'public-asset', true)
    const url = new URL(upstreamPathOf(req.url ?? '/'), target.baseUrl)
    const upstream = upstreamRequest(
      url,
      {
        method: req.method,
        headers: forwardHeaders(req, target),
      },
      (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers }
        // Sessionize the embed: the ticket converts into a host cookie so
        // every later request (assets, WS upgrades) authenticates itself.
        responseHeaders['set-cookie'] = [
          `${cookieName}=${randomBytes(16).toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        ]
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      res.end(`peer upstream error: ${error.code ?? error.message}`)
    })
    req.pipe(upstream)
  })
  // WebSocket upgrades tunnel byte-for-byte: the GUI's /api RPC channel is a
  // WS connection whose handshake must reach the peer verbatim.
  server.on('upgrade', (req: IncomingMessage, clientSocket, head) => {
    track(clientSocket)
    const target = deps.target()
    if (target !== undefined) {
      const verdict = embedVerdict(req, deps, target)
      log.push({
        at: Date.now(),
        method: 'WS',
        path: (req.url ?? '/').split('?')[0],
        verdict,
        forwarded: verdict !== 'denied',
      })
      if (log.length > 64) log.splice(0, log.length - 64)
      if (verdict !== 'denied') {
        tunnelUpgrade(req, clientSocket, head, target, deps, cookieName)
        return
      }
    } else {
      log.push({
        at: Date.now(), method: 'WS', path: (req.url ?? '/').split('?')[0], verdict: 'offline', forwarded: false,
      })
      if (log.length > 64) log.splice(0, log.length - 64)
    }
    // Reject the handshake with a real HTTP response: a bare destroy leaves
    // the browser WS stuck in CONNECTING with no error to reconnect against.
    clientSocket.write(
      'HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\n\r\nforbidden\n',
    )
    clientSocket.destroy()
  })

  function tunnelUpgrade(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    target: PeerProxyTarget,
    deps: PeerProxyDeps,
    cookieName: string,
  ): void {
    const url = new URL(req.url ?? '/', target.baseUrl)
    const upstreamRequestMessage = upstreamRequest(url, {
      headers: forwardHeaders(req, target, { connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' }),
    })
    upstreamRequestMessage.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${String(upstreamRes.statusCode ?? 101)} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue
        for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
      }
      const setCookie = upstreamRes.headers['set-cookie']
      const extra = setCookie !== undefined && setCookie.length > 0 ? '' : `set-cookie: ${cookieName}=${randomBytes(16).toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400\r\n`
      clientSocket.write(`${lines.join('\r\n')}\r\n${extra}\r\n`)
      if (upstreamHead.length > 0) clientSocket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
      const teardown = (): void => {
        upstreamSocket.destroy()
        clientSocket.destroy()
      }
      upstreamSocket.on('error', teardown)
      clientSocket.on('error', teardown)
      upstreamSocket.on('close', teardown)
      clientSocket.on('close', teardown)
    })
    upstreamRequestMessage.on('response', (response) => {
      // The peer refused the upgrade: surface the rejection plainly.
      const body = `peer refused upgrade: ${String(response.statusCode)}`
      clientSocket.write(`HTTP/1.1 ${String(response.statusCode ?? 502)}\r\nconnection: close\r\ncontent-length: ${String(body.length)}\r\n\r\n${body}`)
      clientSocket.destroy()
    })
    upstreamRequestMessage.on('error', () => {
      clientSocket.destroy()
    })
    upstreamRequestMessage.end()
  }
  return {
    get port(): number {
      return (server.address() as { port: number } | null)?.port ?? deps.port
    },
    requestLog: () => [...log],
    start: () => new Promise<void>((resolve, reject) => {
      const onError = (cause: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        reject(cause)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(deps.port, '127.0.0.1')
    }),
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
      for (const socket of sockets) socket.destroy()
    }),
  }
}
