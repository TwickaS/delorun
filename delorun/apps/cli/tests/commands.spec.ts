import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit.ts'
import { COMMANDS, main } from '../src/main.ts'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-commands-')))
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

describe('the lazily loaded command table', () => {
  it('lists each command with the name and the help line its module declares', async () => {
    for (const entry of COMMANDS) {
      const command = await entry.load()
      expect({ name: command.name, summary: command.summary }, entry.name).toEqual({ name: entry.name, summary: entry.summary })
    }
  })

  it('lists every command once', () => {
    const names = COMMANDS.map(entry => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('prints one help line per command, in table order, for --help, -h and help', async () => {
    const width = Math.max(...COMMANDS.map(entry => entry.name.length))
    for (const word of ['--help', '-h', 'help']) {
      const { exit, stdout, stderr } = await run([word])
      expect(exit, word).toBe(EXIT.ok)
      expect(stderr, word).toBe('')
      const listed = stdout.split('\n').slice(stdout.split('\n').indexOf('Commands:') + 1, -1).filter(line => line.startsWith('  ')).slice(0, COMMANDS.length)
      expect(listed, word).toEqual(COMMANDS.map(entry => `  ${entry.name.padEnd(width)}  ${entry.summary}`))
    }
  })

  it('refuses an unknown command with the usage code and the help text', async () => {
    const { exit, stdout, stderr } = await run(['frobnicate'])
    expect(exit).toBe(EXIT.usage)
    expect(stdout).toBe('')
    expect(stderr).toContain('delorun: unknown command "frobnicate"\n\nUsage: delorun')
    expect(stderr).toContain('Commands:')
  })
})
