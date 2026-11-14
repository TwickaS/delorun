/**
 * Foreign prebuilds in a staged closure. A few packages carry native prebuilds for every platform inside their main
 * package, so the Linux closure holds code it never loads and `prebuilt-pins.json` would have to pin it. `closure.json`
 * names each such package and the foreign platform directories to drop; the build removes exactly those, before the
 * native-code check, so every other native file still has to be pinned (contract C2).
 *
 * @module @delo/release/closure/prune
 */
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimePlatform } from '@delo/contract-release-manifest'
import type { ClosureRecipe } from './config.ts'

/**
 * Remove the listed foreign prebuild directories from a staged closure's `app/node_modules`.
 * @param stage - the staged closure.
 * @param platform - the closure's platform; a directory named for it is never removed.
 * @param rules - `closure.json`'s `foreignPrebuilds`.
 * @param log - receives one line per removed directory.
 * @returns the removed directories, relative to the stage.
 */
export async function pruneForeignPrebuilds(stage: string, platform: RuntimePlatform, rules: ClosureRecipe['foreignPrebuilds'], log: (line: string) => void): Promise<string[]> {
  const removed: string[] = []
  for (const rule of rules) {
    for (const foreign of rule.platforms) {
      if (foreign === platform) continue
      const relative = `app/node_modules/${rule.package}/${rule.directory}/${foreign}`
      const absolute = join(stage, relative)
      const present = await stat(absolute).then(info => info.isDirectory(), () => false)
      if (!present) continue
      await rm(absolute, { recursive: true })
      log(`build-closure: ${platform}: pruned foreign prebuild ${relative}`)
      removed.push(relative)
    }
  }
  return removed
}
