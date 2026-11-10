/**
 * Hand-written fixes to upstream's English texts that Delo Run shows, laid
 * over the generated vocabulary: upstream's casing slips and labels that read
 * better in Delo's sentence case.
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
