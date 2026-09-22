/**
 * Browser half of the remote-workspace plugin.
 *
 * Two surfaces, both mounted into the OFFICIAL shell rather than reimplementing it:
 *
 *   - a collapsible "remote workspaces" group in the sidebar, listing the paired
 *     instance's projects and sessions;
 *   - a center-column view that hosts each peer session in an iframe served by the
 *     local loopback embed proxy.
 *
 * Both are gated on the plugin switch AND on loopback: a paired phone browser is
 * itself a device, and these surfaces are the desktop's, so they stay absent there.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the Context merges for the services this half reads
// (ctx.locale from the locale plugin, ctx.settingsScope from the settings
// surface, and the renderer-owned ctx.slots registry). No runtime import.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { en, zh, type RemoteWorkspaceKey } from './locales.ts'
import { EMBED_SHELL_STYLE_ID, embedShellCss } from './embed-shell-css.ts'
import { startEmbedComposerFocus } from './embed-shell-focus.ts'
import { fetchEmbedUrl, fetchNewSession } from './peer-inventory.ts'
import { mountPeerSessionView, mountPeerWorkspacesSection } from './peer-mount.tsx'
import { peerSessionStore } from './peer-session-store.ts'

/** Locale namespace this package owns. */
const NS = 'remote-workspace'

// Register this package's namespace with the locale service so TranslateNS can
// type it. Interface merging makes this additive: the official plugin declaring
// its own `remote` namespace is unaffected.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the remote workspace surfaces. */
    'remote-workspace': RemoteWorkspaceKey
  }
}

/** Structural settings scope: only the two members this half reads. */
interface SettingsScopeLike<T> {
  getSnapshot(): { status: string; value?: T }
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional compatibility binder provided by the dsh-web-settings group
     * plugin; absent when it is not installed, so callers fall back to the
     * official settings scope. Declared here with the same shape the official
     * plugin declares, so this package needs no dependency on it.
     */
    webUiSettings?: { bind<S>(spec: { namespace: string }): SettingsScopeLike<S> }
  }
}


/** Client services this half needs. `connection` and `sessions` are optional reads. */
export const inject = ['slots', 'locale', 'settingsScope', 'sessions']

/**
 * Whether this document is an embedded peer pane rather than the local shell.
 *
 * The marker is mirrored into sessionStorage on the first hit, because the capture
 * script strips the query string from the address bar before later reads.
 * @returns true when this document should boot the embed shell.
 */
function isEmbedDocument(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  const fresh = params.get('dsh-remote-embed') === '1'
  if (fresh) {
    try {
      window.sessionStorage.setItem('dsh-remote-embed', '1')
      const target = params.get('dsh-remote-session')
      if (target !== null && target !== '') window.sessionStorage.setItem('dsh-remote-session', target)
    } catch {
      // storage may be unavailable; a same-load embed still works
    }
  }
  let stored = false
  try {
    stored = window.sessionStorage.getItem('dsh-remote-embed') === '1'
  } catch {
    // treat storage failures as absent mirrors
  }
  if (!fresh && !stored) return false
  document.documentElement.dataset.dshRemoteEmbed = '1'
  return true
}

/**
 * Apply the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.locale.register(NS, { zh, en })
  const t = ctx.locale.bind(NS) as TranslateNS<'remote-workspace'>

  // Embed-shell boot. This client half also runs INSIDE every peer pane: the
  // loopback proxy serves the peer's own document, and that document loads the
  // peer's copy of this plugin. Two things are required there and nowhere else.
  //
  //   - The layout override that collapses the peer shell to its center column.
  //     Without it the embedded shell keeps a `0 minmax(0,1fr) 0`-style grid whose
  //     flexible track is taken by the right bar, so the center column renders
  //     zero-width and the pane looks blank.
  //   - The composer focus handoff, whose inner half only this same-origin frame
  //     can perform (the parent shell cannot reach into the iframe).
  //
  // The marker survives the address-bar rewrite through sessionStorage, and
  // `dsh-remote-embed=1` is read before the capture script strips the query.
  if (isEmbedDocument()) {
    if (document.getElementById(EMBED_SHELL_STYLE_ID) === null) {
      const style = document.createElement('style')
      style.id = EMBED_SHELL_STYLE_ID
      style.textContent = embedShellCss()
      document.head.appendChild(style)
    }
    const stopFocus = startEmbedComposerFocus()
    ctx.effect(() => stopFocus, 'remote-workspace: embed composer focus')
  }

  // The store is framework-free, so its two outbound calls are injected once.
  peerSessionStore.setFetcher(fetchEmbedUrl)
  peerSessionStore.setStarter(fetchNewSession)

  // Opening a local session folds the peer view without destroying its iframe —
  // the local shell switches, the peer session stays loaded for the next click.
  //
  // The trigger is a real click on an official sidebar session row rather than a
  // diff of the sessions snapshot: that list emits on every update (streaming
  // tokens, background refreshes) and its `current` reading wobbles, which used to
  // fold the peer view seconds after it opened.
  const sessions = ctx.get('sessions') as
    | { list: { getSnapshot(): { byId: Record<string, unknown>; current?: string } } }
    | undefined
  if (sessions !== undefined) {
    const onDocumentClick = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (peerSessionStore.getState().activeSessionId === undefined) return
      // Our own surfaces are not local sessions.
      if (target.closest('[data-dsh-plugin="remote-workspace"]') !== null) return
      // Official session rows carry the `_sessionRow` CSS-module suffix.
      if (target.closest('[class$="_sessionRow"], [class$="_sessionItem"]') === null) return
      peerSessionStore.noteLocalSessionActive()
    }
    document.addEventListener('click', onDocumentClick, true)
    ctx.effect(() => () => {
      document.removeEventListener('click', onDocumentClick, true)
    }, 'remote-workspace: local session click collapse')
  }

  // The device bar and these mounts are desktop surfaces: on a paired remote
  // browser this client IS the device, so the federation has no audience there.
  const loopback = (ctx.get('connection') as ConnectionHandle | undefined)?.isLoopback ?? true

  const binder = ctx.get('webUiSettings') ?? ctx.settingsScope
  const settingsScope = binder.bind<{ enabled?: boolean }>({ namespace: NS })
  const enabled = (): boolean => {
    const snapshot = settingsScope.getSnapshot()
    return snapshot.status === 'ready'
      ? snapshot.value?.enabled ?? true
      : snapshot.status === 'unavailable'
  }

  // Both faces follow official DOM rebuilds through their own keep-alive loops and
  // dispose cleanly with the plugin. The section owns its own inventory polling
  // (only while expanded), so there is no second timer here.
  const gate = (): boolean => enabled() && loopback
  ctx.effect(() => {
    const disposeSection = mountPeerWorkspacesSection(t, gate)
    const disposeView = mountPeerSessionView(gate)
    return () => {
      disposeSection()
      disposeView()
    }
  }, 'remote-workspace: mounts')
}

export type { RemoteWorkspaceKey }
