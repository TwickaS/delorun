import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit.ts'
import { COMMON_EXIT_CODES, HELPED_COMMANDS, asksForHelp, commandHelp } from '../src/help.ts'
import { COMMANDS, main } from '../src/main.ts'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-help-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

async function run(argv: readonly string[]): Promise<{ readonly exit: Awaited<ReturnType<typeof main>>, readonly stdout: string, readonly stderr: string }> {
  let stdout = ''
  let stderr = ''
  const exit = await main(argv, { env: { DELORUN_HOME: join(home, '.delorun') }, stdout: text => void (stdout += text), stderr: text => void (stderr += text) })
  return { exit, stdout, stderr }
}

describe('delorun <command> --help', () => {
  it('has help for exactly the listed commands', () => {
    expect([...HELPED_COMMANDS].sort()).toEqual(COMMANDS.map(entry => entry.name).sort())
  })

  it.each(COMMANDS.map(entry => entry.name))('prints %s usage, its options and its exit codes, and exits 0 without creating the home', async (name) => {
    const long = await run([name, '--help'])
    expect(long.exit).toBe(EXIT.ok)
    expect(long.stderr).toBe('')
    expect(long.stdout).toMatch(new RegExp(`^Usage: delorun ${name}\\b`))
    expect(long.stdout).toContain('\nOptions:\n')
    expect(long.stdout).toContain('-h, --help  ')
    expect(long.stdout).toMatch(/\nExit codes: /)
    expect(long.stdout.endsWith('\n') && !long.stdout.endsWith('\n\n')).toBe(true)
    expect(long.stdout).not.toMatch(/\bDelorun\b|\bC\d{1,2}\b/)
    const short = await run([name, '-h'])
    const named = await run(['help', name])
    expect(short.stdout).toBe(long.stdout)
    expect(named.stdout).toBe(long.stdout)
    expect(named.exit).toBe(EXIT.ok)
  })

  it('answers help after other arguments, and not after --', async () => {
    expect((await run(['trash', 'purge', 'x', '--help'])).stdout).toContain('Usage: delorun trash')
    expect(asksForHelp(['purge', '--', '--help'])).toBe(false)
    expect(asksForHelp(['-h'])).toBe(true)
  })

  it('uses the common exit codes unless a command states its own', () => {
    expect(commandHelp('stop')).toContain(COMMON_EXIT_CODES)
    expect(commandHelp('status')).toContain('0 Delorun is running')
    expect(commandHelp('nonesuch')).toBeUndefined()
  })

  it('documents reach on tailscale --yes', () => {
    expect(commandHelp('reach')).toContain('With on tailscale: skip the question. Required when there is no terminal.')
  })

  it('refuses a name that is not a command with the usage code', async () => {
    const result = await run(['help', 'nonesuch'])
    expect(result.exit).toBe(EXIT.usage)
    expect(result.stderr).toContain('"nonesuch" is not a command')
  })
})

describe('a wrong option', () => {
  it.each(['start', 'status', 'stop', 'open'])('on %s names the option and points to --help', async (name) => {
    const result = await run([name, '--bogus'])
    expect(result.exit).toBe(EXIT.usage)
    expect(result.stderr).toContain(`delorun ${name}: unknown option --bogus. Run delorun ${name} --help for usage.`)
    expect(result.stderr).not.toContain("place it at the end")
  })
})
