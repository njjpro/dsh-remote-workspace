/**
 * PeerLink: the local side of the federation. The pairing token is exchanged
 * exactly once for a device credential (persisted 0600 in the DSH home),
 * heartbeats and inventory pulls ride that credential, and the link reports
 * an honest online/offline + last-error snapshot. Reset forgets everything.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { PeerLink } from '../src/peer.ts'

/** A fake remote peer: accept/heartbeat/inventory with credential checks. */
async function servePeer(): Promise<{ server: Server; port: number; accepts: { count: () => number } }> {
  let acceptCount = 0
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    const cookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : ''
    const authed = cookie === 'dsh_pair=dev-1' && request.headers['x-dsh-remote-device'] === 'dev-1'
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/pair/accept' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      request.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { token?: string }
        if (parsed.token !== 'tok-1') {
          json(404, { ok: false, code: 'not-found' })
          return
        }
        acceptCount += 1
        json(200, { ok: true, deviceId: 'dev-1' }, { 'set-cookie': 'dsh_pair=dev-1; Path=/; HttpOnly; SameSite=Lax' })
      })
      return
    }
    if (url.pathname === '/api/pair/heartbeat' && request.method === 'POST') {
      if (!authed) { json(401, { ok: false }); return }
      json(200, { ok: true })
      return
    }
    if (url.pathname === '/pair-remote/inventory' && request.method === 'GET') {
      if (!authed) { json(401, { ok: false, code: 'unpaired' }); return }
      json(200, {
        ok: true,
        generatedAt: 42,
        sessions: [{ id: 'sess-a', title: 'A', running: false, blank: false, subagent: false }],
        workspaces: [{ id: 'ws-a', title: 'WS', path: 'C:\\ws', sessionIds: ['sess-a'] }],
      })
      return
    }
    json(404, { ok: false })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port, accepts: { count: () => acceptCount } }
}

describe('PeerLink', () => {
  let home: string
  const closers: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    if (home !== undefined) {
      rmSync(home, { recursive: true, force: true })
      home = undefined as never
    }
  })

  it('exchanges the token once, persists the credential, and pulls the inventory', async () => {
    home = mkdtempSync(join(tmpdir(), 'peer-link-'))
    const peer = await servePeer()
    closers.push(() => new Promise((resolve, reject) => peer.server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })))
    const link = new PeerLink({ baseUrl: `http://127.0.0.1:${String(peer.port)}`, pairToken: 'tok-1', dshHome: home })
    await link.start()
    link.stop()
    expect(link.hasCredential).toBe(true)
    expect(peer.accepts.count()).toBe(1)
    // The credential file holds the exchanged device id, not the token.
    const stored = JSON.parse(readFileSync(join(home, 'remote-web-ui-peer.json'), 'utf8')) as { deviceId?: string; cookieName?: string }
    expect(stored).toMatchObject({ deviceId: 'dev-1', cookieName: 'dsh_pair', baseUrl: `http://127.0.0.1:${String(peer.port)}` })
    // A restarted link with the same base URL reuses the credential.
    const revived = new PeerLink({ baseUrl: `http://127.0.0.1:${String(peer.port)}`, pairToken: 'tok-1', dshHome: home })
    await revived.start()
    revived.stop()
    expect(peer.accepts.count()).toBe(1)
    // Inventory refresh is fire-and-forget inside start; drive it explicitly.
    await revived.refreshInventory()
    const snapshot = revived.snapshot()
    expect(snapshot.configured).toBe(true)
    expect(snapshot.online).toBe(true)
    expect(snapshot.inventory?.sessions).toEqual([{ id: 'sess-a', title: 'A', running: false, blank: false, subagent: false }])
    expect(snapshot.inventory?.workspaces).toEqual([{ id: 'ws-a', title: 'WS', path: 'C:\\ws', sessionIds: ['sess-a'] }])
  })

  it('rejects a wrong pairing token and stores nothing', async () => {
    home = mkdtempSync(join(tmpdir(), 'peer-link-'))
    const peer = await servePeer()
    closers.push(() => new Promise((resolve, reject) => peer.server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })))
    const link = new PeerLink({ baseUrl: `http://127.0.0.1:${String(peer.port)}`, pairToken: 'wrong', dshHome: home })
    await link.start()
    link.stop()
    expect(link.hasCredential).toBe(false)
    expect(link.snapshot().online).toBe(false)
    expect(link.snapshot().lastError).toContain('404')
    expect(existsSync(join(home, 'remote-web-ui-peer.json'))).toBe(false)
  })

  it('reset forgets the credential file', async () => {
    home = mkdtempSync(join(tmpdir(), 'peer-link-'))
    const peer = await servePeer()
    closers.push(() => new Promise((resolve, reject) => peer.server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })))
    const link = new PeerLink({ baseUrl: `http://127.0.0.1:${String(peer.port)}`, pairToken: 'tok-1', dshHome: home })
    await link.start()
    link.stop()
    expect(existsSync(join(home, 'remote-web-ui-peer.json'))).toBe(true)
    link.reset()
    expect(existsSync(join(home, 'remote-web-ui-peer.json'))).toBe(false)
    expect(link.hasCredential).toBe(false)
  })

  /** One fake peer that answers the create route however the test needs. */
  async function serveCreator(handler: (body: { workspaceId?: string }, authed: boolean) => { status: number; body: unknown }): Promise<{ server: Server; port: number; calls: Array<{ workspaceId?: string }> }> {
    const calls: Array<{ workspaceId?: string }> = []
    let authed = false
    const server = createServer((request, response) => {
      const respond = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://x')
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { token?: string; workspaceId?: string }
        if (url.pathname === '/api/pair/accept' && request.method === 'POST') {
          if (parsed.token !== 'tok-1') { respond(404, { ok: false }); return }
          authed = true
          response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh_pair=dev-1; Path=/; HttpOnly; SameSite=Lax' })
          response.end(JSON.stringify({ ok: true, deviceId: 'dev-1' }))
          return
        }
        if (url.pathname === '/pair-remote/session' && request.method === 'POST') {
          calls.push(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId })
          const result = handler(parsed, authed)
          respond(result.status, result.body)
          return
        }
        respond(200, { ok: true, generatedAt: 1, sessions: [], workspaces: [] })
      })()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return { server, port: (server.address() as AddressInfo).port, calls }
  }

  it('creates a session on the peer and returns its id', async () => {
    home = mkdtempSync(join(tmpdir(), 'peer-link-'))
    const peer = await serveCreator(() => ({ status: 200, body: { ok: true, sessionId: 'session-made' } }))
    closers.push(() => new Promise((resolve, reject) => peer.server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })))
    const link = new PeerLink({ baseUrl: `http://127.0.0.1:${String(peer.port)}`, pairToken: 'tok-1', dshHome: home })
    await link.start()
    link.stop()
    expect(await link.createSession('ws-1')).toBe('session-made')
    expect(peer.calls).toEqual([{ workspaceId: 'ws-1' }])
  })

  it('omits the workspace when none is given', async () => {
    home = mkdtempSync(join(tmpdir(), 'peer-link-'))
    const peer = await serveCreator(() => ({ status: 200, body: { ok: true, sessionId: 'session-any' } }))
    closers.push(() => new Promise((resolve, reject) => peer.server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })))
    const link = new PeerLink({ baseUrl: `http://127.0.0.1:${String(peer.port)}`, pairToken: 'tok-1', dshHome: home })
    await link.start()
    link.stop()
    expect(await link.createSession()).toBe('session-any')
    // No workspace key at all, so the peer applies its own default.
    expect(peer.calls).toEqual([{}])
  })

  it('surfaces the peer reason when creation fails', async () => {
    home = mkdtempSync(join(tmpdir(), 'peer-link-'))
    const peer = await serveCreator(() => ({ status: 501, body: { ok: false, code: 'create-unavailable' } }))
    closers.push(() => new Promise((resolve, reject) => peer.server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })))
    const link = new PeerLink({ baseUrl: `http://127.0.0.1:${String(peer.port)}`, pairToken: 'tok-1', dshHome: home })
    await link.start()
    link.stop()
    expect(await link.createSession('ws-1')).toBeUndefined()
    expect(link.snapshot().lastError).toContain('create-unavailable')
  })

  it('treats a malformed create payload as a failure', async () => {
    home = mkdtempSync(join(tmpdir(), 'peer-link-'))
    const peer = await serveCreator(() => ({ status: 200, body: { ok: true } }))
    closers.push(() => new Promise((resolve, reject) => peer.server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })))
    const link = new PeerLink({ baseUrl: `http://127.0.0.1:${String(peer.port)}`, pairToken: 'tok-1', dshHome: home })
    await link.start()
    link.stop()
    expect(await link.createSession('ws-1')).toBeUndefined()
    expect(link.snapshot().lastError).toContain('malformed')
  })
})
