/**
 * Peer inventory wire shapes and the loopback snapshot fetch, shared by the
 * sidebar section and any other face that renders the peer workspace source.
 * Mirrors the /api/pair/peer response served by the host half.
 */

export interface PeerSessionRow {
  id: string
  title?: string
  updatedAt?: number
  running: boolean
  subagent?: boolean
}

export interface PeerWorkspaceRow {
  id: string
  title: string
  path: string
  sessionIds: string[]
}

export interface PeerClientState {
  configured: boolean
  online: boolean
  baseUrl?: string
  inventory?: {
    sessions: PeerSessionRow[]
    workspaces: PeerWorkspaceRow[]
  }
}

/** Fetch the current peer snapshot; undefined when the peer is not wired. */
export async function fetchPeerState(): Promise<PeerClientState | undefined> {
  try {
    const response = await fetch('/api/pair/peer')
    if (!response.ok) return undefined
    return await response.json() as PeerClientState
  } catch {
    return undefined
  }
}

/** Resolve the one-shot embed URL for a peer session (POST control route). */
export async function fetchEmbedUrl(sessionId: string): Promise<string | undefined> {
  try {
    const response = await fetch('/api/pair/peer/embed-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!response.ok) return undefined
    const parsed = await response.json() as { ok?: boolean; url?: string }
    return parsed.ok === true && typeof parsed.url === 'string' ? parsed.url : undefined
  } catch {
    return undefined
  }
}

/**
 * Start a conversation in a peer workspace.
 *
 * The peer creates the session and this returns its id plus the embed URL for
 * it, in one call: creating and opening are a single user action, and splitting
 * them would leave an empty session behind whenever the second step failed.
 * @param workspaceId - the peer workspace to start in (optional).
 * @returns the new session id and its embed URL, or undefined on failure.
 */
export async function fetchNewSession(workspaceId?: string): Promise<{ sessionId: string; url: string } | undefined> {
  try {
    const response = await fetch('/api/pair/peer/new-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workspaceId !== undefined && workspaceId !== '' ? { workspaceId } : {}),
    })
    if (!response.ok) return undefined
    const parsed = await response.json() as { ok?: boolean; sessionId?: string; url?: string }
    if (parsed.ok !== true || typeof parsed.sessionId !== 'string' || parsed.sessionId === '') return undefined
    if (typeof parsed.url !== 'string' || parsed.url === '') return undefined
    return { sessionId: parsed.sessionId, url: parsed.url }
  } catch {
    return undefined
  }
}
