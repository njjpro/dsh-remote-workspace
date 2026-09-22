/**
 * The embed reverse proxy: a loopback HTTP server that re-publishes the peer
 * GUI. Requests ride the peer credential (merged cookie + device header),
 * the one-shot embed ticket sessionizes into a host cookie, unauthenticated
 * requests are fenced, and WebSocket upgrades tunnel byte-for-byte.
 */
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createPeerProxy, EmbedTickets, type PeerProxy } from '../src/peer-proxy.ts'

/** Echo server: reports the credential headers it saw, upgrades /ws. */
async function serveUpstream(): Promise<{ server: Server; port: number }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/who' || url.pathname === '/pair-app') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        path: url.pathname,
        search: url.search,
        cookie: request.headers.cookie ?? '',
        device: request.headers['x-dsh-remote-device'] ?? '',
      }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname !== '/api/ws') {
      socket.destroy()
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.write('upstream-hello')
    socket.on('data', (chunk) => { socket.write(`echo:${String(chunk)}`) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port }
}

describe('peer embed proxy', () => {
  let upstream: { server: Server; port: number } | undefined
  let proxy: PeerProxy | undefined
  const tickets = new EmbedTickets()
  const closers: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    await proxy?.stop()
    proxy = undefined
    await upstream?.server.close()
    upstream = undefined
    tickets.clear()
  })

  it('forwards requests with the peer credential and sessionizes the ticket', async () => {
    upstream = await serveUpstream()
    proxy = createPeerProxy({
      port: 0,
      target: () => ({ baseUrl: `http://127.0.0.1:${String(upstream?.port ?? 0)}`, cookie: 'dsh_pair=dev-9', deviceId: 'dev-9' }),
      tickets,
    })
    await proxy.start()
    const base = `http://127.0.0.1:${String(proxy.port)}`
    // Without any credential: fenced.
    const denied = await fetch(`${base}/who`)
    expect(denied.status).toBe(403)
    // First navigation: the one-shot ticket converts into a host cookie.
    const ticket = tickets.issue()
    const first = await fetch(`${base}/who?embedToken=${encodeURIComponent(ticket)}`)
    expect(first.status).toBe(200)
    const seen = await first.json() as { cookie: string; device: string }
    expect(seen.cookie).toContain('dsh_pair=dev-9')
    expect(seen.device).toBe('dev-9')
    const setCookie = first.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('dsh_peer_embed=')
    // The ticket stays valid for its whole TTL: the embed iframe reloads its
    // document, and a single-use ticket would dead-lock that reload.
    expect(tickets.consume(ticket)).toBe(true)
    // Later navigations ride the host cookie alone.
    const cookieValue = /dsh_peer_embed=[^;]+/.exec(setCookie)?.[0] ?? ''
    const second = await fetch(`${base}/who`, { headers: { cookie: cookieValue } })
    expect(second.status).toBe(200)
    // The browser's own cookies pass through alongside the peer credential.
    const merged = await fetch(`${base}/who`, { headers: { cookie: `${cookieValue}; harness=something` } })
    const mergedSeen = await merged.json() as { cookie: string }
    expect(mergedSeen.cookie).toContain('harness=something')
    expect(mergedSeen.cookie).toContain('dsh_pair=dev-9')
  })

  it('maps the bare root to the peer cookieless shell with the query intact', async () => {
    upstream = await serveUpstream()
    proxy = createPeerProxy({
      port: 0,
      target: () => ({ baseUrl: `http://127.0.0.1:${String(upstream?.port ?? 0)}`, cookie: 'dsh_pair=dev-9', deviceId: 'dev-9' }),
      tickets,
    })
    await proxy.start()
    const base = `http://127.0.0.1:${String(proxy.port)}`
    const ticket = tickets.issue()
    const response = await fetch(`${base}/?dsh-remote-embed=1&dsh-remote-session=sess-a&embedToken=${encodeURIComponent(ticket)}`)
    expect(response.status).toBe(200)
    const seen = await response.json() as { path: string; search: string; device: string }
    expect(seen.path).toBe('/pair-app')
    expect(seen.search).toContain('dsh-remote-embed=1')
    expect(seen.search).toContain('dsh-remote-session=sess-a')
    expect(seen.device).toBe('dev-9')
    // Non-root paths are forwarded verbatim (the echo server has no such route).
    const asset = await fetch(`${base}/assets/app.js`, { headers: { cookie: 'dsh_peer_embed=sessioned' } })
    expect(asset.status).toBe(404)
  })

  it('tunnels WebSocket upgrades through to the peer', async () => {
    upstream = await serveUpstream()
    proxy = createPeerProxy({
      port: 0,
      target: () => ({ baseUrl: `http://127.0.0.1:${String(upstream?.port ?? 0)}`, cookie: 'dsh_pair=dev-9', deviceId: 'dev-9' }),
      tickets,
    })
    await proxy.start()
    await new Promise<void>((resolve, reject) => {
      const cookie = 'dsh_peer_embed=sessioned'
      const socket = connect(proxy!.port, '127.0.0.1', () => {
        socket.write(`GET /api/ws HTTP/1.1\r\nhost: 127.0.0.1:${String(proxy!.port)}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\ncookie: ${cookie}\r\n\r\n`)
      })
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        if (buffer.includes('101 Switching Protocols') && buffer.includes('upstream-hello')) {
          socket.write('client-ping')
        }
        if (buffer.includes('echo:client-ping')) {
          socket.destroy()
          resolve()
        }
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error(`upgrade tunnel timed out: ${buffer.slice(0, 200)}`)), 4000)
    })
  })

  it('serves public GUI assets without credentials but still fences API paths', async () => {
    upstream = await serveUpstream()
    proxy = createPeerProxy({
      port: 0,
      target: () => ({ baseUrl: `http://127.0.0.1:${String(upstream?.port ?? 0)}`, cookie: 'dsh_pair=dev-9', deviceId: 'dev-9' }),
      tickets,
    })
    await proxy.start()
    const base = `http://127.0.0.1:${String(proxy.port)}`
    // The cross-origin embed iframe cannot send the third-party embed
    // cookie, so the public GUI bundle must load without credentials.
    const asset = await fetch(`${base}/assets/index-abc.js`)
    expect(asset.status).toBe(404) // reaches the peer (its router answers), not the fence
    const plugin = await fetch(`${base}/plugins/??x/client.js`)
    expect(plugin.status).toBe(404)
    // Data surfaces stay fenced.
    const api = await fetch(`${base}/api/session.list`)
    expect(api.status).toBe(403)
    const wsApi = await fetch(`${base}/remote/api/session.list`)
    expect(wsApi.status).toBe(403)
    // The request ring records exactly how each request was judged: this is
    // the observation seam for embed-blank reports that only reproduce
    // inside the user's real shell.
    const log = proxy.requestLog()
    expect(log.some(row => row.path === '/assets/index-abc.js' && row.verdict === 'public-asset' && row.forwarded)).toBe(true)
    expect(log.some(row => row.path === '/api/session.list' && row.verdict === 'denied' && !row.forwarded)).toBe(true)
  })
  it('accepts the rewritten WS query credential and rejects others with a real 403', async () => {
    upstream = await serveUpstream()
    proxy = createPeerProxy({
      port: 0,
      target: () => ({ baseUrl: `http://127.0.0.1:${String(upstream?.port ?? 0)}`, cookie: 'dsh_pair=dev-9', deviceId: 'dev-9' }),
      tickets,
    })
    await proxy.start()
    // The boot wrapper rewrites WS upgrades to the gated mirror with the
    // device credential in the query — no embed cookie needed.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(proxy!.port, '127.0.0.1', () => {
        socket.write(`GET /api/ws?device=dev-9 HTTP/1.1\r\nhost: h\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n`)
      })
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        if (buffer.includes('101 Switching Protocols') && buffer.includes('upstream-hello')) {
          socket.destroy()
          resolve()
        }
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error(`query-credential upgrade timed out: ${buffer.slice(0, 200)}`)), 4000)
    })
    // A wrong query credential gets a plain HTTP 403, not a silent hang-up:
    // the browser must see a handshake failure it can reconnect against.
    const rejected = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy!.port, '127.0.0.1', () => {
        socket.write(`GET /api/ws?device=other HTTP/1.1\r\nhost: h\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n`)
      })
      let buffer = ''
      socket.on('data', (chunk) => { buffer += String(chunk); socket.destroy(); resolve(buffer) })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('rejected upgrade timed out')), 4000)
    })
    expect(rejected).toContain('403')
    // Both upgrade verdicts land in the ring too.
    const log = proxy.requestLog()
    expect(log.some(row => row.method === 'WS' && row.verdict === 'device' && row.forwarded)).toBe(true)
    expect(log.some(row => row.method === 'WS' && row.verdict === 'denied' && !row.forwarded)).toBe(true)
  })
})
