/**
 * Foreign prebuilds in a staged closure. A few packages carry native prebuilds for every platform inside their main
 * package, so the Linux closure holds code it never loads and `prebuilt-pins.json` would have to pin it. `closure.json`
 * names each such package and the foreign platform directories to drop; the build removes exactly those, before the
 * native-code check, so every other native file still has to be pinned (contract C2).
 *
 * Every listed directory must exist in the staged closure, and every target must resolve, through any symlinks, to a
 * location inside its package. Otherwise the build fails before it removes anything.
 *
 * @module @delorun/release/closure/prune
 */
import { realpath, rm, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'
import type { ClosureRecipe } from './config.ts'

/**
 * A prune rule that cannot be applied to the staged closure.
 *
 * - `missing-directory`: the listed platform directory is absent from the package.
 * - `escapes-package`: the directory, or a symlink on its path, resolves outside the package.
 */
export class PruneRuleError extends Error {
  /** Which rule failed. */
  readonly code: 'missing-directory' | 'escapes-package'

  /**
   * @param code - the failed rule.
   * @param message - the actionable message, naming the package and directory.
   */
  constructor(code: PruneRuleError['code'], message: string) {
    super(message)
    this.name = 'PruneRuleError'
    this.code = code
  }
}

/**
 * Remove the listed foreign prebuild directories from a staged closure's `app/node_modules`.
 * @param stage - the staged closure.
 * @param platform - the closure's platform; a directory named for it is never removed.
 * @param rules - `closure.json`'s `foreignPrebuilds`.
 * @param log - receives one line per removed directory.
 * @returns the removed directories, relative to the stage.
 * @throws PruneRuleError `missing-directory` when a listed foreign directory is absent, or `escapes-package` when one
 *   resolves outside its package; nothing is removed when any rule fails.
 */
export async function pruneForeignPrebuilds(stage: string, platform: RuntimePlatform, rules: ClosureRecipe['foreignPrebuilds'], log: (line: string) => void): Promise<string[]> {
  const targets: { relative: string, absolute: string, rule: ClosureRecipe['foreignPrebuilds'][number] }[] = []
  for (const rule of rules) {
    const packageRoot = join(stage, 'app/node_modules', rule.package)
    for (const foreign of rule.platforms) {
      if (foreign === platform) continue
      const relative = `app/node_modules/${rule.package}/${rule.directory}/${foreign}`
      const absolute = join(stage, relative)
      const realPackage = await realpath(packageRoot).catch(() => undefined)
      if (realPackage === undefined) {
        throw new PruneRuleError('missing-directory', `closure.json lists ${rule.package} as a package with foreign prebuilds, but app/node_modules/${rule.package} is not in the staged closure`)
      }
      const isDirectory = await stat(absolute).then(info => info.isDirectory(), () => false)
      if (!isDirectory) {
        throw new PruneRuleError('missing-directory', `closure.json lists ${rule.package} ${rule.directory}/${foreign} as a foreign prebuild, but ${relative} is not a directory in the staged closure`)
      }
      const realTarget = await realpath(absolute)
      if (!realTarget.startsWith(realPackage + sep)) {
        throw new PruneRuleError('escapes-package', `closure.json's foreign prebuild ${rule.package} ${rule.directory}/${foreign} resolves to ${realTarget}, outside the package at ${realPackage}; the rule is refused`)
      }
      targets.push({ relative, absolute, rule })
    }
  }
  const removed: string[] = []
  for (const target of targets) {
    await rm(target.absolute, { recursive: true })
    log(`build-closure: ${platform}: pruned foreign prebuild ${target.relative}`)
    removed.push(target.relative)
  }
  return removed
}
