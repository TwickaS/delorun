/**
 * The rule that lets a production-channel launcher install a release built on the maintainer's PC (A369, A506, L196):
 * a 0.x release under a root chain that holds the pinned preview root, by the digest of the exact file the walk
 * verified, whose verifying root keeps the pinned root's active targets key. Every root here is a throwaway one,
 * walked as the launcher walks it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RootMetadata, SemanticVersion, UtcTimestamp } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { publicKeyEntry } from '@delorun/release-formats/sign/envelope'
import { walkRootChain } from '@delorun/release-formats/sign/verify'
import { localBuilderAllowed, PREVIEW_ROOT_SHA256 } from '../src/local-builder.ts'
import { envelope, fixtureKeys, nextRoot, rootMetadataFor, sha256, type FixtureKeys } from './support.ts'

/**
 * Root 1, a root 2 that root 1 signs and that the spec pins, and a root 3 that root 2 signs with the same keys.
 * @returns the keys and the three root files.
 */
function pinnedChain(): { keys: FixtureKeys, one: Buffer, two: Buffer, three: Buffer, metadata: RootMetadata } {
  const keys = fixtureKeys()
  const metadata = rootMetadataFor(keys)
  const one = envelope(metadata, [keys.root])
  const two = nextRoot(metadata, keys, [keys.root])
  const three = nextRoot({ ...metadata, version: 2 }, keys, [keys.root])
  return { keys, one, two, three, metadata }
}

describe('localBuilderAllowed', () => {
  it('pins the digest of root 1 that the trust page publishes', () => {
    const page = readFileSync(new URL('../../../docs/guide/safety-and-updates/trust.md', import.meta.url), 'utf8')
    expect(page).toContain(`| Release root 1, SHA-256 of \`1.root.json\` | \`${PREVIEW_ROOT_SHA256}\` |`)
  })

  it.each(['0.1.0', '0.1.0-preview.2.7', '0.9.9'])('allows %s under the pinned root', (version) => {
    const { one, two } = pinnedChain()
    expect(localBuilderAllowed(version, walkRootChain([one, two]), [sha256(two)])).toBe(true)
  })

  it.each(['1.0.0', '1.0.0-rc.1', '1.0.0-preview.1', '2.0.0', '0.1', 'v0.1.0', '', ' 0.1.0', '0.1.0\n', '0.1.0+meta', '00.1.0'])('local-builder-refuses-1x: refuses the version "%s" under the pinned chain', (version) => {
    const { one, two, three } = pinnedChain()
    expect(localBuilderAllowed(version, walkRootChain([one, two, three]), [sha256(two)])).toBe(false)
  })

  it('local-builder-accepts-later-root: allows a 0.x release under a root 3 that chains from the pinned root 2 and keeps its targets key', () => {
    const { one, two, three } = pinnedChain()
    expect(localBuilderAllowed('0.1.0', walkRootChain([one, two, three]), [sha256(two)])).toBe(true)
    expect(localBuilderAllowed('0.1.0', walkRootChain([two, three]), [sha256(two)])).toBe(true)
  })

  it('local-builder-refuses-other-root-2: refuses a root 2 that chains from root 1 but is not the pinned file, and a chain that never reaches the pinned root', () => {
    const { keys, one, two, metadata } = pinnedChain()
    const other = nextRoot(metadata, keys, [keys.root], next => ({ ...next, expires: brandString<UtcTimestamp>(new Date(Date.parse(next.expires) - 1000).toISOString().replace('.000Z', 'Z')) }))
    expect(sha256(other)).not.toBe(sha256(two))
    const otherChain = walkRootChain([one, other])
    expect(otherChain.at(-1)!.metadata.version).toBe(2)
    expect(localBuilderAllowed('0.1.0', otherChain, [sha256(two)])).toBe(false)
    expect(localBuilderAllowed('0.1.0', walkRootChain([one]), [sha256(two)])).toBe(false)
    expect(localBuilderAllowed('0.1.0', walkRootChain([one, two]), [PREVIEW_ROOT_SHA256])).toBe(false)
  })

  it('local-builder-refuses-unchained-root-3: a root 3 that root 2\'s root keys did not sign never forms a chain to allow under', () => {
    const { keys, one, two } = pinnedChain()
    const stranger = fixtureKeys()
    const forged = nextRoot({ ...rootMetadataFor(keys), version: 2 }, keys, [stranger.root])
    expect(() => walkRootChain([one, two, forged])).toThrow()
  })

  it('local-builder-ends-with-new-targets-key: refuses a root that names another active targets key, as the 1.0 ceremony\'s does', () => {
    const { keys, one, two, metadata } = pinnedChain()
    const ceremony = fixtureKeys()
    const newTargets = publicKeyEntry(ceremony.targets)
    const three = nextRoot({ ...metadata, version: 2 }, keys, [keys.root], next => ({
      ...next,
      keys: { ...next.keys, [newTargets.keyid]: newTargets.entry },
      roles: { ...next.roles, targets: { keys: [...next.roles.targets.keys.map(key => ({ ...key, status: 'retired' as const, lastRelease: brandString<SemanticVersion>('0.9.9') })), { keyid: newTargets.keyid, status: 'active' as const }], threshold: 1 } },
    }))
    expect(localBuilderAllowed('0.1.0', walkRootChain([one, two, three]), [sha256(two)])).toBe(false)
  })
})
