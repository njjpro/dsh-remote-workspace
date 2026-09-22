/**
 * The local side of the device-workspace federation: this instance pairs
 * into a REMOTE DSH instance as an ordinary device (the pairing token from
 * the peer's panel is exchanged once for a device cookie), keeps the
 * credential alive with heartbeats, and periodically pulls the peer's
 * workspace inventory (projects + sessions). The embed proxy (peer-proxy)
 * rides the same credential. The credential file is 0600 and stores no
 * token — only the exchanged device id, which is itself the session
 * credential (same trust shape as every paired device).
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { PeerInventory } from './peer-remote.ts'

/** Default node fetch is fine; tests inject a stub through this face. */
export type PeerFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export interface PeerCredential {
  baseUrl: string
  deviceId: string
  cookieName: string
  pairedAt: number
}

export interface PeerSnapshot {
  configured: boolean
  online: boolean
  baseUrl?: string
  lastError?: string
  lastSyncAt?: number
  inventory?: PeerInventory
}

const PEER_FILE = 'remote-web-ui-peer.json'
const CONNECT_TIMEOUT_MS = 15_000
/** One combined tick: presence must beat faster than the peer's offlineAfterMs (25s default). */
const TICK_INTERVAL_MS = 20_000

/** Load the persisted credential, tolerant of drift (null when unusable). */
function loadCredential(file: string): PeerCredential | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PeerCredential>
    if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl === '') return undefined
    if (typeof parsed.deviceId !== 'string' || parsed.deviceId === '') return undefined
    if (typeof parsed.cookieName !== 'string' || parsed.cookieName === '') return undefined
    return {
      baseUrl: parsed.baseUrl,
      deviceId: parsed.deviceId,
      cookieName: parsed.cookieName,
      ...(typeof parsed.pairedAt === 'number' ? { pairedAt: parsed.pairedAt } : { pairedAt: 0 }),
    }
  } catch {
    return undefined
  }
}

/** Atomic 0600 write (temp file + rename), same shape as the device table. */
function persist(file: string, credential: PeerCredential): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(credential, null, 2), { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // win32: POSIX mode bits do not exist; the NTFS ACL governs.
  }
  renameSync(tmp, file)
}

export interface PeerLinkDeps {
  baseUrl: string
  pairToken: string
  dshHome: string
  fetchImpl?: PeerFetch
  now?: () => number
}

/**
 * One remote workspace source. Lifecycle: start() connects (exchange or
 * reuse the persisted credential for the same base URL), then heartbeats
 * and refreshes the inventory on intervals until stop().
 */
export class PeerLink {
  private readonly file: string
  private readonly fetchImpl: PeerFetch
  private readonly now: () => number
  private credential: PeerCredential | undefined
  private inventory: PeerInventory | undefined
  private lastError: string | undefined
  private lastSyncAt: number | undefined
  private online = false
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private connecting: Promise<void> | undefined

  constructor(private readonly deps: PeerLinkDeps) {
    this.file = join(deps.dshHome, PEER_FILE)
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as PeerFetch)
    this.now = deps.now ?? Date.now
    const stored = loadCredential(this.file)
    // A stored credential only applies to the same peer base URL.
    if (stored !== undefined && stored.baseUrl.replace(/\/+$/, '') === deps.baseUrl.replace(/\/+$/, '')) {
      this.credential = stored
    }
  }

  /** The peer base URL this link was configured with. */
  get baseUrl(): string {
    return this.deps.baseUrl
  }

  /** Whether a credential exists (connected now or in a previous run). */
  get hasCredential(): boolean {
    return this.credential !== undefined
  }

  /** The wire credential for the embed proxy (undefined until connected). */
  get credentialSnapshot(): { cookie: string; deviceId: string } | undefined {
    const credential = this.credential
    if (credential === undefined) return undefined
    return { cookie: `${credential.cookieName}=${credential.deviceId}`, deviceId: credential.deviceId }
  }

  private headers(): Record<string, string> {
    const credential = this.credential
    if (credential === undefined) throw new Error('peer: not connected')
    return {
      cookie: `${credential.cookieName}=${credential.deviceId}`,
      'x-dsh-remote-device': credential.deviceId,
      'user-agent': 'dsh-remote-web-ui-peer/1.0',
    }
  }

  private async request(path: string, init?: { method?: string; body?: string }): Promise<{ status: number; body: string; headers: { get(name: string): string | null } }> {
    const response = await this.fetchImpl(`${this.deps.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...this.headers() },
      body: init?.body,
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    })
    return { status: response.status, body: await response.text(), headers: response.headers }
  }

  /** Exchange the pairing token for a device credential (once). */
  async connect(): Promise<void> {
    if (this.credential !== undefined) return
    if (this.deps.pairToken === '') throw new Error('peer: pair token missing')
    const response = await this.fetchImpl(`${this.deps.baseUrl}/api/pair/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.deps.pairToken }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    })
    const text = await response.text()
    if (response.status !== 200) throw new Error(`peer: accept failed (${String(response.status)})`)
    let parsed: { ok?: boolean; deviceId?: string }
    try {
      parsed = JSON.parse(text) as { ok?: boolean; deviceId?: string }
    } catch {
      throw new Error('peer: accept response is not JSON')
    }
    const deviceId = parsed.deviceId
    if (parsed.ok !== true || typeof deviceId !== 'string' || deviceId === '') {
      throw new Error('peer: accept response missing deviceId')
    }
    const setCookie = response.headers.get('set-cookie') ?? ''
    // The cookie name rides the Set-Cookie header (`dsh_pair=<id>`); the
    // exact name is the peer's choice, so never hard-code it here.
    const pair = /([A-Za-z0-9_-]+)=([^;]+)/.exec(setCookie)
    if (pair === null) throw new Error('peer: accept response carried no device cookie')
    this.credential = {
      baseUrl: this.deps.baseUrl,
      deviceId,
      cookieName: pair[1],
      pairedAt: this.now(),
    }
    persist(this.file, this.credential)
  }

  /** One presence heartbeat; false when the credential was revoked. */
  async heartbeat(): Promise<boolean> {
    try {
      const response = await this.request('/api/pair/heartbeat', { method: 'POST', body: '{}' })
      this.online = response.status === 200
      if (!this.online) this.lastError = `heartbeat ${String(response.status)}`
      return this.online
    } catch (error) {
      this.online = false
      this.lastError = error instanceof Error ? error.message : 'heartbeat failed'
      return false
    }
  }

  /** Pull the peer's workspace inventory into the snapshot cache. */
  async refreshInventory(): Promise<PeerInventory | undefined> {
    try {
      const response = await this.request('/pair-remote/inventory')
      if (response.status !== 200) {
        this.lastError = `inventory ${String(response.status)}`
        this.online = response.status !== 401
        return undefined
      }
      const parsed = JSON.parse(response.body) as { ok?: boolean } & PeerInventory
      if (parsed.ok !== true || !Array.isArray(parsed.sessions)) {
        this.lastError = 'inventory payload malformed'
        return undefined
      }
      this.inventory = {
        generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : this.now(),
        sessions: parsed.sessions,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      }
      this.online = true
      this.lastError = undefined
      this.lastSyncAt = this.now()
      return this.inventory
    } catch (error) {
      this.online = false
      this.lastError = error instanceof Error ? error.message : 'inventory failed'
      return undefined
    }
  }

  /**
   * Start a conversation in one of the peer's workspaces.
   * @param workspaceId - the peer workspace to create the session in (optional;
   *   the peer applies its own default when omitted).
   * @returns the new session id, or undefined with the reason on `lastError`.
   */
  async createSession(workspaceId?: string): Promise<string | undefined> {
    try {
      const response = await this.request('/pair-remote/session', {
        method: 'POST',
        body: JSON.stringify(workspaceId !== undefined && workspaceId !== '' ? { workspaceId } : {}),
      })
      if (response.status !== 200) {
        let code = ''
        try {
          code = (JSON.parse(response.body) as { code?: string }).code ?? ''
        } catch {
          // Non-JSON failure body: keep the status only.
        }
        this.lastError = `create ${String(response.status)}${code === '' ? '' : ` (${code})`}`
        return undefined
      }
      const parsed = JSON.parse(response.body) as { ok?: boolean; sessionId?: string }
      if (parsed.ok !== true || typeof parsed.sessionId !== 'string' || parsed.sessionId === '') {
        this.lastError = 'create payload malformed'
        return undefined
      }
      return parsed.sessionId
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'create failed'
      return undefined
    }
  }

  /** Connect (or reuse), then run the heartbeat + inventory intervals. */
  async start(): Promise<void> {
    this.stopped = false
    if (this.connecting === undefined) {
      this.connecting = this.connect().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : 'connect failed'
      }).finally(() => {
        this.connecting = undefined
      })
    }
    await this.connecting
    if (this.stopped) return
    if (this.credential === undefined) {
      // Connect failed (bad token, peer unreachable): leave the error on the
      // snapshot for the device bar. A settings change re-assembles the link.
      return
    }
    if (this.timer !== undefined) clearInterval(this.timer)
    void this.refreshInventory()
    this.timer = setInterval(() => {
      if (this.stopped) return
      void this.heartbeat()
      void this.refreshInventory()
    }, TICK_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** The current snapshot for the loopback status endpoint. */
  snapshot(): PeerSnapshot {
    return {
      configured: this.deps.baseUrl !== '',
      online: this.online,
      ...(this.deps.baseUrl !== '' ? { baseUrl: this.deps.baseUrl } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      ...(this.lastSyncAt !== undefined ? { lastSyncAt: this.lastSyncAt } : {}),
      ...(this.inventory !== undefined ? { inventory: this.inventory } : {}),
    }
  }

  /** Forget the credential (the peer revoked us or the token rotated). */
  reset(): void {
    this.credential = undefined
    this.inventory = undefined
    this.online = false
    try {
      unlinkSync(this.file)
    } catch {
      // Already gone.
    }
  }
}
