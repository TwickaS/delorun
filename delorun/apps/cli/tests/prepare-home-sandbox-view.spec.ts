/**
 * The home-mode skip of `prepareHome` (`delorun/apps/cli/src/command.ts`): only a caller that opts in skips the mode
 * bits inside a Delorun chat sandbox; `start`, `setup` and `update` always check, so they refuse a 0755 home even with the
 * launcher marker and process 1 = bubblewrap.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@delorun/home', async importOriginal => {
  const actual = await importOriginal<typeof import('@delorun/home')>()
  return { ...actual, insideBwrapSandbox: () => true }
})

const { prepareHome } = await import('../src/command.ts')

let root: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delorun-prepare-home-'))
  home = join(root, 'home')
  mkdirSync(home, { mode: 0o700 })
  chmodSync(home, 0o755)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const context = (): Parameters<typeof prepareHome>[0] => ({ env: { DELORUN_HOME: home }, stdout: () => undefined, stderr: () => undefined })

describe('prepareHome inside a Delorun chat sandbox', () => {
  it('skips the mode bits only for a caller that opts in', async () => {
    await expect(prepareHome(context(), undefined)).resolves.toMatchObject({ profile: expect.any(String) })
  })

  it('refuses a 0755 home when the caller does not opt in', async () => {
    await expect(prepareHome(context(), undefined, false)).rejects.toMatchObject({ code: 'HOME_MODE' })
  })

  it.each(['start.ts', 'setup/index.ts', 'update/command.ts'])('%s passes false so it always checks the mode', file => {
    expect(readFileSync(join(import.meta.dirname, '../src', file), 'utf8')).toContain('prepareHome(context, values.profile, false)')
  })
})
