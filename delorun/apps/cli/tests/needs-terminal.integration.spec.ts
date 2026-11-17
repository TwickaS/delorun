/** The shared refusal to ask a question nobody can answer, and the devices prompts that use it. */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askInTerminal, askSecretInTerminal } from '../src/devices/command.ts'
import { EXIT } from '../src/exit.ts'
import { needsTerminalMessage, requireTerminal } from '../src/needs-terminal.ts'

describe('requireTerminal', () => {
  it('lets a terminal ask', () => {
    expect(() => requireTerminal('delorun x', undefined, { isTTY: true })).not.toThrow()
  })

  it.each([{ isTTY: false }, {}])('fails with a CliError when standard input is %j', (input) => {
    expect(() => requireTerminal('delorun devices approve', undefined, input)).toThrowError(expect.objectContaining({
      name: 'CliError', exit: EXIT.failed, message: 'delorun devices approve: this needs you at a terminal to answer; run it in one.',
    }))
  })

  it('names the option that answers without a terminal', () => {
    expect(needsTerminalMessage('delorun setup', '--yes')).toBe('delorun setup: this needs you at a terminal to answer; run it in one, or pass --yes.')
  })
})

describe('the devices prompts without a terminal', () => {
  it('fail before waiting for input', async () => {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      await expect(askInTerminal('Type the number')).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('delorun devices: this needs you at a terminal') })
      await expect(askSecretInTerminal('PIN')).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('delorun devices pin: this needs you at a terminal') })
    } finally {
      if (stdin === undefined) Reflect.deleteProperty(process.stdin, 'isTTY')
      else Object.defineProperty(process.stdin, 'isTTY', stdin)
    }
  })
})

describe('the devices question in a process whose standard input is closed', () => {
  it('ends with the actionable line, not Node\'s unsettled top-level await warning', () => {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), join(import.meta.dirname, 'fixtures/ask-devices-prompt.ts')], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000 })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('delorun devices: this needs you at a terminal to answer; run it in one.')
    expect(result.stderr).not.toContain('unsettled top-level await')
  })
})
