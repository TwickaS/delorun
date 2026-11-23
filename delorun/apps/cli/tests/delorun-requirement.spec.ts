import { describe, expect, it, vi } from 'vitest'
import {
  DELORUN_VERSION_ENV, evaluateDelorunRequirement, evaluatePluginCompatibility, getDelorunRuntimeVersion, pluginCompatibilityWarning,
} from '@deepseek-ai/dsh-app-boot/src/plugin-compatibility.ts'

/** The Delorun version these specs check against, and the DSH version beside it. */
const DELORUN = '1.4.0'
const DSH = '0.2.2'
/** A range around {@link DELORUN}: 1.0.0 is its floor, 2.0.0 its ceiling. */
const RANGE = '>=1.0.0 <2.0.0'

/**
 * A plugin manifest declaring one `engines.delorun` value.
 * @param delorun - the declaration; absent when undefined.
 * @param dsh - an `engines.dsh` declaration to set beside it.
 * @returns the manifest.
 */
function manifest(delorun?: unknown, dsh?: string): Record<string, unknown> {
  const engines: Record<string, unknown> = {}
  if (delorun !== undefined) engines.delorun = delorun
  if (dsh !== undefined) engines.dsh = dsh
  return { name: 'example-delorun-plugin', version: '1.4.0', engines }
}

describe('the Delorun axis at, below and above the requirement', () => {
  it('meets a range the version is inside', () => {
    expect(evaluateDelorunRequirement(manifest(RANGE), DELORUN)).toEqual({ delorunVersion: DELORUN, status: 'met', requirement: RANGE })
  })

  it('meets a range the version sits exactly on', () => {
    expect(evaluateDelorunRequirement(manifest(RANGE), '1.0.0')?.status).toBe('met')
  })

  it('does not satisfy a range the version is below', () => {
    expect(evaluateDelorunRequirement(manifest(RANGE), '0.9.9')).toEqual({ delorunVersion: '0.9.9', status: 'unmet', requirement: RANGE })
  })

  it('does not satisfy a range the version is above', () => {
    expect(evaluateDelorunRequirement(manifest(RANGE), '2.0.0')?.status).toBe('unmet')
  })

  it('lets a prerelease take part in the range', () => {
    expect(evaluateDelorunRequirement(manifest(RANGE), '1.4.0-rc.1')?.status).toBe('met')
  })

  it('does not satisfy a workspace or invalid range', () => {
    for (const range of ['workspace:*', 'not-a-range']) {
      expect(evaluateDelorunRequirement(manifest(range), DELORUN)?.status).toBe('unmet')
    }
  })

  it('reads an empty or whitespace-only range as unreadable, never as any version', () => {
    for (const range of ['', ' ', '  ', '\t\n']) {
      expect(evaluateDelorunRequirement(manifest(range), DELORUN)).toEqual({ delorunVersion: DELORUN, status: 'unreadable' })
    }
  })
})

describe('a malformed version string', () => {
  it('is refused, not compared, when it is the Delorun version', () => {
    expect(() => evaluateDelorunRequirement(manifest(RANGE), 'one point four')).toThrow(/Invalid Delorun version: "one point four"; expected a semantic version such as 1\.0\.0/)
  })

  it('is refused when it arrives through the environment', () => {
    vi.stubEnv(DELORUN_VERSION_ENV, 'v1.4')
    expect(() => getDelorunRuntimeVersion()).toThrow(/Invalid Delorun version/)
    vi.unstubAllEnvs()
  })

  it('reads an unset or blank environment as no Delorun version', () => {
    expect(getDelorunRuntimeVersion({})).toBeUndefined()
    expect(getDelorunRuntimeVersion({ [DELORUN_VERSION_ENV]: '   ' })).toBeUndefined()
    expect(getDelorunRuntimeVersion({ [DELORUN_VERSION_ENV]: DELORUN })).toBe(DELORUN)
  })
})

describe('refusals', () => {
  it('refuses a plugin that requires a newer Delorun, naming both versions', () => {
    const issue = evaluatePluginCompatibility(manifest('>=2.0.0'), {}, DSH, DELORUN)
    expect(issue?.delorun).toEqual({ delorunVersion: DELORUN, status: 'unmet', requirement: '>=2.0.0' })
    expect(issue?.requirements).toEqual({})
    expect(issue?.exempted).toBe(false)
    expect(pluginCompatibilityWarning(issue!)).toContain(`example-delorun-plugin@1.4.0 requires Delorun >=2.0.0; this is Delorun ${DELORUN} on DSH ${DSH}.`)
  })

  it('refuses a plugin whose engines.delorun is a number as unreadable, naming both versions', () => {
    const issue = evaluatePluginCompatibility(manifest(2), {}, DSH, DELORUN)
    expect(issue?.delorun).toEqual({ delorunVersion: DELORUN, status: 'unreadable' })
    expect(pluginCompatibilityWarning(issue!)).toContain(`example-delorun-plugin@1.4.0 declares engines.delorun in a form Delorun cannot read; this is Delorun ${DELORUN} on DSH ${DSH}.`)
  })

  it('keeps a plugin without engines.delorun exactly as it was', () => {
    expect(evaluateDelorunRequirement(manifest(), DELORUN)).toBeUndefined()
    expect(evaluatePluginCompatibility(manifest(undefined, '>=0.0.0'), {}, DSH, DELORUN)).toBeUndefined()
    expect(evaluatePluginCompatibility(manifest(), {}, DSH, DELORUN)).toBeUndefined()
    // Its dsh range still decides, as on stock DSH.
    expect(evaluatePluginCompatibility(manifest(undefined, '<0.0.1'), {}, DSH, DELORUN)?.requirements).toEqual({ 'engines.dsh': '<0.0.1' })
  })

  it('checks no Delorun axis when Delorun\'s version is unknown', () => {
    expect(evaluateDelorunRequirement(manifest('>=2.0.0'), undefined)).toBeUndefined()
    expect(evaluatePluginCompatibility(manifest('>=2.0.0'), {}, DSH, undefined)).toBeUndefined()
  })
})

describe('engines.delorun decides alone (A567)', () => {
  it('admits a plugin whose engines.delorun is met and whose engines.dsh is unmet', () => {
    expect(evaluatePluginCompatibility(manifest(RANGE, '<0.0.1'), {}, DSH, DELORUN)).toBeUndefined()
  })

  it('admits it when a dsh peer is unmet too, and when the dsh declarations are malformed', () => {
    const peers = { name: 'p', version: '1.0.0', engines: { delorun: RANGE, dsh: 7 }, peerDependencies: { '@deepseek-ai/dsh-session': '^99' } }
    expect(evaluatePluginCompatibility(peers, {}, DSH, DELORUN)).toBeUndefined()
    expect(evaluatePluginCompatibility({ ...peers, peerDependencies: 'not an object' }, {}, DSH, DELORUN)).toBeUndefined()
  })

  it('refuses a plugin whose engines.delorun is unmet and whose engines.dsh is met, naming no dsh requirement', () => {
    const issue = evaluatePluginCompatibility(manifest('>=2.0.0', '>=0.0.0'), {}, DSH, DELORUN)
    expect(issue?.delorun).toEqual({ delorunVersion: DELORUN, status: 'unmet', requirement: '>=2.0.0' })
    expect(issue?.requirements).toEqual({})
    expect(pluginCompatibilityWarning(issue!)).not.toContain('is incompatible with dsh')
  })

  it('refuses an unreadable engines.delorun without falling back to a met engines.dsh', () => {
    const issue = evaluatePluginCompatibility(manifest(2, '>=0.0.0'), {}, DSH, DELORUN)
    expect(issue?.delorun?.status).toBe('unreadable')
  })

  it.each(['', ' ', '  '])('refuses an engines.delorun of %j as unreadable beside a met engines.dsh, and an unmet one too', (range) => {
    for (const dsh of ['>=0.0.0', '<0.0.1']) {
      const issue = evaluatePluginCompatibility(manifest(range, dsh), {}, DSH, DELORUN)
      expect(issue?.delorun?.status).toBe('unreadable')
      expect(issue?.requirements).toEqual({})
      expect(issue?.exempted).toBe(false)
    }
  })

  it('reads engines.dsh again on stock DSH, where Delorun\'s version is unknown', () => {
    expect(evaluatePluginCompatibility(manifest(RANGE, '<0.0.1'), {}, DSH, undefined)?.requirements).toEqual({ 'engines.dsh': '<0.0.1' })
  })
})

describe('exemptions', () => {
  it('does not let the dsh exemption admit an unmet Delorun requirement', () => {
    const issue = evaluatePluginCompatibility(manifest('>=2.0.0', '<0.0.1'), { 'example-delorun-plugin@1.4.0': [DSH] }, DSH, DELORUN)
    expect(issue?.requirements).toEqual({})
    expect(issue?.exempted).toBe(false)
    expect(pluginCompatibilityWarning(issue!)).toContain('Exact-version exemption: not active.')
  })

  it('still admits a dsh-only mismatch the person exempted, for a plugin without engines.delorun', () => {
    const issue = evaluatePluginCompatibility(manifest(undefined, '<0.0.1'), { 'example-delorun-plugin@1.4.0': [DSH] }, DSH, DELORUN)
    expect(issue?.exempted).toBe(true)
    expect(pluginCompatibilityWarning(issue!)).toContain('Exact-version exemption: active.')
  })
})
