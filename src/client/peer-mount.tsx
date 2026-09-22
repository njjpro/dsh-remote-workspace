/**
 * Mounting the peer federation faces into the official layout.
 *
 * The official shell owns the sidebar list and the center column and may
 * rebuild them at any time (fold flips, route changes, theme swaps), so the
 * faces are mounted as appended containers that a light keep-alive loop
 * re-attaches whenever the official DOM drops them. React roots are created
 * once per container; re-attaching the same container node keeps its state.
 */
import { createRoot, type Root } from 'react-dom/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PeerWorkspacesSection } from './PeerWorkspacesSection.tsx'
import { PeerSessionView } from './PeerSessionView.tsx'

type RemoteTranslate = TranslateNS<'remote-workspace'>

/** The official workspace list inside the sidebar column. The classic shell
 *  nests the list under `_sidebarCol`; the desktop window modes wrap the
 *  upstream sidebar in their own surface (`_listArea > _list`). */
export function findSidebarListHost(root: ParentNode): Element | null {
  return root.querySelector('[class$="_sidebarCol"] [class$="_list"], [class$="_listArea"] [class$="_list"]')
}

/** The official center conversation column. `_viewArea` is the desktop
 *  window-mode name for the same surface. */
export function findCenterHost(root: ParentNode): Element | null {
  return root.querySelector('[class$="_centerCol"], [class$="_viewArea"]')
}

interface MountState {
  container: HTMLElement
  root: Root
  live: boolean
}

/**
 * Run a peer face: polls for the official host element, mounts once, and
 * re-attaches after official rebuilds. The gate reflects the plugin switch
 * (and loopback): while closed, the face unmounts and detaches.
 */
function runFace(options: {
  resolveHost: () => Element | null
  create: (host: Element) => MountState
  disposeState: (state: MountState) => void
  gate: () => boolean
}): () => void {
  let state: MountState | undefined
  // Diagnostic flight recorder: beacon only on gate/host state transitions so
  // the log shows whether the gate or the anchor is what blocks mounting.
  let lastProbe = ''
  const probe = (tag: string): void => {
    if (tag === lastProbe) return
    lastProbe = tag
    try {
      if (typeof window === 'undefined' || typeof Image === 'undefined') return
      new Image().src = `http://127.0.0.1:43121/assets/__probe_${encodeURIComponent(tag)}_${Date.now()}.gif`
    } catch {
      // diagnostics are best-effort
    }
  }
  const timer = window.setInterval(() => {
    if (!options.gate()) {
      probe('gate-closed')
      if (state !== undefined && state.live) {
        options.disposeState(state)
        state.live = false
      }
      return
    }
    probe(state !== undefined && state.live && state.container.isConnected ? 'live' : 'gate-open')
    if (state !== undefined && state.live && state.container.isConnected) return
    const host = options.resolveHost()
    if (host === null) {
      probe('host-null')
      // Anchor reconnaissance (diagnostic): when the expected shell classes
      // are absent, sample the class names actually present so the anchors
      // can be adapted to other window modes.
      try {
        const w = window as unknown as { __dshAnchorReconAt?: number }
        const now = Date.now()
        if (w.__dshAnchorReconAt === undefined || now - w.__dshAnchorReconAt > 3000) {
          w.__dshAnchorReconAt = now
          const samples: string[] = []
          const all = document.querySelectorAll('[class]')
          for (let i = 0; i < all.length && samples.length < 14; i += 1) {
            const cls = all[i].className
            if (typeof cls === 'string' && /sidebar|center|col|list|frame|main|content/i.test(cls)) {
              samples.push(cls.slice(-34))
            }
          }
          if (samples.length > 0) {
            new Image().src = `http://127.0.0.1:43121/assets/__probe_classes-${encodeURIComponent(samples.join('|')).slice(0, 140)}_${now}.gif`
          }
          // Center-point chain: the element chain at the window center names
          // the content column classes in the current window mode.
          const cx = window.innerWidth / 2
          const cy = window.innerHeight / 2
          const el = document.elementFromPoint(cx, cy)
          const chain: string[] = []
          let cur: Element | null = el
          while (cur !== null && chain.length < 5) {
            const cls = typeof cur.className === 'string' ? cur.className.slice(-34) : ''
            chain.push(`${cur.tagName}${cls === '' ? '' : '.' + cls}`)
            cur = cur.parentElement
          }
          if (chain.length > 0) {
            new Image().src = `http://127.0.0.1:43121/assets/__probe_centerchain-${encodeURIComponent(chain.join('>')).slice(0, 140)}_${now}.gif`
          }
        }
      } catch {
        // diagnostics are best-effort
      }
      return
    }
    if (state === undefined) {
      state = options.create(host)
      return
    }
    host.appendChild(state.container)
    state.live = true
  }, 300)
  return () => {
    window.clearInterval(timer)
    if (state !== undefined && state.live) options.disposeState(state)
    state = undefined
  }
}

/**
 * Mount the sidebar peer-workspace section under the official workspace
 * list. While the gate is closed the section unmounts and detaches, so a
 * disabled plugin leaves no surface behind.
 */
export function mountPeerWorkspacesSection(t: RemoteTranslate, gate: () => boolean): () => void {
  return runFace({
    resolveHost: () => findSidebarListHost(document),
    gate,
    create: (host) => {
      try {
        if (typeof Image !== 'undefined') new Image().src = `http://127.0.0.1:43121/assets/__probe_section-create_${Date.now()}.gif`
      } catch {}
      const container = document.createElement('div')
      container.setAttribute('data-dsh-plugin', 'remote-workspace')
      container.setAttribute('data-dsh-part', 'peer-workspace-section-host')
      host.appendChild(container)
      const root = createRoot(container)
      root.render(<PeerWorkspacesSection t={t} />)
      return { container, root, live: true }
    },
    disposeState: (state) => {
      try {
        state.root.unmount()
      } catch {
        // the root may already be gone with an official rebuild
      }
      state.container.remove()
    },
  })
}

/**
 * Mount the center-column peer session view. Also installs the one CSS
 * rule that makes the official center column a positioning context, since
 * the view is absolutely positioned over it.
 */
export function mountPeerSessionView(gate: () => boolean): () => void {
  if (document.getElementById('dshPeerViewStyle') === null) {
    const style = document.createElement('style')
    style.id = 'dshPeerViewStyle'
    style.textContent = `[class$='_centerCol']{position:relative !important}`
    document.head.appendChild(style)
  }
  return runFace({
    resolveHost: () => findCenterHost(document),
    gate,
    create: (host) => {
      try {
        if (typeof Image !== 'undefined') new Image().src = `http://127.0.0.1:43121/assets/__probe_view-create_${Date.now()}.gif`
      } catch {}
      const container = document.createElement('div')
      container.setAttribute('data-dsh-plugin', 'remote-workspace')
      container.setAttribute('data-dsh-part', 'peer-session-view-host')
      host.appendChild(container)
      const root = createRoot(container)
      root.render(<PeerSessionView />)
      return { container, root, live: true }
    },
    disposeState: (state) => {
      try {
        state.root.unmount()
      } catch {
        // the root may already be gone with an official rebuild
      }
      state.container.remove()
    },
  })
}
