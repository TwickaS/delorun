/**
 * The `pairing` choices of the profile's `delorun-home-auth` row: what setup writes, what `reach status` reads, and that a
 * write keeps the bundle's `!!js` expression, other rows, other pairing fields and comments.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PAIRING_DEFAULTS } from '@delorun/home-auth'
import { SetupApplyError } from '../src/errors.ts'
import { readPairingAt, writeMayAskAt } from '../src/pairing-row.ts'

let directory = ''
let path = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-pairing-row-'))
  path = join(directory, 'cordis.patch.yml')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the pairing row', () => {
  it('reads Delorun\'s defaults from a profile that sets none', () => {
    expect(readPairingAt(path)).toEqual(PAIRING_DEFAULTS)
    writeFileSync(path, '- id: delorun-reach\n  config:\n    enabled: true\n')
    expect(readPairingAt(path)).toEqual(PAIRING_DEFAULTS)
  })

  it('creates a row that sets the pairing choice alone, so the plugin takes the home\'s own secrets directory', () => {
    writeMayAskAt(path, 'tailnet')
    const text = readFileSync(path, 'utf8')
    // Pins the omitted directory: a restated `!!js` expression would not survive the next rewrite of the patch.
    expect(text).not.toContain('secretsDirectory')
    expect(text).toContain('mayAskWithoutWindow: tailnet')
    expect(readPairingAt(path).mayAskWithoutWindow).toBe('tailnet')
  })

  it('changes only the choice of an existing row and keeps other rows and other fields', () => {
    writeFileSync(path, [
      '# my profile',
      '- id: delorun-reach',
      '  config:',
      '    enabled: true',
      '- id: delorun-home-auth',
      '  name: "@delorun/home-auth"',
      '  config:',
      '    pairing:',
      '      showRequest: dialog',
      '      windowMinutes: 9',
      '',
    ].join('\n'))
    writeMayAskAt(path, 'own-user')
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('id: delorun-reach')
    expect(readPairingAt(path)).toMatchObject({ mayAskWithoutWindow: 'own-user', showRequest: 'dialog', windowMs: 9 * 60_000 })
  })

  it('refuses a file that is not a patch list and leaves it unchanged', () => {
    writeFileSync(path, 'a: b\n')
    expect(() => { writeMayAskAt(path, 'tailnet') }).toThrow(SetupApplyError)
    expect(readFileSync(path, 'utf8')).toBe('a: b\n')
  })

  it('names a value out of bounds when it reads the row', () => {
    writeFileSync(path, "- id: delorun-home-auth\n  config:\n    pairing:\n      windowMinutes: 99\n")
    // Pins the fail-loud read: `reach status` reports the bound instead of printing a default.
    expect(() => readPairingAt(path)).toThrow('pairing.windowMinutes must be a whole number from 1 to 15')
  })
})
