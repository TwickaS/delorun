/**
 * The workspace badge's colour names and monogram initials, shared by the sidebar and the Branding picker.
 * @module @delorun/brand/badge-colors
 */

/**
 * A Workspace badge's letters: the initials of its first two words, or its first two letters.
 * @param title - the Workspace's shown title.
 * @returns one or two uppercase letters, or an empty string for a title without letters or digits.
 */
export function workspaceInitials(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(word => word !== '')
  const [first, second] = words
  if (first === undefined) return ''
  const letters = second === undefined ? [...first].slice(0, 2) : [[...first][0], [...second][0]]
  return letters.join('').toLocaleUpperCase()
}

/** The badge colours, in Workspace order, so the first five differ. */
export const BADGE_COLORS = ['blue', 'green', 'amber', 'violet', 'red'] as const

/** One badge colour. */
export type BadgeColor = typeof BADGE_COLORS[number]
