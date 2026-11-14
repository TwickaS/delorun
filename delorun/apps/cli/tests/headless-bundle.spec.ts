/**
 * Delorun's headless bundle in the home's `headless` profile (`delorun/apps/cli/src/headless-bundle.ts`): linking it names
 * the bundle in the profile's list only when it was missing, and its one-time change `headless-bundle` runs once,
 * records itself in the profile's migration record, and records nothing when linking fails.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HEADLESS_BUNDLE } from '@delorun/bundle-local/profile'
import { HEADLESS_PROFILE } from '@delorun/contract-home-layout'
import type { SurfaceLog } from '@delorun/logs'
import type { BundleLinking, LinkReport } from '../src/delorun-bundles.ts'
import { addHeadlessBundle, HEADLESS_BUNDLE_MIGRATION, headlessBundleMigration } from '../src/headless-bundle.ts'
import { migrationsPath, runProfileMigrations } from '../src/profile-migrations.ts'
import { openSetupLog } from '../src/setup/index.ts'

let home: string
let log: SurfaceLog
let report: LinkReport

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-headless-bundle-'))
  log = openSetupLog(home, HEADLESS_PROFILE)
  report = { log, progress: () => undefined }
})
afterEach(() => {
  log.close()
  rmSync(home, { recursive: true, force: true })
})

/**
 * Write the headless profile's manifest with a bundle list.
 * @param bundles - the bundle names.
 */
function manifest(bundles: readonly string[]): void {
  mkdirSync(join(home, 'profiles', HEADLESS_PROFILE), { recursive: true })
  writeFileSync(join(home, 'profiles', HEADLESS_PROFILE, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
}

/**
 * A linking whose resolution supplies nothing, so the bundle is added with `dsh plugin add link:`.
 * @param calls - collects each plugin command's arguments.
 * @returns the linking.
 */
function linking(calls: (readonly string[])[]): BundleLinking {
  return {
    installAnchor: '/install/package.json',
    resolve: () => Promise.resolve({ profile: { layers: [] }, resolution: { entries: [], localPackageNames: [] } } as never),
    runPluginCommand: (_context, args) => { calls.push(args); return Promise.resolve({ exitCode: 0, logPath: '/log' }) },
  }
}

/**
 * The migrations a profile has recorded.
 * @returns the ids in the record, or none when the record does not exist.
 */
function recorded(): readonly string[] {
  try {
    return (JSON.parse(readFileSync(migrationsPath(home, HEADLESS_PROFILE), 'utf8')) as { done: string[] }).done
  } catch {
    // No record file: no migration completed.
    return []
  }
}

describe('adding the headless bundle', () => {
  it('links it into a profile whose list lacks it, reports that it was added, and links the bundle\'s directory', async () => {
    manifest(['@deepseek-ai/dsh-base'])
    const calls: (readonly string[])[] = []
    expect(await addHeadlessBundle(home, () => Promise.resolve(linking(calls)), report)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('add')
    expect(calls[0]?.[1]).toMatch(/^link:.*bundle-headless\/$/u)
  })

  it('links it into a profile that does not exist yet, which counts as lacking it', async () => {
    expect(await addHeadlessBundle(home, () => Promise.resolve(linking([])), report)).toBe(true)
  })

  it('reports that nothing was added when the list already names the bundle', async () => {
    manifest(['@deepseek-ai/dsh-base', HEADLESS_BUNDLE])
    expect(await addHeadlessBundle(home, () => Promise.resolve(linking([])), report)).toBe(false)
  })
})

describe('the headless-bundle migration', () => {
  it('records itself in the headless profile\'s record, tells the person, and never calls the adder again', async () => {
    const text: string[] = []
    let calls = 0
    const migration = headlessBundleMigration(() => { calls++; return Promise.resolve(true) }, { stdout: () => undefined, stderr: (line) => { text.push(line) } })
    mkdirSync(join(home, 'profiles', HEADLESS_PROFILE), { recursive: true })
    expect(await runProfileMigrations(home, HEADLESS_PROFILE, [migration], { stdout: () => undefined, stderr: () => undefined })).toEqual([HEADLESS_BUNDLE_MIGRATION])
    expect(recorded()).toEqual(['headless-bundle'])
    expect(text.join('')).toContain('added Delorun\'s safety checks to the headless profile')
    expect(await runProfileMigrations(home, HEADLESS_PROFILE, [migration], { stdout: () => undefined, stderr: () => undefined })).toEqual([])
    expect(calls).toBe(1)
  })

  it('completes quietly when the profile already had the bundle', async () => {
    const text: string[] = []
    const migration = headlessBundleMigration(() => Promise.resolve(false), { stdout: () => undefined, stderr: (line) => { text.push(line) } })
    mkdirSync(join(home, 'profiles', HEADLESS_PROFILE), { recursive: true })
    expect(await runProfileMigrations(home, HEADLESS_PROFILE, [migration], { stdout: () => undefined, stderr: () => undefined })).toEqual([HEADLESS_BUNDLE_MIGRATION])
    expect(text).toEqual([])
  })

  it('stops the run with the adder\'s error and records nothing, so the next run tries again', async () => {
    const failure = new Error('pnpm exited 1')
    let calls = 0
    const migration = headlessBundleMigration(() => { calls++; return Promise.reject(failure) }, { stdout: () => undefined, stderr: () => undefined })
    mkdirSync(join(home, 'profiles', HEADLESS_PROFILE), { recursive: true })
    await expect(runProfileMigrations(home, HEADLESS_PROFILE, [migration], { stdout: () => undefined, stderr: () => undefined })).rejects.toBe(failure)
    expect(recorded()).toEqual([])
    await expect(runProfileMigrations(home, HEADLESS_PROFILE, [migration], { stdout: () => undefined, stderr: () => undefined })).rejects.toBe(failure)
    expect(calls).toBe(2)
  })
})
