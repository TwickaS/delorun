/**
 * The rule that lets a production-channel launcher install a release built on the maintainer's PC (A369, A506): a 0.x
 * release under the preview root, and nothing else.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TrustedRoot } from '@delorun/release-formats/sign/verify'
import { localBuilderAllowed, PREVIEW_ROOT_SHA256 } from '../src/local-builder.ts'

/**
 * A root as the chain walk returns it.
 * @param version - the root version.
 * @param sha256 - the digest of its file.
 * @returns the root; only the fields the rule reads are real.
 */
function rootOf(version: number, sha256: string): TrustedRoot {
  return { metadata: { version }, sha256 } as TrustedRoot
}

describe('localBuilderAllowed', () => {
  it('pins the digest of root 1 that the trust page publishes', () => {
    const page = readFileSync(new URL('../../../docs/guide/safety-and-updates/trust.md', import.meta.url), 'utf8')
    expect(page).toContain(`| Release root 1, SHA-256 of \`1.root.json\` | \`${PREVIEW_ROOT_SHA256}\` |`)
  })

  it.each(['0.1.0', '0.1.0-preview.2.7', '0.9.9'])('allows %s under the preview root', (version) => {
    expect(localBuilderAllowed(version, rootOf(1, PREVIEW_ROOT_SHA256))).toBe(true)
  })

  it.each(['1.0.0', '1.0.0-rc.1', '1.0.0-preview.1', '2.0.0', '0.1', 'v0.1.0', '', ' 0.1.0', '0.1.0\n', '0.1.0+meta', '00.1.0'])('refuses the version "%s" under the preview root', (version) => {
    expect(localBuilderAllowed(version, rootOf(1, PREVIEW_ROOT_SHA256))).toBe(false)
  })

  it('refuses a later root with the same digest, and root 1 with another digest', () => {
    expect(localBuilderAllowed('0.1.0', rootOf(2, PREVIEW_ROOT_SHA256))).toBe(false)
    expect(localBuilderAllowed('0.1.0', rootOf(1, 'f'.repeat(64)))).toBe(false)
  })

  it('takes the digests a spec supplies in place of the published one', () => {
    expect(localBuilderAllowed('0.1.0', rootOf(1, 'a'.repeat(64)), ['a'.repeat(64)])).toBe(true)
    expect(localBuilderAllowed('0.1.0', rootOf(1, PREVIEW_ROOT_SHA256), ['a'.repeat(64)])).toBe(false)
    expect(localBuilderAllowed('1.0.0', rootOf(1, 'a'.repeat(64)), ['a'.repeat(64)])).toBe(false)
  })
})
