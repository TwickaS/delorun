/**
 * Reads the notices the product site's `/notices` page shows: the T3 Code licence for the six themes, the SIL Open Font
 * Licence of the two typefaces and the licence of the toast library. The texts come from the files that ship the
 * material, so the page cannot drift from them.
 *
 * @module @delorun/site-design/scripts/notices
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One notice: what it covers, its copyright line and the licence text. */
export interface Notice {
  readonly id: string
  /** The name of the work. */
  readonly name: string
  /** The copyright line. */
  readonly copyright: string
  /** The licence's name. */
  readonly licence: string
  /** The full licence text, with the copyright line. */
  readonly text: string
}

/** The folders and files the notices are read from. */
export interface NoticeSources {
  /** The repository's `delorun/packages` directory. */
  readonly packages: string
  /** The sonner package's `LICENSE.md`. */
  readonly sonnerLicence: string
}

/**
 * The T3 Code notice from the Theme plugin's third-party notices file.
 * @param markdown - the file.
 * @returns the notice.
 * @throws Error when the file no longer holds the T3 Code section.
 */
export function t3Notice(markdown: string): Notice {
  const section = /## T3 Code\n([\s\S]*?)(?=\n## )/.exec(markdown)?.[1]
  const text = section === undefined ? undefined : /MIT License\n[\s\S]*$/.exec(section.trim())?.[0]
  const copyright = text === undefined ? undefined : /^Copyright \(c\) .*$/m.exec(text)?.[0]
  if (text === undefined || copyright === undefined) throw new Error('THIRD_PARTY_NOTICES.md no longer holds the T3 Code licence')
  return { id: 't3-code', name: 'T3 Code', copyright, licence: 'MIT licence', text }
}

/**
 * A font notice from its licence file, whose first line is the copyright line.
 * @param id - the notice id.
 * @param name - the typeface.
 * @param text - the file.
 * @returns the notice.
 */
export function fontNotice(id: string, name: string, text: string): Notice {
  const copyright = text.split('\n')[0]?.trim() ?? ''
  if (!copyright.startsWith('Copyright') || !text.includes('SIL OPEN FONT LICENSE')) throw new Error(`${name}'s licence file is not an SIL Open Font Licence with a copyright line`)
  return { id, name, copyright, licence: 'SIL Open Font Licence, version 1.1', text: text.trim() }
}

/**
 * Reads every notice.
 * @param sources - where the files are.
 * @returns the notices in page order.
 */
export function readNotices(sources: NoticeSources): Notice[] {
  const read = (...path: string[]): string => readFileSync(join(sources.packages, ...path), 'utf8')
  const sonnerText = readFileSync(sources.sonnerLicence, 'utf8').trim()
  const sonnerCopyright = /^Copyright \(c\) .*$/m.exec(sonnerText)?.[0]
  if (sonnerCopyright === undefined) throw new Error("Sonner's licence file no longer has a copyright line")
  return [
    t3Notice(read('plugin-theme', 'THIRD_PARTY_NOTICES.md')),
    fontNotice('schibsted-grotesk', 'Schibsted Grotesk', read('plugin-theme', 'fonts', 'SCHIBSTED-GROTESK-LICENSE.txt')),
    fontNotice('jetbrains-mono', 'JetBrains Mono', read('plugin-theme', 'fonts', 'JETBRAINS-MONO-LICENSE.txt')),
    { id: 'sonner', name: 'Sonner', copyright: sonnerCopyright, licence: 'MIT licence', text: sonnerText },
  ]
}
