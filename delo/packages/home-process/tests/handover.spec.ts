/**
 * The handover line a successor reads (contract C19, "Compatibility"): every field this release knows is checked, a
 * field it does not know is dropped so a predecessor may add an optional one, and a `v` other than 1 is refused.
 */
import { describe, expect, it } from 'vitest'
import { parseHandoverLine } from '../src/handover.ts'

const PROTECTION = { protectedHome: '/h', protectedHomeReadable: ['runtimes'], deniedSockets: ['/h/run/default/update.sock'], escapeSocketDirectories: ['/run/WSL'], privateTmp: true }

/**
 * A handover line as a predecessor writes it.
 * @param change - fields to replace.
 * @param health - health fields to replace.
 * @returns the line's text.
 */
function line(change: Record<string, unknown> = {}, health: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'handover', v: 1, home: '/h', profile: 'default', from: '0.1.0', to: '0.2.0', startId: 'a'.repeat(32), startedAt: '2026-11-11T08:00:00.000Z',
    health: { disabledPlugins: [], namedRows: [], previousFailures: [], previousRows: [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', generated: false, configHash: 'b'.repeat(64) }], ...health },
    ...change,
  })
}

describe('the handover line', () => {
  it('carries the previous Host\'s sandbox protection, requires its privateTmp, and reads a line without it', () => {
    expect(parseHandoverLine(line({}, { previousProtection: PROTECTION })).health.previousProtection).toEqual(PROTECTION)
    const { privateTmp: _absent, ...withoutPrivateTmp } = PROTECTION
    expect(() => parseHandoverLine(line({}, { previousProtection: withoutPrivateTmp }))).toThrow('health.previousProtection.privateTmp')
    expect(parseHandoverLine(line()).health).not.toHaveProperty('previousProtection')
  })

  it('drops a field this release does not know, at the top, in the health expectations and in a row', () => {
    const read = parseHandoverLine(line({ later: 1 }, { laterHealth: true, previousRows: [{ id: 'a', name: 'p', generated: false, laterRow: 'x' }], previousProtection: { ...PROTECTION, laterProtection: [] } }))
    expect(read).not.toHaveProperty('later')
    expect(read.health).not.toHaveProperty('laterHealth')
    expect(read.health.previousRows).toEqual([{ id: 'a', name: 'p', generated: false }])
    expect(read.health.previousProtection).toEqual(PROTECTION)
  })

  it('refuses another version and a known field of the wrong type, naming the field', () => {
    expect(() => parseHandoverLine(line({ v: 2 }))).toThrow('the handover line is not valid at v')
    expect(() => parseHandoverLine(line({}, { previousProtection: { ...PROTECTION, deniedSockets: '/h/run/default/update.sock' } }))).toThrow('at health.previousProtection.deniedSockets')
    expect(() => parseHandoverLine(line({}, { previousProtection: { ...PROTECTION, protectedHome: undefined } }))).toThrow('at health.previousProtection.protectedHome')
  })
})
