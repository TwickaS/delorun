/**
 * The running release's packs as the composition reads them (`delorun/apps/cli/src/release-packs.ts`): none outside an
 * installed release, and a refusal that names the remedy when the release cannot be verified.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliError } from '../src/exit.ts'
import { NO_RELEASE_PACKS, runningReleasePacks } from '../src/release-packs.ts'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

/** @returns a fresh, empty home. */
function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'delorun-release-packs-'))
  homes.push(path)
  return path
}

describe('the running release\'s packs', () => {
  it('are none outside an installed release, and none for a composition without packs', async () => {
    expect(await runningReleasePacks({ home: home(), env: {} })).toEqual(new Map())
    expect(await runningReleasePacks({ home: home(), env: { DELORUN_VERSION: '0.1.0' } })).toEqual(new Map())
    expect(await NO_RELEASE_PACKS({ home: home(), env: {} })).toEqual(new Map())
  })

  it('refuse the start, naming the remedy, when the installed release cannot be verified', async () => {
    const root = home()
    const error: unknown = await runningReleasePacks({ home: root, env: { DELORUN_VERSION: '0.1.0', DELORUN_LAUNCHER_ROOTS: join(root, 'no-roots') } }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toContain('the running release\'s plugin packs file could not be verified')
    expect((error as CliError).message).toContain('To fix it, run: delorun recover packs')
  })
})
