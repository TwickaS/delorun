/**
 * The hook check: each variable and each missing or wrong hook file refuses the batch with `hooks-bypassed`, and an
 * installed hook with a clean environment passes.
 */
import { describe, expect, it } from 'vitest'
import { BatchError } from '../../src/batch/errors.ts'
import { assertHooksInstalled } from '../../src/batch/hooks.ts'
import type { ProcessRun } from '../../src/batch/process.ts'
import type { Files } from '../../src/batch/state.ts'

const ROOT = '/repo'
const HOOKS = '/repo/.git/dsh-hooks'
const INSTALLED: Record<string, string> = {
  [`${HOOKS}/pre-push`]: '#!/bin/sh\nlefthook run pre-push\n',
  [`${ROOT}/lefthook-local.yml`]: 'extends:\n  - delorun/lefthook.yml\n',
  [`${ROOT}/node_modules/.bin/lefthook`]: '',
}

/**
 * A file port over a map.
 * @param contents - the files by path.
 * @returns the port.
 */
function memory(contents: Record<string, string>): Files {
  return { read: path => contents[path], write: () => undefined, remove: () => undefined, exists: path => path in contents }
}

/**
 * A git port that names the hooks directory and the configured hooks path.
 * @param hooksPath - the value of core.hooksPath, or undefined when unset.
 * @param fails - whether `rev-parse` fails.
 * @returns the port.
 */
function gitWith(hooksPath: string | undefined, fails = false): (args: readonly string[]) => ProcessRun {
  return args => {
    if (args[0] === 'rev-parse') return fails ? { status: 128, stdout: '', stderr: 'fatal' } : { status: 0, stdout: `${HOOKS}\n`, stderr: '' }
    return hooksPath === undefined ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${hooksPath}\n`, stderr: '' }
  }
}

/**
 * The refusal the check raises.
 * @param run - the check.
 * @returns the error.
 */
function refusal(run: () => void): BatchError {
  try {
    run()
  } catch (error) {
    if (error instanceof BatchError) return error
    throw error
  }
  throw new Error('the check passed')
}

describe('assertHooksInstalled', () => {
  it('passes with the hooks installed, a clean environment, and LEFTHOOK enabled or relative paths', () => {
    expect(() => { assertHooksInstalled(gitWith(HOOKS), ROOT, {}, memory(INSTALLED)) }).not.toThrow()
    expect(() => { assertHooksInstalled(gitWith('.git/dsh-hooks'), ROOT, { LEFTHOOK: '1' }, memory(INSTALLED)) }).not.toThrow()
    expect(() => { assertHooksInstalled(gitWith(HOOKS), ROOT, { LEFTHOOK: 'true' }, memory(INSTALLED)) }).not.toThrow()
  })

  it.each([
    [{ LEFTHOOK: '0' }, 'LEFTHOOK'],
    [{ LEFTHOOK: '' }, 'LEFTHOOK'],
    [{ LEFTHOOK_EXCLUDE: 'pre-push' }, 'LEFTHOOK_EXCLUDE'],
    [{ LEFTHOOK_BIN: '/bin/true' }, 'LEFTHOOK_BIN'],
    [{ DELORUN_PUSH_SKIP: '' }, 'DELORUN_PUSH_SKIP'],
    [{ GIT_CONFIG_COUNT: '1' }, 'GIT_CONFIG_COUNT'],
    [{ GIT_CONFIG_PARAMETERS: "'core.hooksPath=/x'" }, 'GIT_CONFIG_PARAMETERS'],
    [{ GIT_CONFIG_GLOBAL: '/dev/null' }, 'GIT_CONFIG_GLOBAL'],
    [{ GIT_CONFIG_SYSTEM: '/dev/null' }, 'GIT_CONFIG_SYSTEM'],
    [{ GIT_CONFIG_NOSYSTEM: '1' }, 'GIT_CONFIG_NOSYSTEM'],
  ])('refuses the variable %j', (env, name) => {
    const error = refusal(() => { assertHooksInstalled(gitWith(HOOKS), ROOT, env, memory(INSTALLED)) })
    expect(error.code).toBe('hooks-bypassed')
    expect(error.message).toContain(name)
    expect(error.message).toContain('unset')
  })

  it('refuses a hooks path that is unset or names another directory, naming it', () => {
    expect(refusal(() => { assertHooksInstalled(gitWith(undefined), ROOT, {}, memory(INSTALLED)) }).message).toContain('core.hooksPath is unset')
    const other = refusal(() => { assertHooksInstalled(gitWith('/elsewhere'), ROOT, {}, memory(INSTALLED)) })
    expect(other.code).toBe('hooks-bypassed')
    expect(other.message).toContain('core.hooksPath is /elsewhere')
  })

  it('refuses a missing or foreign hook file, local configuration and lefthook binary, naming the file', () => {
    const without = (path: string, replacement?: string): Files => memory(Object.fromEntries(Object.entries(INSTALLED).flatMap(([name, text]) => name !== path ? [[name, text]] : replacement === undefined ? [] : [[name, replacement]])))
    for (const [path, replacement] of [
      [`${HOOKS}/pre-push`, undefined],
      [`${HOOKS}/pre-push`, '#!/bin/sh\nexit 0\n'],
      [`${ROOT}/lefthook-local.yml`, undefined],
      [`${ROOT}/lefthook-local.yml`, 'extends: []\n'],
      [`${ROOT}/node_modules/.bin/lefthook`, undefined],
    ] as const) {
      const error = refusal(() => { assertHooksInstalled(gitWith(HOOKS), ROOT, {}, without(path, replacement)) })
      expect(error.code).toBe('hooks-bypassed')
      expect(error.message).toContain(path)
      expect(error.message).toContain('pnpm install')
    }
  })

  it('reports a git that cannot name the hooks directory', () => {
    expect(refusal(() => { assertHooksInstalled(gitWith(HOOKS, true), ROOT, {}, memory(INSTALLED)) }).code).toBe('git')
  })
})
