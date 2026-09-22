/**
 * Host half of the remote-workspace plugin.
 *
 * This package owns the device-workspace federation: a paired instance's projects
 * and sessions are browsable here, and each peer session opens in the local center
 * column through a loopback embed proxy.
 *
 * It is deliberately INDEPENDENT of the official remote-web-ui package at build
 * time — no import, no package dependency. Two things are shared instead:
 *
 *   - **Pairing identity** is read from the cordis service `remoteWebUiPairing`,
 *     which that plugin publishes. Without it the peer routes fail closed (401),
 *     so an unpaired or plugin-less host never exposes the inventory.
 *   - **Pairing itself** (minting a token, the device cookie) belongs to that
 *     plugin: this half only REDEEMS a token a peer issued, over
 *     `POST /api/pair/accept`. Nothing here creates or revokes devices.
 *
 * Routes registered here never collide with that plugin's: this package owns
 * `/pair-remote/*` and `/api/pair/peer/*`, while `/api/pair/{issue,accept,...}`,
 * `/pair-accept`, and `/pair-app` stay with it.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { dshHome } from './dsh-home.ts'
import {
  makePeerControlRoutes,
  makePeerRemoteRoutes,
  type PeerFeedFace,
  type PeerPairingFace,
  type PeerRegistryFace,
} from './peer-remote.ts'
import { PeerLink } from './peer.ts'
import { createPeerProxy, EmbedTickets, type PeerProxy } from './peer-proxy.ts'

/** Host services this half needs; `remoteWebUiPairing` is read optionally. */
export const inject = ['webServer', 'typertGateway', 'connection']

/** Plugin configuration, supplied by the profile patch. */
export interface Config {
  /** Master switch; disabling removes every surface this package mounts. */
  enabled?: boolean
  /** Base URL of the paired peer instance, e.g. `https://peer.example`. */
  peerBaseUrl?: string
  /** One-time pairing token minted on the peer's panel; exchanged once. */
  peerPairToken?: string
  /** Loopback port the embed proxy binds (127.0.0.1 only). */
  peerEmbedPort?: number
}

/** Effective values when the profile supplies nothing. */
const DEFAULT_PEER_EMBED_PORT = 43121

/**
 * Read an optional cordis service without importing its package.
 * @param ctx - host context.
 * @param name - service name.
 * @returns the service, or undefined when it is not registered.
 */
function serviceFace<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a value satisfies the pairing face this package consumes.
 * @param value - candidate service.
 * @returns true when it exposes isPairedDevice.
 */
function isPairingFace(value: unknown): value is PeerPairingFace {
  return value !== undefined
    && value !== null
    && typeof (value as PeerPairingFace).isPairedDevice === 'function'
}

/**
 * Apply the host half.
 * @param ctx - host context.
 * @param config - composition-supplied configuration (the loader passes the row's
 *   `config:` block); every field is optional and falls back to a default.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolve = (): Required<Pick<Config, 'enabled' | 'peerBaseUrl' | 'peerEmbedPort'>> & Config => ({
    enabled: config?.enabled ?? true,
    peerBaseUrl: config?.peerBaseUrl ?? '',
    peerPairToken: config?.peerPairToken,
    peerEmbedPort: config?.peerEmbedPort ?? DEFAULT_PEER_EMBED_PORT,
  })

  // Resolved per request: the official plugin registers this service
  // asynchronously, so a one-shot read could cache `undefined` and then refuse
  // every peer request forever.
  const pairing = (): PeerPairingFace | undefined => {
    const face = serviceFace<unknown>(ctx, 'remoteWebUiPairing')
    return isPairingFace(face) ? face : undefined
  }

  const embedTickets = new EmbedTickets()
  let peer: PeerLink | undefined
  let peerProxy: PeerProxy | undefined
  let peerAssembly: string | undefined

  const disposePeer = (): void => {
    peer?.stop()
    peer = undefined
    void peerProxy?.stop().catch(() => {})
    peerProxy = undefined
    embedTickets.clear()
    peerAssembly = undefined
  }

  const syncPeer = (): void => {
    const value = resolve()
    if (value.enabled !== true || value.peerBaseUrl === '') {
      if (peerAssembly !== undefined) disposePeer()
      return
    }
    const key = `${value.peerBaseUrl}|${value.peerPairToken ?? ''}|${String(value.peerEmbedPort)}`
    if (key === peerAssembly) return
    disposePeer()
    peerAssembly = key
    peer = new PeerLink({ baseUrl: value.peerBaseUrl, pairToken: value.peerPairToken ?? '', dshHome: dshHome() })
    peerProxy = createPeerProxy({
      port: value.peerEmbedPort,
      target: () => {
        const snapshot = peer?.credentialSnapshot
        return snapshot === undefined
          ? undefined
          : { baseUrl: value.peerBaseUrl, cookie: snapshot.cookie, deviceId: snapshot.deviceId }
      },
      tickets: embedTickets,
      // Diagnostic flight recorder: the embed proxy appends probe beacons here so a
      // blank pane can be read without DevTools. It must never break the proxy.
      probeSink: (line) => {
        try {
          appendFileSync(join(dshHome(), 'remote-workspace-boot-probe.log'), line + '\n', { flag: 'a' })
        } catch {
          // diagnostics are best-effort
        }
      },
    })
    void peer.start()
    void peerProxy.start().catch((error: unknown) => {
      console.warn('remote-workspace: embed proxy failed to start:', error instanceof Error ? error.message : error)
    })
  }

  ctx.effect(() => () => disposePeer(), 'remote-workspace: peer source')

  const routes: WebRoute[] = [
    // Device-facing: what a PAIRED peer calls to browse this instance.
    ...makePeerRemoteRoutes({
      pairing,
      dshHome: dshHome(),
      getFeed: () => serviceFace<PeerFeedFace>(ctx, 'sessionController'),
      getRegistry: () => serviceFace<PeerRegistryFace>(ctx, 'workspaceRegistry'),
    }),
    // Loopback-only control plane: what this instance's own browser half calls.
    ...makePeerControlRoutes({
      link: () => peer,
      tickets: embedTickets,
      proxyPort: () => peerProxy?.port ?? resolve().peerEmbedPort,
      requestLog: () => peerProxy?.requestLog() ?? [],
      openExternal: (url) => {
        void (async () => {
          try {
            const { spawn } = await import('node:child_process')
            if (process.platform === 'win32') {
              spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true }).unref()
            } else if (process.platform === 'darwin') {
              spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
            } else {
              spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
            }
          } catch {
            // best-effort: the button degrades to a no-op
          }
        })()
      },
    }),
  ]

  ctx.effect(() => routes.map(route => ctx.webServer.register(route)), 'remote-workspace: routes')

  syncPeer()
}
