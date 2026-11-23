/**
 * The pack plugin list the consent's origin check reads holds exactly the rows of every Delorun pack's
 * `cordis.patch.yml`: a pack that adds or drops a row updates `src/pack-plugins.ts` with it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACK_PLUGINS } from '../src/pack-plugins.ts'

const PACKAGES = join(import.meta.dirname, '..', '..')

/**
 * Every pack's plugin rows, by module, from the packs' own files.
 * @returns each row's module mapped to its pack's package name.
 */
function packRows(): Map<string, string> {
  const rows = new Map<string, string>()
  for (const folder of readdirSync(PACKAGES).sort()) {
    let manifest: { name?: string; delorun?: { pack?: boolean } }
    try {
      manifest = JSON.parse(readFileSync(join(PACKAGES, folder, 'package.json'), 'utf8')) as typeof manifest
    } catch (error) {
      // A folder without a package.json is no package, so it holds no pack.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (manifest.delorun?.pack !== true || manifest.name === undefined) continue
    const patch = readFileSync(join(PACKAGES, folder, 'cordis.patch.yml'), 'utf8')
    for (const match of patch.matchAll(/^\s*name:\s*'?([^'\s]+)'?\s*$/gmu)) {
      const module = match[1] ?? ''
      if (!module.startsWith('cordis:')) rows.set(module, manifest.name)
    }
  }
  return rows
}

describe('the pack plugin list', () => {
  it('matches the rows of every pack\'s patch file', () => {
    expect([...PACK_PLUGINS].sort()).toEqual([...packRows()].sort())
  })
})
