/**
 * A bare `delorun` on a home with the CLI profile starts Delo as `delorun start` does — in the background unless
 * setup's answer was no or `--foreground` is given — and opens the studio either way.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/start.ts', async (importActual) => ({
  ...await importActual<typeof import('../src/start.ts')>(),
  startDetached: vi.fn(() => Promise.resolve(0)),
  startForeground: vi.fn(() => Promise.resolve(undefined)),
}))

const { main } = await import('../src/main.ts')
const { startDetached, startForeground } = await import('../src/start.ts')

let base: string
let home: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delorun-bare-'))
  home = join(base, '.delo')
  mkdirSync(join(home, 'profiles', 'default'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'profiles', 'default', 'package.json'), JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: {}, dsh: { profile: { bundles: ['@delo/bundle-local'] } } }))
  vi.mocked(startDetached).mockClear()
  vi.mocked(startForeground).mockClear()
})

afterEach(() => { rmSync(base, { recursive: true, force: true }) })

/**
 * Run a bare `delorun` with arguments.
 * @param args - the arguments.
 * @returns the exit code.
 */
async function bare(args: readonly string[]): Promise<number | undefined> {
  return main(args, { env: { ...process.env, HOME: base, USERPROFILE: base, DELO_HOME: home }, stdout: () => {}, stderr: () => {} })
}

describe('bare delorun on a set-up home', () => {
  it('starts in the background and opens the studio when no answer says otherwise', async () => {
    expect(await bare([])).toBe(0)
    expect(startDetached).toHaveBeenCalledWith(home, 'default', expect.anything(), true)
    expect(startForeground).not.toHaveBeenCalled()
  })

  it('runs in this terminal with the studio when setup\'s answer was no, or with --foreground', async () => {
    writeFileSync(join(home, 'profiles', 'default', 'setup-answers.json'), JSON.stringify({ version: 1, background: false }))
    await bare([])
    await bare(['--foreground'])
    expect(startDetached).not.toHaveBeenCalled()
    expect(vi.mocked(startForeground).mock.calls.map(([request]) => request.open)).toEqual([true, true])
  })
})
