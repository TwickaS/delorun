/**
 * The terminal switch store: off until it holds a readable record that says on, read again when another profile of
 * the home changes the file, and off for every file it cannot trust.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REACH_TERMINAL_VERSION, ReachTerminalStore } from '../src/reach-terminal.ts'

let directory = ''
let file = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delo-reach-terminal-store-'))
  file = join(directory, 'reach-terminal.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('the terminal switch store', () => {
  it('is off without a file, and holds what it writes', async () => {
    const store = new ReachTerminalStore(file)
    expect(store.withoutUnlock()).toBe(false)
    await store.set(true, 'computer')
    expect(store.withoutUnlock()).toBe(true)
    await store.set(false, 'computer')
    expect(store.withoutUnlock()).toBe(false)
  })

  it('records who turned the switch on and clears the record when it turns off', async () => {
    const store = new ReachTerminalStore(file)
    await store.set(true, 'device')
    expect([store.withoutUnlock(), store.setByDevice()]).toEqual([true, true])
    await store.set(true, 'computer')
    expect([store.withoutUnlock(), store.setByDevice()]).toEqual([true, false])
    await store.set(false, 'device')
    expect([store.withoutUnlock(), store.setByDevice()]).toEqual([false, false])
  })

  it('reads a change another profile of the home wrote', async () => {
    const mine = new ReachTerminalStore(file)
    const other = new ReachTerminalStore(file)
    expect(mine.withoutUnlock()).toBe(false)
    // Pins the identity check: a store that kept its first read would miss the other profile's change.
    await other.set(true, 'computer')
    expect(mine.withoutUnlock()).toBe(true)
  })

  it('reads off from a file it cannot trust', async () => {
    const store = new ReachTerminalStore(file)
    // Pins the protected-file rule: a file other users can read is refused, and the unlock stays.
    await writeFile(file, JSON.stringify({ v: REACH_TERMINAL_VERSION, withoutUnlock: true }), { mode: 0o644 })
    await chmod(file, 0o644)
    expect(store.withoutUnlock()).toBe(false)
    for (const text of ['not json', '"on"', 'null', JSON.stringify({ v: 2, withoutUnlock: true }), JSON.stringify({ v: REACH_TERMINAL_VERSION, withoutUnlock: 'true' })]) {
      await rm(file)
      await writeFile(file, text, { mode: 0o600 })
      expect(new ReachTerminalStore(file).withoutUnlock(), text).toBe(false)
    }
  })
})
