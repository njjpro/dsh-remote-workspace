/**
 * The peer workspace section: a collapsible group rendered inside the
 * official sidebar workspace list, directly under the local workspaces.
 * It mirrors the official tree's interaction — a group header toggles the
 * section, each peer workspace is a foldable row, and clicking a peer
 * session opens it in the center column through the peer session store.
 * Pure presentation; inventory data comes from the loopback /api/pair/peer
 * snapshot, polled only while the section is expanded.
 */
import { useEffect, useReducer, useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, IconFolderClose16, IconFolderOpenOutline16, IconLinkOutline14, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatLastSeen } from './time-format.ts'
import { peerSessionStore } from './peer-session-store.ts'
import { fetchEmbedUrl, fetchPeerState, type PeerClientState, type PeerSessionRow } from './peer-inventory.ts'
import css from './peer-federation.module.css'

export type PeerTranslate = TranslateNS<'remote-workspace'>

/**
 * Open a peer session top-level in the OS default browser. The desktop
 * window's transparency material does not composite iframe layers, so the
 * embedded shell can stay blank even though its document is fully alive;
 * a real browser renders the same session reliably.
 */
async function openExternally(sessionId: string): Promise<void> {
  try {
    const url = await fetchEmbedUrl(sessionId)
    if (url === undefined) return
    void fetch('/api/pair/peer/open-external', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).catch(() => {})
  } catch {
    // best-effort affordance
  }
}

/** One presentation group: a peer workspace with its resolvable sessions. */
interface PeerGroupRow {
  key: string
  label: string
  sessions: PeerSessionRow[]
}

/** Group the inventory into workspace folders plus an unassigned remainder. */
export function peerGroups(state: PeerClientState, t: PeerTranslate): PeerGroupRow[] {
  const inventory = state.inventory
  if (inventory === undefined) return []
  const byId = new Map(inventory.sessions.map(row => [row.id, row]))
  const used = new Set<string>()
  const groups: PeerGroupRow[] = []
  for (const workspace of inventory.workspaces) {
    const sessions = workspace.sessionIds
      .map(id => byId.get(id))
      .filter((row): row is PeerSessionRow => row !== undefined)
    for (const session of sessions) used.add(session.id)
    if (sessions.length > 0) groups.push({ key: workspace.id, label: workspace.title !== '' ? workspace.title : workspace.path, sessions })
  }
  const rest = inventory.sessions.filter(row => !used.has(row.id) && row.subagent !== true)
  if (rest.length > 0) groups.push({ key: 'unassigned', label: t('workspaces.unassigned'), sessions: rest })
  return groups
}

/** Collapse state persists across reloads so the section stays as left. */
const SECTION_COLLAPSED_KEY = 'dsh-peer-workspaces-collapsed'

/**
 * Render the peer workspace section body.
 * @param props - sidebar copy.
 * @returns the section element tree.
 */
export function PeerWorkspacesSection({ t }: { t: PeerTranslate }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SECTION_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [peer, setPeer] = useState<PeerClientState | undefined>(undefined)
  const [openProjects, setOpenProjects] = useState<Set<string>>(() => new Set())
  const [, bumpStore] = useReducer((count: number) => count + 1, 0)

  useEffect(() => peerSessionStore.subscribe(bumpStore), [])

  useEffect(() => {
    if (collapsed) return
    let disposed = false
    const poll = (): void => {
      void fetchPeerState().then(state => {
        if (!disposed) setPeer(state)
      })
    }
    poll()
    const timer = window.setInterval(poll, 15_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [collapsed])

  const configured = peer?.configured === true
  const groups = configured ? peerGroups(peer!, t) : []
  const activeId = peerSessionStore.getState().activeSessionId

  const toggleProject = (key: string): void => {
    setOpenProjects(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section className={css.section} data-dsh-plugin="remote-workspace" data-dsh-part="peer-workspace-section">
      <button
        type="button"
        className={css.sectionHead}
        aria-expanded={!collapsed}
        onClick={() => {
          setCollapsed(value => {
            try {
              window.localStorage.setItem(SECTION_COLLAPSED_KEY, value ? '0' : '1')
            } catch {
              // storage may be unavailable; the section still toggles
            }
            return !value
          })
        }}
      >
        <span className={css.sectionTitle}>{t('workspaces.title')}</span>
        <span className={css.chevron} data-open={!collapsed ? 'true' : 'false'} aria-hidden="true">
          <IconChevronDownOutline14 size={12} />
        </span>
      </button>
      {!collapsed && (
        <div className={css.sectionBody}>
          {!configured && <p className={css.sectionEmpty}>{t('workspaces.offline')}</p>}
          {configured && groups.length === 0 && <p className={css.sectionEmpty}>{t('workspaces.empty')}</p>}
          {groups.map(group => {
            const open = openProjects.has(group.key) || group.sessions.length === 1
            // The unassigned remainder is not a real workspace, so it has no
            // id to start a conversation in.
            const startable = group.key !== 'unassigned'
            return (
              <div key={group.key} className={css.projectBlock}>
                {group.sessions.length > 1 && (
                  <div className={css.projectLine}>
                    <button
                      type="button"
                      className={css.projectRow}
                      aria-expanded={open}
                      onClick={() => { toggleProject(group.key) }}
                    >
                      <span className={css.rowIcon} aria-hidden="true">
                        {open ? <IconFolderOpenOutline16 size={14} /> : <IconFolderClose16 size={14} />}
                      </span>
                      <span className={css.projectTitle}>{group.label}</span>
                    </button>
                    {startable && (
                      <button
                        type="button"
                        className={css.newConversationRow}
                        title={t('workspaces.newConversation')}
                        aria-label={`${t('workspaces.newConversation')}: ${group.label}`}
                        onClick={() => { void peerSessionStore.startRemote(group.key) }}
                      >
                        <IconPlusOutline16 size={12} />
                      </button>
                    )}
                  </div>
                )}
                {group.sessions.length === 1 && (
                  <div className={css.projectSoloRow}>
                    <span className={css.rowIcon} aria-hidden="true">
                      <IconFolderOpenOutline16 size={14} />
                    </span>
                    <span className={css.projectTitle}>{group.label}</span>
                    {startable && (
                      <button
                        type="button"
                        className={css.newConversationRow}
                        title={t('workspaces.newConversation')}
                        aria-label={`${t('workspaces.newConversation')}: ${group.label}`}
                        onClick={() => { void peerSessionStore.startRemote(group.key) }}
                      >
                        <IconPlusOutline16 size={12} />
                      </button>
                    )}
                  </div>
                )}
                {open && group.sessions.map(session => (
                  <div key={session.id} className={css.sessionLine}>
                    <button
                      type="button"
                      className={clsx(css.sessionRow, activeId === session.id ? css.sessionRowActive : undefined)}
                      title={session.title !== undefined && session.title !== '' ? session.title : undefined}
                      onClick={() => { void peerSessionStore.openRemote(session.id) }}
                    >
                      <span className={css.sessionTitle}>{session.title !== undefined && session.title !== '' ? session.title : session.id}</span>
                      {session.running && <span className={css.runningDot} aria-hidden="true" />}
                      {session.updatedAt !== undefined && (
                        <span className={css.sessionTime}>{formatLastSeen(session.updatedAt)}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className={css.externalRow}
                      title={t('workspaces.openExternal')}
                      aria-label={t('workspaces.openExternal')}
                      onClick={() => { void openExternally(session.id) }}
                    >
                      <IconLinkOutline14 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
