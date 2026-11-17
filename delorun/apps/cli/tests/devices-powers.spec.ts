/**
 * `delorun devices powers`: it shows the level in force, writes the person's choice to the home-auth record, and needs a
 * terminal to choose Full, so a script cannot widen what a phone may do.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPhonePowers, recordUpgradePhonePowers } from '@delorun/home-auth'
import type { CommandContext } from '../src/command.ts'
import { runPowers } from '../src/devices/powers.ts'
import { EXIT } from '../src/exit.ts'

let home: string
let printed: string[]
let errors: string[]
let context: CommandContext

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-powers-'))
  printed = []
  errors = []
  context = { stdout: text => { printed.push(text) }, stderr: text => { errors.push(text) }, env: {} } as CommandContext
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** The home-auth secrets directory of the test home. */
const secrets = (): string => join(home, 'secrets', 'home-auth')

describe('delorun devices powers', () => {
  it('shows the level in force and whether it was chosen', async () => {
    expect(await runPowers(home, [], context)).toBe(EXIT.ok)
    expect(printed.join('')).toMatch(/^Phone powers: Careful \(not chosen yet\)\nCareful: /u)
    // The level the first start records in an existing home is still not chosen.
    mkdirSync(secrets(), { recursive: true, mode: 0o700 })
    await recordUpgradePhonePowers(secrets(), 'careful')
    printed.length = 0
    expect(await runPowers(home, [], context)).toBe(EXIT.ok)
    expect(printed.join('')).toMatch(/^Phone powers: Careful \(not chosen yet\)\n/u)
  })

  it('chooses Careful without a terminal, and Full only at one', async () => {
    expect(await runPowers(home, ['careful'], context, { isTTY: false })).toBe(EXIT.ok)
    expect(await readPhonePowers(secrets())).toEqual({ level: 'careful', chosen: true })
    // Pins the terminal check: a script cannot widen what a phone may do.
    await expect(runPowers(home, ['full'], context, { isTTY: false })).rejects.toMatchObject({ exit: EXIT.failed })
    expect(await readPhonePowers(secrets())).toEqual({ level: 'careful', chosen: true })
    expect(await runPowers(home, ['full'], context, { isTTY: true })).toBe(EXIT.ok)
    expect(await readPhonePowers(secrets())).toEqual({ level: 'full', chosen: true })
    printed.length = 0
    expect(await runPowers(home, [], context)).toBe(EXIT.ok)
    expect(printed.join('')).toMatch(/^Phone powers: Full\nFull: /u)
  })

  it('refuses another level or a second argument as a usage error, and names a record it cannot read', async () => {
    for (const args of [['everything'], ['full', 'now']]) {
      await expect(runPowers(home, args, context, { isTTY: true }), args.join(' ')).rejects.toMatchObject({ exit: EXIT.usage })
    }
    expect(await runPowers(home, ['careful'], context)).toBe(EXIT.ok)
    rmSync(join(secrets(), 'phone-powers.json'))
    writeFileSync(join(secrets(), 'phone-powers.json'), 'not json', { mode: 0o600 })
    expect(await runPowers(home, [], context)).toBe(EXIT.failed)
    expect(errors.join('')).toContain('Careful applies until you choose again.')
  })
})
