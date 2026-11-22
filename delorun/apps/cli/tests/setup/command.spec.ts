import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    env: { DELORUN_HOME: join(osHome, '.delorun'), HOME: osHome, DEEPSEEK_API_KEY: 'command-spec-key' },
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
    expect(lines.join('')).toContain('  key                 Model provider and key\n')
    expect(lines.join('')).toContain('  profile             Profile name and port')
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
    const error = await refusal(['--yes', '--provider', 'deepseek-official', '--check-key'])
    expect(error.message).toBe('delorun setup: the key in DEEPSEEK_API_KEY was not accepted: https://api.deepseek.com did not accept the key (HTTP 401).')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lines.join('')).not.toContain('command-spec-key')
    expect(error.message).not.toContain('command-spec-key')
  })

  it('--check-key without --provider is refused: --yes alone chooses no provider whose key it could check', async () => {
    const error = await refusal(['--yes', '--check-key'])
    expect(error.exit).toBe(EXIT.usage)
    expect(error.message).toBe('delorun setup --yes: --check-key checks the chosen provider\'s key; name a provider with --provider')
  })

  it('takes --provider and its flags with --yes, reading the key from the provider\'s variable, which a typed key never replaces', async () => {
    context = { ...context, env: { ...context.env, ANTHROPIC_API_KEY: 'command-spec-anthropic' } }
    expect(await setupCommand.run(['--yes', '--provider', 'anthropic', '--model', 'claude-sonnet-5'], context)).toBe(EXIT.ok)
    const patch = readFileSync(join(osHome, '.delorun', 'profiles', 'default', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('apiKeyEnv: ANTHROPIC_API_KEY')
    expect(patch).toContain('provider: anthropic\n    model: claude-sonnet-5\n')
    expect(patch).not.toContain('command-spec-anthropic')
  })

  it('refuses provider flags outside --yes and delorun setup key, and without --provider', async () => {
    expect((await refusal(['--config', 'x.json', '--provider', 'openai'])).message).toBe('delorun setup: --provider applies to --yes and to delorun setup key; a --config document names its provider in modelProvider')
    expect((await refusal(['prompts', '--model', 'x', '--provider', 'openai'])).message).toContain('--provider, --model apply to --yes and to delorun setup key')
    expect((await refusal(['--yes', '--model', 'x'])).message).toBe('delorun setup: --model needs --provider')
    expect((await refusal(['--yes', '--provider', 'acme'])).exit).toBe(EXIT.usage)
  })

  // Putting the flag back makes setup accept it and write a phone level again.
  it('no longer has a --phone-powers flag: it is refused with the usage code', async () => {
    expect((await refusal(['--yes', '--phone-powers', 'full'])).exit).toBe(EXIT.usage)
  })

  it('sets the provider of a profile that is set up with delorun setup key and the flags, without a terminal', async () => {
    expect(await setupCommand.run(['--yes'], context)).toBe(EXIT.ok)
    context = { ...context, env: { ...context.env, LOCAL_KEY: 'command-spec-local' } }
    expect(await setupCommand.run(['key', '--provider', 'openai-compatible', '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'qwen3:8b', '--key-env', 'LOCAL_KEY'], context)).toBe(EXIT.ok)
    const record = JSON.parse(readFileSync(join(osHome, '.delorun', 'profiles', 'default', 'setup-answers.json'), 'utf8')) as { modelProvider: unknown }
    expect(record.modelProvider).toEqual({ id: 'openai-compatible', credential: { source: 'environment', name: 'LOCAL_KEY' }, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' })
    expect(readFileSync(join(osHome, '.delorun', 'profiles', 'default', 'cordis.patch.yml'), 'utf8')).toContain('baseURL: http://127.0.0.1:11434/v1')
    expect(lines.join('')).toContain('Updated the key section of the profile default.')
  })

  it('warns on standard error, without refusing, when the flags name an endpoint another computer serves over plain http', async () => {
    context = { ...context, env: { ...context.env, OPENAI_COMPATIBLE_API_KEY: 'k' } }
    expect(await setupCommand.run(['--yes', '--provider', 'openai-compatible', '--base-url', 'http://192.0.2.20:8000/v1', '--model', 'local'], context)).toBe(EXIT.ok)
    expect(lines.join('')).toContain('delorun setup --yes: warning: http://192.0.2.20:8000 is reached over plain http')
  })

  it('names the document\'s modelProvider, not the flags, when --config --check-key has no provider', async () => {
    const document = join(osHome, 'none.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 5, modelProvider: null, prompts: 'safer', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    expect((await refusal(['--config', document, '--check-key'])).message).toBe('delorun setup --config: --check-key checks the chosen provider\'s key; name a provider in the document\'s modelProvider')
  })

  it('--no-update-check with --yes writes the release-check row off', async () => {
    expect(await setupCommand.run(['--yes', '--no-update-check'], context)).toBe(EXIT.ok)
    expect(readFileSync(join(osHome, '.delorun', 'profiles', 'default', 'cordis.patch.yml'), 'utf8')).toContain('- id: delorun-update-check\n  name: "@delorun/bundle-local/update-check"\n  config:\n    intervalHours: 24\n    timeoutSeconds: 15\n    enabled: false\n')
  })

  it('a run without a terminal takes the safe defaults, as --yes does, instead of refusing', async () => {
    expect(await setupCommand.run([], context)).toBe(EXIT.ok)
    expect(lines.join('')).toContain('Delorun is set up. Nothing is running yet.')
    expect(lines.join('')).toContain('Add your model key in the studio (the welcome screen asks for it), or run delorun setup key.')
  })

  it('a run without a terminal takes --provider and its flags like --yes', async () => {
    expect(await setupCommand.run(['--provider', 'deepseek-official'], context)).toBe(EXIT.ok)
    expect(readFileSync(join(osHome, '.delorun', 'profiles', 'default', 'setup-answers.json'), 'utf8')).toContain('"id": "deepseek-official"')
  })

  it('--phone and its alias --devices, --import-dsh and --port are refused for a section and for a --config document, and --port needs a usable port', async () => {
    expect((await refusal(['privacy', '--phone'])).message).toContain('apply to a whole setup')
    expect((await refusal(['privacy', '--devices'])).message).toBe((await refusal(['privacy', '--phone'])).message)
    expect((await refusal(['--config', 'x.json', '--devices'])).message).toContain('a --config document holds its own answers')
    expect((await refusal(['--config', 'x.json', '--import-dsh'])).message).toContain('a --config document holds its own answers')
    for (const value of ['abc', '80', '70000', '']) expect((await refusal(['--port', value])).exit).toBe(EXIT.usage)
    expect((await refusal(['--port', '80'])).message).toBe('delorun setup: --port 80: Enter a port from 1024 to 65535; ports under 1024 need administrator rights.')
  })

  it('--port refuses the ports web browsers block, and writes nothing', async () => {
    for (const port of ['6000', '6665', '6666', '6667', '6668', '6669', '6697', '10080']) {
      const error = await refusal(['--port', port])
      expect([port, error.exit, error.message]).toEqual([port, EXIT.usage, `delorun setup: --port ${port}: Port ${port} is blocked by web browsers, so the studio could not be opened there. Choose another.`])
    }
    expect(existsSync(join(osHome, '.delorun', 'profiles', 'default', 'setup-answers.json'))).toBe(false)
  })

  it('--port sets the studio port in a run without a terminal and with --yes', async () => {
    expect(await setupCommand.run(['--port', '4123'], context)).toBe(EXIT.ok)
    expect(readFileSync(join(osHome, '.delorun', 'profiles', 'default', 'cordis.patch.yml'), 'utf8')).toContain('port: 4123')
  })

  it('--import-dsh without a DeepSeek Harness home says so in one line', async () => {
    expect(await setupCommand.run(['--yes', '--import-dsh'], context)).toBe(EXIT.ok)
    expect(lines.join('')).toContain('delorun setup --import-dsh: there is no DeepSeek Harness home to copy, so nothing was imported.')
  })

  it('delorun setup <section> still needs a terminal when there is none', async () => {
    expect(await setupCommand.run(['--yes'], context)).toBe(EXIT.ok)
    expect((await refusal(['prompts'])).message).toContain('the questions need a terminal')
  })
})

describe('delorun setup --config and the port check', { timeout: 60_000 }, () => {
  it('applies an answers document named on the command line', async () => {
    const document = join(osHome, 'answers.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'stock', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    expect(await setupCommand.run(['--config', document], context)).toBe(EXIT.ok)
    expect(lines.join('')).toContain('Delorun is set up. Nothing is running yet.')
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
