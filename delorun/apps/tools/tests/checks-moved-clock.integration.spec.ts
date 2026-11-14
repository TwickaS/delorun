/**
 * The moved-clock setup against a planted time bomb: a spec that fixes a date and compares the clock with it passes
 * at the real time and fails with the clock moved forward.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MOVED_CLOCK_ENV } from '../src/checks/moved-clock.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SETUP = join(ROOT, 'delorun/vitest.moved-clock-setup.ts')
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * Run the planted spec under the moved-clock setup.
 * @param days - how far the clock moves.
 * @returns the exit status and output.
 */
function plantedRun(days: number): { status: number | null, output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'delorun-moved-clock-spec-'))
  directories.push(directory)
  writeFileSync(join(directory, 'vitest.config.mjs'), `export default { test: { include: ['bomb.spec.mjs'], setupFiles: [${JSON.stringify(SETUP)}] } }\n`)
  // Fixes a literal date one day ahead of the real time, and compares the clock with it in the test.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
  writeFileSync(join(directory, 'bomb.spec.mjs'), [
    "import { expect, it } from 'vitest'",
    `const FIXED = new Date('${tomorrow}')`,
    "it('the clock is before the fixed date', () => {",
    '  expect(Date.now()).toBeLessThan(FIXED.getTime())',
    '})',
  ].join('\n'))
  const run = spawnSync(join(ROOT, 'node_modules/.bin/vitest'), ['run', '--config', 'vitest.config.mjs'], { cwd: directory, encoding: 'utf8', env: { ...process.env, [MOVED_CLOCK_ENV]: String(days) }, timeout: 50_000 })
  expect(run.signal, run.stderr).toBeNull()
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

describe('the moved-clock setup', () => {
  it('passes a planted fixed-date spec at the real time and fails it two days on', () => {
    expect(plantedRun(0).status).toBe(0)
    const moved = plantedRun(2)
    expect(moved.status, moved.output).toBe(1)
    expect(moved.output).toContain('the clock is before the fixed date')
  })
})
