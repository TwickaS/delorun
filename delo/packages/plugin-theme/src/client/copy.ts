/**
 * Hand-written fixes to upstream's texts that Delo Run shows, laid over the
 * generated vocabulary: upstream's casing slips, labels that read better in
 * Delo's sentence case, and the Chinese texts the generator's word swap does
 * not reach.
 * @module @delo/plugin-theme/client/copy
 */

/** English override texts by namespace, then key. */
export const COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  workspace: {
    'groupBy.workspace': 'Workspace',
    'groupBy.workspaceTree': 'Workspace tree',
    'groupBy.flat': 'One list',
    'viewOptions.showArchived': 'All, with archived',
    'search.placeholder': 'Search chats',
  },
}

/** Chinese override texts by namespace, then key. */
export const COPY_ZH: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  workspace: {
    'menu.sessionId': '复制对话 ID',
  },
  conversation: {
    'detail.trace.ancestors': '上级对话',
    'detail.trace.descendants': '下级对话',
  },
}
