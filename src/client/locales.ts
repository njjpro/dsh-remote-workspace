/**
 * Product copy for the remote-workspace surfaces.
 *
 * `zh` is the key source and `en` mirrors its key set exactly (harness i18n
 * convention); both are registered through `ctx.locale.register`. The third
 * language (ru) lives in the dsh-i18n package, which mirrors every zh key — see
 * that package's AGENTS.md.
 */
export const zh = {
  'workspaces.title': '远程工作区',
  'workspaces.offline': '工作区源离线',
  'workspaces.empty': '远端没有会话',
  'workspaces.unassigned': '未分组',
  'workspaces.openExternal': '在浏览器中打开',
  'workspaces.newConversation': '新建对话',
} as const

export type RemoteWorkspaceKey = keyof typeof zh

export const en: Record<RemoteWorkspaceKey, string> = {
  'workspaces.title': 'Remote workspaces',
  'workspaces.offline': 'Workspace source offline',
  'workspaces.empty': 'No sessions on the peer',
  'workspaces.unassigned': 'Unassigned',
  'workspaces.openExternal': 'Open in browser',
  'workspaces.newConversation': 'New conversation',
}
