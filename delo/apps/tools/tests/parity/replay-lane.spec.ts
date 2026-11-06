/**
 * The parity replay lane through upstream's own snapshot adapters: a switch
 * left on in the overlay fails the replay, record and refresh refuse the
 * overlay before any process starts, and a shipped profile does not load the
 * overlay without the lane.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PARITY_OVERLAY_ENV, PARITY_OVERLAY_PATH } from '@delo/contract-parity-composition'

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const SWITCH_LEFT_ON = 'delo/apps/tools/tests/parity/fixtures/switch-left-on.overlay.yml'
/** The headless scenario whose recorded tool schemas hold upstream's plugin_manager tool. */
const PLUGIN_MANAGER_REPLAY = 'replays plugin-manager through dsh --profile headless'
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

/**
 * Run one snapshot adapter of upstream's replay.
 * @param file - the adapter.
 * @param filter - the test-name filter.
 * @param env - the variables the run sets.
 * @returns the exit status and the combined output.
 */
function replay(file: string, filter: string, env: Record<string, string>): { status: number | null; output: string } {
  const run = spawnSync('node_modules/.bin/vitest', ['run', '--config', 'vitest.snapshot.config.ts', file, '-t', filter], {
    cwd: ROOT, encoding: 'utf8', env: nestedEnv(env), maxBuffer: 64 * 1024 * 1024,
  })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

/** The status of the committed corpus, so a refused run can be shown to write nothing. */
function corpusStatus(): string {
  return spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'snapshots/'], { cwd: ROOT, encoding: 'utf8' }).stdout
}

describe('the replay lane', () => {
  it('parity replay refuses a model-visible switch left on', () => {
    const parity = replay('snapshots/session/headless.snapshot.ts', PLUGIN_MANAGER_REPLAY, { [PARITY_OVERLAY_ENV]: PARITY_OVERLAY_PATH })
    expect(parity.output).toContain('1 passed')
    expect(parity.status).toBe(0)
    const planted = replay('snapshots/session/headless.snapshot.ts', PLUGIN_MANAGER_REPLAY, { [PARITY_OVERLAY_ENV]: SWITCH_LEFT_ON })
    expect(planted.status).toBe(1)
    expect(planted.output).toContain('plugin-manager: request header 1')
    expect(planted.output).toContain('1 failed')
  }, 180_000)

  it('parity replay refuses record and refresh modes', () => {
    const before = corpusStatus()
    for (const mode of ['record', 'refresh']) {
      for (const file of ['snapshots/session/headless.snapshot.ts', 'snapshots/sdk/sdk.snapshot.ts', 'snapshots/acp/acp.snapshot.ts']) {
        // The filter matches no scenario, so even a broken refusal would start no recording.
        const run = replay(file, 'no scenario carries this name', { DSH_SNAPSHOT: mode, [PARITY_OVERLAY_ENV]: PARITY_OVERLAY_PATH })
        expect(run.status, `${mode} ${file}`).toBe(1)
        expect(run.output, `${mode} ${file}`).toContain(`${PARITY_OVERLAY_ENV} selects a replay-only overlay and is refused in DSH_SNAPSHOT=${mode} mode`)
      }
    }
    expect(corpusStatus()).toBe(before)
  }, 180_000)

  it('parity overlay is not selected by a person\'s configuration', () => {
    const home = mkdtempSync(join(tmpdir(), 'delo-parity-home-'))
    homes.push(home)
    // The variable alone reaches only the snapshot adapters; the shipped profile composes no overlay row.
    const run = spawnSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless', '--dump-config'], {
      cwd: ROOT, encoding: 'utf8', env: nestedEnv({ DSH_HOME: home, [PARITY_OVERLAY_ENV]: join(ROOT, PARITY_OVERLAY_PATH) }), maxBuffer: 64 * 1024 * 1024,
    })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('id: tool-plugin-manager')
    expect(run.stdout).not.toContain('readActionsExempt')
    expect(run.stdout).not.toContain('parity.overlay.yml')
    // Outside Delo's tree, only test support names the variable, and nothing names the overlay file.
    const named = (pattern: string) => spawnSync('git', ['grep', '-l', '--untracked', '-e', pattern, '--', ':!delo/'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    expect(named(PARITY_OVERLAY_ENV)).toEqual(['apps/web/tests/scaffold.ts', 'packages/test-support/session-snapshot/src/launcher.ts', 'packages/test-support/session-snapshot/src/snapshot-patch.ts'])
    expect(named('parity.overlay')).toEqual([])
  }, 120_000)
})
