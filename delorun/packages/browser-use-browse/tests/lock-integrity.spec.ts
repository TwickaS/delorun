/** Specs of the proof script's lockfile integrity lookup. */
import { describe, expect, it } from 'vitest'
import { lockIntegrity } from '../scripts/lock-integrity.ts'

const LOCK = [
  'packages:',
  '',
  "  '@opencode/browse-windows-x64@0.1.1':",
  '    resolution: {integrity: sha512-windows+/=}',
  '',
  "  '@opencode/browse-windows-x64@0.1.10':",
  '    resolution: {integrity: sha512-later}',
  '',
].join('\n')

describe('lockIntegrity', () => {
  it('reads a scoped, hyphenated package version', () => {
    expect(lockIntegrity(LOCK, '@opencode/browse-windows-x64', '0.1.1')).toBe('sha512-windows+/=')
  })

  it('matches the version literally, not as a pattern', () => {
    expect(() => lockIntegrity(LOCK, '@opencode/browse-windows-x64', '0.1.')).toThrow('pnpm-lock.yaml pins no @opencode/browse-windows-x64@0.1.')
    expect(() => lockIntegrity(LOCK, '@opencode/browse-windows-x64', '0x1x1')).toThrow('pins no')
  })
})
