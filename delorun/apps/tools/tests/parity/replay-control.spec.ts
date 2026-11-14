/**
 * The parity replay's negative control (`parity-replay:control`): the replay it starts, the environment it gives it,
 * and its verdict, which passes only a replay that failed on the planted switch's request header.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PARITY_OVERLAY_ENV } from '@delorun/contract-parity-composition'
import { CONTROL_SCENARIO, controlEnv, controlFailure, controlRun, SWITCH_LEFT_ON_PATH } from '../../src/parity/composition/replay-control.ts'

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

describe('the parity replay control', () => {
  it('replays the plugin-manager scenario of the headless adapter in replay mode with the planted overlay', () => {
    const run = controlRun()
    expect(run).toEqual({
      command: 'node_modules/.bin/vitest',
      args: ['run', '--config', 'vitest.snapshot.config.ts', 'snapshots/session/headless.snapshot.ts', '-t', CONTROL_SCENARIO],
      env: { DSH_SNAPSHOT: 'replay', [PARITY_OVERLAY_ENV]: SWITCH_LEFT_ON_PATH },
    })
    expect(existsSync(join(ROOT, SWITCH_LEFT_ON_PATH))).toBe(true)
    expect(readFileSync(join(ROOT, SWITCH_LEFT_ON_PATH), 'utf8')).toContain('profileHistory: true')
    expect(readFileSync(join(ROOT, 'snapshots/session/headless.snapshot.ts'), 'utf8')).toContain('plugin-manager')
  })

  it('drops the variables of a Vitest worker, a model key and another overlay, and sets its own', () => {
    const env = controlEnv({ PATH: '/bin', VITEST_WORKER_ID: '3', VITEST: 'true', TEST: 'true', NODE_ENV: 'test', DEEPSEEK_API_KEY: 'k', DSH_SNAPSHOT_PATCH: 'other.yml', DSH_HOME: '/h', TESTING: 'kept' }, controlRun())
    expect(env).toEqual({ PATH: '/bin', TESTING: 'kept', DSH_SNAPSHOT: 'replay', [PARITY_OVERLAY_ENV]: SWITCH_LEFT_ON_PATH })
  })

  it('passes only a replay that failed on the planted switch\'s request header', () => {
    expect(controlFailure(1, 'plugin-manager: request header 1 differs\n Tests  1 failed (1)')).toBeUndefined()
    expect(controlFailure(0, ' Tests  1 passed (1)')).toBe('the replay passed with the profile_history switch left on, so the parity overlay does not reach the replay')
    for (const [status, output] of [[1, 'Error: cannot find module\n 1 failed'], [1, 'plugin-manager: request header 1 differs'], [null, ''], [2, 'plugin-manager: request header 1\n1 failed']] as const) {
      expect(controlFailure(status, output)).toMatch(/^the replay did not fail on the planted switch's request header \(exit (?:1|null|2)\), so the control proves nothing$/)
    }
  })
})
