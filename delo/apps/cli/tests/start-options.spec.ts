/**
 * `delorun start`'s author options (`delo/apps/cli/src/start.ts`): `--patch` files are made absolute and a missing one
 * is a usage error before anything starts; `--inspect` opens Node's inspector on the loopback address and port 9229 and
 * warns that any program on the computer that reaches the port can run code as Delo, and a port it cannot open is a
 * failure that names the port.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliError, EXIT } from '../src/exit.ts'
import { INSPECTOR_PORT, openDebugger, patchFilesOf, startCommand } from '../src/start.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-start-options-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('--patch', () => {
  it('makes each file absolute, in order', () => {
    const file = join(directory, 'mine.patch.yml')
    writeFileSync(file, '[]\n')
    expect(patchFilesOf([file, file])).toEqual([file, file])
  })

  it('refuses a file that does not exist as a usage error', () => {
    const missing = join(directory, 'missing.patch.yml')
    expect(() => patchFilesOf([missing])).toThrow(new CliError(EXIT.usage, `delorun start: --patch ${missing} does not exist`))
  })

  it('is an option of delorun start, which lists it in its summary', () => {
    expect(startCommand.summary).toContain('--patch')
  })
})

describe('--inspect', () => {
  it('opens the inspector on the loopback address and Node\'s default port, and says what that exposes', () => {
    const opened: [number, string][] = []
    const warnings: string[] = []
    openDebugger({ stdout: () => undefined, stderr: (text) => { warnings.push(text) } }, (port, host) => { opened.push([port, host]) })
    expect(opened).toEqual([[INSPECTOR_PORT, '127.0.0.1']])
    expect(INSPECTOR_PORT).toBe(9229)
    expect(warnings.join('')).toContain('can run code as Delo')
  })

  it('fails naming the port when the inspector cannot open', () => {
    expect(() => openDebugger({ stdout: () => undefined, stderr: () => undefined }, () => { throw new Error('address already in use') })).toThrow('could not listen on 127.0.0.1:9229: address already in use')
  })
})
