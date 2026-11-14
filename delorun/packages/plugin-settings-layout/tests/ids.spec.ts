import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Upstream's client packages, where the layout's upstream section and General row ids are registered. */
const CLIENT_PACKAGES = join(import.meta.dirname, '../../../../packages/client')

/** The TypeScript sources under each upstream client package's `src`, by path. */
function sources(directory: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const name of readdirSync(directory)) {
    const src = join(directory, name, 'src')
    if (!existsSync(src)) continue
    for (const entry of readdirSync(src, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
      const path = join(entry.parentPath, entry.name)
      files.set(path, readFileSync(path, 'utf8'))
    }
  }
  return files
}

/**
 * Whether a source file registers `id` in `slot`: it names the slot and holds the id as a string literal.
 * @param files - upstream source files.
 * @param slot - the slot name.
 * @param id - the registration id.
 * @returns whether some file registers it.
 */
function registers(files: ReadonlyMap<string, string>, slot: string, id: string): boolean {
  return [...files.values()].some(text => text.includes(`name: '${slot}'`) && text.includes(`'${id}'`))
}

describe('the upstream ids the layout names', () => {
  const files = sources(CLIENT_PACKAGES)

  it.each(['account', 'models', 'agent-presets', 'plugins'])('upstream registers the section %s', (id) => {
    expect(registers(files, 'settings.section', id)).toBe(true)
  })

  it.each([
    'font-size', 'composer-enter', 'shortcuts', 'link-opening', 'performance-usage', 'developer-tools', 'language', 'permission',
    'current-version', 'session-log-deepseek', 'appearance', 'transcript-view',
  ])('upstream registers the General row %s', (id) => {
    expect(registers(files, 'settings.general.item', id)).toBe(true)
  })

  it('does not register an id this check would accept for every id', () => {
    expect(registers(files, 'settings.section', 'no-such-section')).toBe(false)
  })
})
