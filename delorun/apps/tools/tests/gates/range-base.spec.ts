import { describe, expect, it } from 'vitest'
import { GATES, gatesFor, rangeBase, rangeBaseOverridden, unresolvedRangeBase } from '../../src/checks/gates/index.ts'

describe('the range base of the range gates', () => {
  it('is origin/main unless DELORUN_RANGE_BASE names another ref', () => {
    expect(rangeBase({})).toBe('origin/main')
    expect(rangeBase({ DELORUN_RANGE_BASE: '' })).toBe('origin/main')
    expect(rangeBase({ DELORUN_RANGE_BASE: 'v0.1.0-rc.7' })).toBe('v0.1.0-rc.7')
    expect(rangeBaseOverridden({})).toBe(false)
    expect(rangeBaseOverridden({ DELORUN_RANGE_BASE: '' })).toBe(false)
    expect(rangeBaseOverridden({ DELORUN_RANGE_BASE: 'v0.1.0-rc.7' })).toBe(true)
  })

  it('reaches the --base of every command that reads the range, and the default catalogue keeps origin/main', () => {
    const baseOf = (gates: typeof GATES) => gates.filter(gate => gate.history === true).map((gate) => {
      const at = gate.command.indexOf('--base')
      return [gate.id, at < 0 ? undefined : gate.command[at + 1]]
    })
    const overridden = baseOf(gatesFor('v0.1.0-rc.7'))
    expect(overridden.map(([id]) => id)).toEqual(['gates:personal-data', 'gates:dco', 'gates:commits', 'gates:changelog', 'gates:doc-times', 'gates:whitespace'])
    expect(overridden.every(([, base]) => base === 'v0.1.0-rc.7')).toBe(true)
    expect(baseOf(GATES).every(([, base]) => base === 'origin/main')).toBe(true)
  })

  it('leaves the other gates unchanged', () => {
    const plain = (gates: typeof GATES) => gates.filter(gate => gate.history !== true).map(gate => gate.command.join(' '))
    expect(plain(gatesFor('v0.1.0-rc.7'))).toEqual(plain(GATES))
  })

  it('refuses with one line that names the ref and the way out', () => {
    expect(unresolvedRangeBase('does-not-exist')).toBe('the range base does-not-exist is not a commit in this clone; fetch it, or set DELORUN_RANGE_BASE to a commit')
  })
})
