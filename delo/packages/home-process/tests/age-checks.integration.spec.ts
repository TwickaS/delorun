/**
 * The home process's hourly log age check (contract C20, "Rotation and retention"): a home process that keeps running
 * deletes the records it kept past 14 days at the first check after they expire, without a `delorun` command, and stops
 * checking when it stops.
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGE_CHECK_INTERVAL_MS, RETENTION_MS } from '@delo/contract-operational-logs'
import { resolveSurface } from '@delo/logs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FixtureStore, installFixture, PROFILE, startHome, tempHome, V1, type InProcessHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
let running: InProcessHome | undefined
afterEach(async () => {
  vi.useRealTimers()
  await running?.process.shutdown(0)
  running?.exit()
  running = undefined
  temp?.remove()
  temp = undefined
})

/** A rotated file of the profile's home log whose only record was written at `writtenAt`. */
function rotatedFile(home: string, number: number, writtenAt: number): string {
  const { dir, file } = resolveSurface({ kind: 'home', home, profile: PROFILE })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = `${file}.${String(number)}`
  const record = { ts: new Date(writtenAt).toISOString(), level: 'info', surface: `home-${PROFILE}`, pid: 1, logger: 'earlier', source: 'delo', msg: 'earlier run' }
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  return path
}

describe('the home process age check', () => {
  it('deletes a file at the first hourly check after its records are 14 days old, and stops with the process', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    temp = await tempHome()
    installFixture(temp.home, V1)
    await FixtureStore.seed(temp.home, V1)
    let clock = Date.UTC(2026, 10, 1)
    const fresh = rotatedFile(temp.home, 1, clock - 1000)
    const almost = rotatedFile(temp.home, 2, clock - RETENTION_MS + AGE_CHECK_INTERVAL_MS - 5000)
    running = await startHome(temp.home, { now: () => clock })
    expect(existsSync(fresh), 'a recent file stays at the start check').toBe(true)
    expect(existsSync(almost), 'a file that expires within the hour stays at the start check').toBe(true)
    clock += AGE_CHECK_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(AGE_CHECK_INTERVAL_MS)
    expect(existsSync(almost), 'the hourly check deletes it once it is past 14 days').toBe(false)
    expect(existsSync(fresh)).toBe(true)
    const stopped = rotatedFile(temp.home, 3, clock - RETENTION_MS - 1000)
    await running.process.shutdown(0)
    clock += AGE_CHECK_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(AGE_CHECK_INTERVAL_MS * 3)
    expect(existsSync(stopped), 'a stopped process runs no more checks').toBe(true)
    expect(existsSync(join(temp.home, 'logs'))).toBe(true)
  })

  it('checks at its start, so a file already past 14 days goes before the first hour', async () => {
    temp = await tempHome()
    installFixture(temp.home, V1)
    await FixtureStore.seed(temp.home, V1)
    const clock = Date.UTC(2026, 10, 1)
    const old = rotatedFile(temp.home, 1, clock - RETENTION_MS - 1000)
    running = await startHome(temp.home, { now: () => clock })
    expect(existsSync(old)).toBe(false)
  })
})
