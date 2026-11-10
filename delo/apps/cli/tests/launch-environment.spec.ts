/**
 * The launch environment of a Host Delo boots (`delo/apps/cli/src/launch-environment.ts`): upstream's `.env` layers
 * load, and a layer that sets a `DELO_` name, such as the launcher's release roots, is refused before any layer applies.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELO_LAUNCHER_ROOTS_ENV } from '@delo/contract-home-layout'
import { CliError } from '../src/exit.ts'
import { loadDeloEnvironment } from '../src/launch-environment.ts'

let root: string
let project: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delorun-launch-env-'))
  project = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(project)
  mkdirSync(home, { mode: 0o700 })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv(DELO_LAUNCHER_ROOTS_ENV, undefined)
  vi.stubEnv('DELO_FIXTURE_SETTING', undefined)
  vi.stubEnv('FIXTURE_PROJECT_SETTING', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/**
 * Expect the load to refuse.
 * @returns the refusal's message.
 */
function refusal(): string {
  let error: unknown
  try {
    loadDeloEnvironment(project)
  } catch (thrown) {
    error = thrown
  }
  expect(error).toBeInstanceOf(CliError)
  return (error as CliError).message
}

describe('loading the launch environment', () => {
  it('refuses a working directory .env that supplies the launcher\'s release roots, and applies none of its names', () => {
    writeFileSync(join(project, '.env'), `FIXTURE_PROJECT_SETTING=1\n${DELO_LAUNCHER_ROOTS_ENV}=${join(root, 'planted-roots')}\n`)
    expect(refusal()).toContain(`${join(project, '.env')} sets ${DELO_LAUNCHER_ROOTS_ENV}, which only the environment delorun was started with may set`)
    expect(process.env[DELO_LAUNCHER_ROOTS_ENV]).toBeUndefined()
    expect(process.env.FIXTURE_PROJECT_SETTING).toBeUndefined()
  })

  it('refuses a DELO_ name in the harness home\'s .env, whatever its case', () => {
    writeFileSync(join(home, '.env'), 'delo_fixture_setting=1\n', { mode: 0o600 })
    expect(refusal()).toContain(`${join(home, '.env')} sets delo_fixture_setting`)
  })

  it('loads layers without a DELO_ name as upstream does', () => {
    writeFileSync(join(project, '.env'), 'FIXTURE_PROJECT_SETTING=1\n')
    loadDeloEnvironment(project)
    expect(process.env.FIXTURE_PROJECT_SETTING).toBe('1')
    expect(() => loadDeloEnvironment(join(root, 'no-such-directory'))).not.toThrow()
  })
})
