/**
 * A `headless` profile that upstream's `dsh` created before Delo's headless bundle was linked into it, with a row the
 * person added: the real `profile-migrations` pre-start step for `delorun headless` links the bundle through upstream's
 * resolution and `dsh plugin add`, records `headless-bundle` in the profile's migration record, and leaves the person's
 * files as they were. The step runs `pnpm`, so the spec is an integration spec.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_BUNDLE } from '@delo/bundle-local/profile'
import { HEADLESS_PROFILE } from '@delo/contract-home-layout'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { main } from '../src/main.ts'
import { EXIT } from '../src/exit.ts'
import { migrationsPath } from '../src/profile-migrations.ts'
import { runPreStartSteps } from '../src/pre-start.ts'
import { upstreamDependencies } from '../src/start.ts'

let osHome: string
let deloHome: string
let context: CommandContext
let stderr: string[]

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-headless-bundle-')))
  deloHome = join(osHome, '.delo')
  stderr = []
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DSH_HOME', join(osHome, '.dsh'))
  vi.stubEnv('DELO_HOME', undefined)
  vi.stubEnv('DELO_PROFILE', undefined)
  context = { env: { HOME: osHome, DSH_HOME: join(osHome, '.dsh'), DEEPSEEK_API_KEY: 'fixture-key' }, stdout: () => undefined, stderr: (text) => { stderr.push(text) } }
  expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
  await prepareHome(context, undefined)
}, 60_000)

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

describe('the headless profile\'s pre-start migration', { timeout: 120_000 }, () => {
  it('links the bundle into a profile upstream created without it, records the change, and keeps the person\'s own row', async () => {
    const dependencies = upstreamDependencies()
    await dependencies.prepareProfile(HEADLESS_PROFILE)
    const profileDirectory = join(deloHome, 'profiles', HEADLESS_PROFILE)
    const manifestPath = join(profileDirectory, 'package.json')
    const bundlesBefore = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
    expect(bundlesBefore).not.toContain(HEADLESS_BUNDLE)
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const mine = '- id: my-own-row\n  disabled: true\n'
    writeFileSync(patchPath, mine)

    await runPreStartSteps(dependencies.preStartSteps, { home: deloHome, profile: HEADLESS_PROFILE, kind: 'headless', successor: false, output: context })

    const bundlesAfter = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
    expect(bundlesAfter).toEqual([...bundlesBefore, HEADLESS_BUNDLE])
    expect((JSON.parse(readFileSync(migrationsPath(deloHome, HEADLESS_PROFILE), 'utf8')) as { done: string[] }).done).toEqual(['headless-bundle', 'pnpm-copy-import'])
    expect(readFileSync(patchPath, 'utf8')).toBe(mine)
    expect(stderr.join('')).toContain('added Delo\'s guards to the headless profile')
  })
})
