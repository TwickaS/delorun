import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../../src/command.ts'
import { CliError, EXIT } from '../../src/exit.ts'
import { loopbackPortIsFree, setupCommand } from '../../src/setup/index.ts'

let osHome: string
let lines: string[]
let context: CommandContext

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-command-')))
  lines = []
  context = {
    env: { DELO_HOME: join(osHome, '.delo'), DEEPSEEK_API_KEY: 'command-spec-key' },
    stdout: text => void lines.push(text),
    stderr: text => void lines.push(text),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * @param args - the arguments after `setup`.
 * @returns the error the command raised.
 */
async function refusal(args: readonly string[]): Promise<CliError> {
  const error = await setupCommand.run(args, context).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(CliError)
  return error as CliError
}

describe('delorun setup', { timeout: 60_000 }, () => {
  it('--list names every section without touching the home', async () => {
    expect(await setupCommand.run(['--list'], context)).toBe(EXIT.ok)
    expect(lines.join('')).toContain('  key                 Model key (Quick and Full)')
    expect(lines.join('')).toContain('  profile             Profile name and port (Full)')
    expect(lines.join('')).toContain('Sections (delorun setup <section> runs one again):')
  })

  it('refuses an unknown option, two sections, and --yes with --config, with the usage code', async () => {
    expect((await refusal(['--nope'])).exit).toBe(EXIT.usage)
    expect((await refusal(['key', 'prompts'])).message).toContain('give one section, or none')
    expect((await refusal(['--yes', '--config', 'x.json'])).message).toContain('two forms of the same answers')
    expect((await refusal(['privacy', '--no-update-check'])).message).toBe('delorun setup: --no-update-check applies to a whole setup; delorun setup privacy asks about the release check')
  })

  it('refuses a section that does not exist, and a section on a profile that is not set up', async () => {
    expect((await refusal(['nope'])).message).toContain('there is no section "nope"')
    expect((await refusal(['key'])).message).toContain('is not set up; run delorun setup first')
  })

  it('refuses --yes and --config for a section, and checks the environment key with --check-key', async () => {
    expect(await setupCommand.run(['--yes'], context)).toBe(EXIT.ok)
    expect((await refusal(['prompts', '--yes'])).message).toContain('a section asks its question in a terminal')
    expect((await refusal(['prompts', '--config', 'missing.json'])).message).toContain('does not exist')
  })

  it('--check-key sends the environment key to the provider and refuses a key it does not accept', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })))
    vi.stubGlobal('fetch', fetchMock)
    const error = await refusal(['--yes', '--check-key'])
    expect(error.message).toBe('delorun setup: the key in DEEPSEEK_API_KEY was not accepted: https://api.deepseek.com did not accept the key (HTTP 401).')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lines.join('')).not.toContain('command-spec-key')
    expect(error.message).not.toContain('command-spec-key')
  })

  it('--no-update-check with --yes writes the release-check row off', async () => {
    expect(await setupCommand.run(['--yes', '--no-update-check'], context)).toBe(EXIT.ok)
    expect(readFileSync(join(osHome, '.delo', 'profiles', 'default', 'cordis.patch.yml'), 'utf8')).toContain('- id: delo-update-check\n  name: "@delo/bundle-local/update-check"\n  config:\n    intervalHours: 24\n    timeoutSeconds: 15\n    enabled: false\n')
  })

  it('a bare terminal-less run is refused with the usage code, as before', async () => {
    const error = await refusal([])
    expect(error.exit).toBe(EXIT.usage)
    expect(error.message).toContain('the questions need a terminal')
  })
})

describe('delorun setup --config and the port check', { timeout: 60_000 }, () => {
  it('applies an answers document named on the command line', async () => {
    const document = join(osHome, 'answers.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'stock', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    expect(await setupCommand.run(['--config', document], context)).toBe(EXIT.ok)
    expect(lines.join('')).toContain('Set up the CLI profile default')
  })

  it('finds a port taken by a listener and a port that is free', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as { port: number }
    expect(await loopbackPortIsFree(port)).toBe(false)
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    expect(await loopbackPortIsFree(port)).toBe(true)
  })
})
