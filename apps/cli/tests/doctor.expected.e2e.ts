/** Built `dsh --profile doctor`: the shipped template boots, runs every registered check once, prints the report and exits. */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!existsSync(builtBin))('dsh --profile doctor', () => {
  it('initializes the doctor profile, prints one line per shipped check and the counts, and exits by the verdict', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
    roots.push(root)
    const result = await execa(process.execPath, [builtBin, '--profile', 'doctor'], {
      cwd: root,
      env: { ...process.env, DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' },
      input: '',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^ok {4}Node\.js version: Node\.js \S+ is in the supported range \S+\.$/)
    expect(lines[1]).toMatch(/^(ok {4}|warn {2})Command sandbox: /)
    expect(lines.at(-1)).toMatch(/^\d passed, \d warned, 0 failed$/)
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(root, '.dsh', 'profiles', 'doctor'))).toBe(true)
  })
})
