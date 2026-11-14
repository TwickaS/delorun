/**
 * The overview an agent reads to see where a change belongs: the unreleased fragments by area, which is what the next
 * sub-version would contain, and the pending fragments with what each waits for.
 *
 * @module @delorun/release/changelog/list
 */
import { basename } from 'node:path'
import { AREAS, fragmentPaths, pendingPaths, readFragments, type Fragment } from './fragment.ts'

/** How many characters of a fragment's first bullet the overview prints. */
const PREVIEW_WIDTH = 100

/**
 * A count with its noun.
 * @param count - the count.
 * @param noun - the singular noun.
 * @returns such as `1 bullet` or `2 bullets`.
 */
function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * A fragment's bullets joined into one line, shortened.
 * @param fragment - the fragment.
 * @returns the text starting at the first bullet without its marker, ended by `...` when it was cut.
 */
function preview(fragment: Fragment): string {
  const text = fragment.bullets.join(' ').slice(2)
  return text.length > PREVIEW_WIDTH ? `${text.slice(0, PREVIEW_WIDTH - 3).trimEnd()}...` : text
}

/**
 * The unreleased fragments grouped by area, then the pending fragments.
 * @param root - the repository root.
 * @returns the overview text, ending with one newline, and one message per fragment that does not parse; the text
 * lists only the fragments that parse.
 */
export function listUnreleased(root: string): { readonly text: string; readonly errors: string[] } {
  const unreleased = readFragments(root, fragmentPaths(root), 'unreleased')
  const pending = readFragments(root, pendingPaths(root), 'pending')
  const lines: string[] = [unreleased.fragments.length === 0 ? 'Unreleased: none.' : `Unreleased: ${counted(unreleased.fragments.length, 'fragment')}, by area (the next sub-version would contain these).`]
  for (const area of AREAS) {
    const own = unreleased.fragments.filter(fragment => fragment.area === area)
    if (own.length === 0) continue
    lines.push('', area)
    for (const fragment of own) lines.push(`  ${basename(fragment.path)} (${fragment.section}, ${counted(fragment.bullets.length, 'bullet')}): ${preview(fragment)}`)
  }
  lines.push('', pending.fragments.length === 0 ? 'Pending: none.' : `Pending: ${counted(pending.fragments.length, 'fragment')}, never assembled; each waits for the wiring named.`)
  for (const fragment of pending.fragments) lines.push(`  ${basename(fragment.path)} (${fragment.area}): waits ${String(fragment.waits)}`)
  return { text: `${lines.join('\n')}\n`, errors: [...unreleased.errors, ...pending.errors] }
}
