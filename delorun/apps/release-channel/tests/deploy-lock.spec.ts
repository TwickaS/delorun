/** The deploy workspace's lockfile: Effect packages that Alchemy loads at run time resolve to one version. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const lock = readFileSync(new URL('../deploy/pnpm-lock.yaml', import.meta.url), 'utf8')

/** The versions the lockfile's `packages:` section records for a package name. */
function versionsOf(name: string): string[] {
  const escaped = name.replace(/\./gu, '\\.')
  return [...new Set([...lock.matchAll(new RegExp(`^  '?${escaped}@([^'(:]+)'?:`, 'gmu'))].map((m) => m[1] ?? ''))]
}

describe('release-channel deploy lockfile', () => {
  it('resolves @effect/platform-node-shared and @effect/sql-d1 to the version of effect and @effect/platform-node, so Alchemy loads', () => {
    expect(versionsOf('@effect/platform-node-shared')).toEqual(['4.0.7'])
    expect(versionsOf('@effect/sql-d1')).toEqual(['4.0.7'])
    expect(versionsOf('effect')).toEqual(['4.0.7'])
  })
})
