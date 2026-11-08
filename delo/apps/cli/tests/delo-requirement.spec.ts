import { describe, expect, it, vi } from 'vitest'
import {
  DELO_VERSION_ENV, evaluateDeloRequirement, evaluatePluginCompatibility, getDeloRuntimeVersion, pluginCompatibilityWarning,
} from '@deepseek-ai/dsh-app-boot/src/plugin-compatibility.ts'

/** The Delo version these specs check against, and the DSH version beside it. */
const DELO = '1.4.0'
const DSH = '0.2.2'
/** A range around {@link DELO}: 1.0.0 is its floor, 2.0.0 its ceiling. */
const RANGE = '>=1.0.0 <2.0.0'

/**
 * A plugin manifest declaring one `engines.delo` value.
 * @param delo - the declaration; absent when undefined.
 * @param dsh - an `engines.dsh` declaration to set beside it.
 * @returns the manifest.
 */
function manifest(delo?: unknown, dsh?: string): Record<string, unknown> {
  const engines: Record<string, unknown> = {}
  if (delo !== undefined) engines.delo = delo
  if (dsh !== undefined) engines.dsh = dsh
  return { name: 'example-delo-plugin', version: '1.4.0', engines }
}

describe('the Delo axis at, below and above the requirement', () => {
  it('meets a range the version is inside', () => {
    expect(evaluateDeloRequirement(manifest(RANGE), DELO)).toEqual({ deloVersion: DELO, status: 'met', requirement: RANGE })
  })

  it('meets a range the version sits exactly on', () => {
    expect(evaluateDeloRequirement(manifest(RANGE), '1.0.0')?.status).toBe('met')
  })

  it('does not satisfy a range the version is below', () => {
    expect(evaluateDeloRequirement(manifest(RANGE), '0.9.9')).toEqual({ deloVersion: '0.9.9', status: 'unmet', requirement: RANGE })
  })

  it('does not satisfy a range the version is above', () => {
    expect(evaluateDeloRequirement(manifest(RANGE), '2.0.0')?.status).toBe('unmet')
  })

  it('lets a prerelease take part in the range', () => {
    expect(evaluateDeloRequirement(manifest(RANGE), '1.4.0-rc.1')?.status).toBe('met')
  })

  it('does not satisfy an empty, workspace or invalid range', () => {
    for (const range of ['', 'workspace:*', 'not-a-range']) {
      expect(evaluateDeloRequirement(manifest(range), DELO)?.status).toBe('unmet')
    }
  })
})

describe('a malformed version string', () => {
  it('is refused, not compared, when it is the Delo version', () => {
    expect(() => evaluateDeloRequirement(manifest(RANGE), 'one point four')).toThrow(/Invalid Delo version: "one point four"; expected a semantic version such as 1\.0\.0/)
  })

  it('is refused when it arrives through the environment', () => {
    vi.stubEnv(DELO_VERSION_ENV, 'v1.4')
    expect(() => getDeloRuntimeVersion()).toThrow(/Invalid Delo version/)
    vi.unstubAllEnvs()
  })

  it('reads an unset or blank environment as no Delo version', () => {
    expect(getDeloRuntimeVersion({})).toBeUndefined()
    expect(getDeloRuntimeVersion({ [DELO_VERSION_ENV]: '   ' })).toBeUndefined()
    expect(getDeloRuntimeVersion({ [DELO_VERSION_ENV]: DELO })).toBe(DELO)
  })
})

describe('refusals', () => {
  it('refuses a plugin that requires a newer Delo, naming both versions', () => {
    const issue = evaluatePluginCompatibility(manifest('>=2.0.0'), {}, DSH, DELO)
    expect(issue?.delo).toEqual({ deloVersion: DELO, status: 'unmet', requirement: '>=2.0.0' })
    expect(issue?.requirements).toEqual({})
    expect(issue?.exempted).toBe(false)
    expect(pluginCompatibilityWarning(issue!)).toContain(`example-delo-plugin@1.4.0 requires Delo >=2.0.0; this is Delo ${DELO} on DSH ${DSH}.`)
  })

  it('refuses a plugin whose engines.delo is a number as unreadable, naming both versions', () => {
    const issue = evaluatePluginCompatibility(manifest(2), {}, DSH, DELO)
    expect(issue?.delo).toEqual({ deloVersion: DELO, status: 'unreadable' })
    expect(pluginCompatibilityWarning(issue!)).toContain(`example-delo-plugin@1.4.0 declares engines.delo in a form Delo cannot read; this is Delo ${DELO} on DSH ${DSH}.`)
  })

  it('keeps a plugin without engines.delo exactly as it was', () => {
    expect(evaluateDeloRequirement(manifest(), DELO)).toBeUndefined()
    expect(evaluatePluginCompatibility(manifest(undefined, '>=0.0.0'), {}, DSH, DELO)).toBeUndefined()
    expect(evaluatePluginCompatibility(manifest(), {}, DSH, DELO)).toBeUndefined()
  })

  it('checks no Delo axis when Delo\'s version is unknown', () => {
    expect(evaluateDeloRequirement(manifest('>=2.0.0'), undefined)).toBeUndefined()
    expect(evaluatePluginCompatibility(manifest('>=2.0.0'), {}, DSH, undefined)).toBeUndefined()
  })
})

describe('exemptions', () => {
  it('does not let the dsh exemption admit an unmet Delo requirement', () => {
    const issue = evaluatePluginCompatibility(manifest('>=2.0.0', '<0.0.1'), { 'example-delo-plugin@1.4.0': [DSH] }, DSH, DELO)
    expect(issue?.requirements).toEqual({ 'engines.dsh': '<0.0.1' })
    expect(issue?.exempted).toBe(false)
    expect(pluginCompatibilityWarning(issue!)).toContain('Exact-version exemption: not active.')
  })

  it('still admits an upstream-only mismatch the person exempted', () => {
    const issue = evaluatePluginCompatibility(manifest(RANGE, '<0.0.1'), { 'example-delo-plugin@1.4.0': [DSH] }, DSH, DELO)
    expect(issue?.exempted).toBe(true)
    expect(pluginCompatibilityWarning(issue!)).toContain('Exact-version exemption: active.')
  })
})
