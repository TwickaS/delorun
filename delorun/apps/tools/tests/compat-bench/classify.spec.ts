import { describe, expect, it } from 'vitest'
import { classifyFailure, findPluginLocation, normaliseSignature } from '../../src/compat-bench/classify.ts'

describe('error signatures', () => {
  it('reads one failure the same on two runs', () => {
    const one = normaliseSignature('2026-11-22T10:01:02.123Z Error: ENOENT /tmp/abc123/profiles/default/x.json on port :18711 after 340ms')
    const two = normaliseSignature('2026-11-23T11:11:12.999Z Error: ENOENT /tmp/zzz999/profiles/default/x.json on port :18722 after 12ms')
    expect(one).toBe(two)
    expect(one.length).toBeLessThanOrEqual(160)
  })
})

describe('classification', () => {
  it('names an engines refusal version-range, with the fix class from causes.json', () => {
    const failure = classifyFailure('install', ['delorun: installation rejected: engines.dsh ^9.0.0 does not satisfy 0.2.2-rc.3', 'delorun: nothing was installed.'])
    expect(failure.cause).toBe('version-range')
    expect(failure.fixClass).toBe('delorun-fix')
    expect(failure.evidence).toHaveLength(2)
  })

  it('names a missing module while loading load-error and carries the plugin location', () => {
    const failure = classifyFailure('start', ['dsh-x: failed to import: Error: Cannot find package \'left-pad\''], 'lib/index.js:3')
    expect(failure.cause).toBe('load-error')
    expect(failure.location).toBe('lib/index.js:3')
  })

  it('falls back to the stage default and never invents a cause', () => {
    expect(classifyFailure('harness', ['no reply in 30s']).cause).toBe('harness-broken')
    expect(classifyFailure('screens', ['pageerror: boom']).cause).toBe('ui-error')
    expect(classifyFailure('uninstall', ['left a folder']).cause).toBe('files-in-home')
  })

  it('finds the plugin\'s own file and line, not Delorun\'s', () => {
    const text = 'Error: boom\n    at apply (file:///opt/delorun/packages/x/lib/a.js:10:5)\n    at apply (file:///home/bench/home/profiles/default/node_modules/dsh-x/lib/index.js:7:11)'
    expect(findPluginLocation(text)).toBe('dsh-x/lib/index.js:7')
    expect(findPluginLocation('nothing here')).toBeUndefined()
  })
})
