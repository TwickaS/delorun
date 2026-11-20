/**
 * A home that bubblewrap's tmpfs makes look like mode 0755 inside a Delorun chat sandbox: a command that needs the home
 * says it is hidden and where to run the command, never `chmod`; outside the sandbox the same home is still `HOME_MODE`.
 * `plugin check` and `plugin new` never touch the home, so they run there.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeLayoutError } from '@delorun/home'
import { EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { isSandboxHomeMode, SANDBOX_HOME_MESSAGE, sandboxHomeFailure } from '../src/sandbox-home.ts'

let root: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delorun-sandbox-home-'))
  home = join(root, 'home')
  mkdirSync(home, { mode: 0o700 })
  chmodSync(home, 0o755)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Run `delorun` against the scratch home.
 * @param argv - the command line.
 * @param extra - environment variables to add.
 * @param homePath - the home to use.
 * @returns the exit code and what was written to standard error.
 */
async function run(argv: readonly string[], extra: Readonly<Record<string, string>> = {}, homePath: string = home): Promise<{ readonly exit: unknown, readonly err: string, readonly out: string }> {
  let err = ''
  let out = ''
  const exit = await main(argv, { env: { HOME: root, DELORUN_HOME: homePath, ...extra }, stdout: (text) => { out += text }, stderr: (text) => { err += text } })
  return { exit, err, out }
}

describe.skipIf(process.platform === 'win32')('a home that looks laxer than 0700', () => {
  it('says the folder is hidden inside the chat sandbox, and never suggests chmod', async () => {
    const { exit, err } = await run(['setup', '--yes'], { DELORUN_SANDBOX_VIEW: '1' })
    expect(exit).toBe(EXIT.failed)
    expect(err).toContain('hidden inside the chat sandbox')
    expect(err).toContain('studio\'s terminal outside the sandbox')
    expect(err).toContain('chat with full access')
    expect(err).not.toMatch(/chmod|HOME_MODE|0755/u)
  })

  it('stays HOME_MODE with the chmod fix when no sandbox marker is set', async () => {
    const { exit, err } = await run(['setup', '--yes'])
    expect(exit).toBe(EXIT.failed)
    expect(err).toContain('HOME_MODE')
    expect(err).toContain('chmod 700')
    expect(err).not.toContain('hidden inside the chat sandbox')
  })

  it('refuses a symbolic link as before even with the marker set', () => {
    const link = new HomeLayoutError('HOME_MODE', home, `${home} is a symbolic link; it must be a directory of its own`)
    expect(isSandboxHomeMode(link, { DELORUN_SANDBOX_VIEW: '1' })).toBe(false)
    expect(sandboxHomeFailure(link, { DELORUN_SANDBOX_VIEW: '1' })).toBe(link)
  })

  it('leaves every other failure alone', () => {
    const other = new Error('boom')
    expect(sandboxHomeFailure(other, { DELORUN_SANDBOX_VIEW: '1' })).toBe(other)
    expect(SANDBOX_HOME_MESSAGE).not.toContain('chmod')
  })
})

describe('plugin new and plugin check inside the chat sandbox with no usable home', () => {
  it('scaffolds a plugin and checks it, without reading the home', async () => {
    const missing = join(root, 'no-such-home', 'nested')
    const env = { DELORUN_SANDBOX_VIEW: '1' }
    const folder = join(root, 'plugins', 'home', 'sandboxed')
    const created = await run(['plugin', 'new', '@you/sandboxed', '--dir', folder], env, missing)
    expect(created.exit).toBe(EXIT.ok)
    expect(created.err).toBe('')
    const checked = await run(['plugin', 'check', folder], env, missing)
    expect(checked.err).toBe('')
    expect(checked.exit).toBe(EXIT.ok)
    expect(checked.out).toContain('The installer admits it on this release.')
  })

  it('does not warn about log pruning when the hidden home shows fake mode bits', async () => {
    writeFileSync(join(root, 'package.json'), '{"name":"x","version":"1.0.0"}\n')
    chmodSync(home, 0o755)
    const { err } = await run(['plugin', 'check', root], { DELORUN_SANDBOX_VIEW: '1' })
    expect(err).toBe('')
  })
})
