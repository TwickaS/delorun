/**
 * The parity overlay outside the replay lane: a shipped profile started with `DSH_SNAPSHOT_PATCH` set composes no
 * overlay row, and outside Delo's tree only test support names the variable. The adapters' refusal of record and
 * refresh is in `replay-lane.spec.ts`; the replay of a planted switch left on is the merge-only check
 * `parity-replay:control`.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PARITY_OVERLAY_ENV, PARITY_OVERLAY_PATH } from '@delo/contract-parity-composition'

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * The environment a nested run gets: this run's, without the variables that would make it a vitest worker, a model
 * key, or another overlay.
 * @param extra - the variables the run sets.
 * @returns the environment.
 */
function nestedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:VITEST|TEST$|NODE_ENV$|DEEPSEEK_|DSH_)/u.test(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

describe('the replay lane', () => {
  it('parity overlay is not selected by a person\'s configuration', () => {
    const home = mkdtempSync(join(tmpdir(), 'delo-parity-home-'))
    homes.push(home)
    // The variable alone reaches only the snapshot adapters; the shipped profile composes no overlay row.
    const run = spawnSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless', '--dump-config'], {
      cwd: ROOT, encoding: 'utf8', env: nestedEnv({ DSH_HOME: home, [PARITY_OVERLAY_ENV]: join(ROOT, PARITY_OVERLAY_PATH) }), maxBuffer: 64 * 1024 * 1024, timeout: 100_000,
    })
    expect(run.status, `signal ${String(run.signal)}: ${run.stderr}`).toBe(0)
    expect(run.stdout).toContain('id: tool-plugin-manager')
    expect(run.stdout).not.toContain('readActionsExempt')
    expect(run.stdout).not.toContain('parity.overlay.yml')
    // Outside Delo's tree, only test support names the variable, and nothing names the overlay file.
    const named = (pattern: string): string[] => {
      const grep = spawnSync('git', ['grep', '-l', '--untracked', '-e', pattern, '--', ':!delo/'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
      // git grep exits 1 when nothing matches.
      expect(grep.status === 0 || grep.status === 1, `git grep ${pattern}: signal ${String(grep.signal)}: ${grep.stderr}`).toBe(true)
      return grep.stdout.split('\n').filter(Boolean)
    }
    expect(named(PARITY_OVERLAY_ENV)).toEqual(['apps/web/tests/scaffold.ts', 'packages/test-support/session-snapshot/src/launcher.ts', 'packages/test-support/session-snapshot/src/snapshot-patch.ts'])
    expect(named('parity.overlay')).toEqual([])
  }, 120_000)
})
