/**
 * The home's Browser choice and the page's states: a home that never chose is on, a home that chose off stays off, and
 * each way the pack and the requirement check can disagree resolves to one state. Each denial test's comment names the
 * rule whose removal makes it fail.
 */
import { describe, expect, it } from 'vitest'
import { browserPageState, resolveBrowserSwitch, type BrowserPageInput, type BrowserReadiness, type PackProgress } from '../src/index.ts'

const NOT_ADDED: BrowserReadiness = { kind: 'not-added' }
const fix = { kind: 'command', command: 'delorun browser install' } as const

const state = (change: Partial<BrowserPageInput>) => browserPageState({ choice: 'on', pack: 'installed', readiness: { kind: 'ready' }, ...change })

describe('resolveBrowserSwitch', () => {
  it('is on for a home that never chose', () => {
    expect(resolveBrowserSwitch(undefined)).toBe('on')
    expect(resolveBrowserSwitch('')).toBe('on')
  })

  it('is on for a home that chose on', () => {
    expect(resolveBrowserSwitch('on')).toBe('on')
  })

  // Reading any value but `off` as on would turn Browser back on for a home that chose off.
  it('keeps a home that chose off off', () => {
    expect(resolveBrowserSwitch('off')).toBe('off')
  })

  // A damaged record fails open to the default, never to a surprise off.
  it('reads an unknown value as the default', () => {
    expect(resolveBrowserSwitch('maybe')).toBe('on')
  })

  // Turning the pack off in Plugins is a choice too; reading it as never chosen would turn Browser back on at the next visit.
  it('keeps a home that turned the pack off in Plugins off when it recorded nothing', () => {
    expect(resolveBrowserSwitch('', true)).toBe('off')
    expect(resolveBrowserSwitch(undefined, true)).toBe('off')
  })

  it('lets a recorded choice outrank the pack\'s state', () => {
    expect(resolveBrowserSwitch('on', true)).toBe('on')
    expect(resolveBrowserSwitch('off', false)).toBe('off')
  })
})

describe('browserPageState', () => {
  // The choice outranks everything else: a pack that is on and ready still reads off after the person chose off.
  it('shows off whatever the pack and the check say', () => {
    expect(state({ choice: 'off' })).toEqual({ kind: 'off' })
    expect(state({ choice: 'off', pack: 'failed', readiness: { kind: 'needs-setup', reason: 'x', fix } })).toEqual({ kind: 'off' })
  })

  it('shows ready when the Host says ready', () => {
    expect(state({})).toEqual({ kind: 'ready' })
  })

  // The Host's own answer wins over the installer's last word, so a download the person finished clears the state.
  it('shows what the Host needs before the installer\'s progress', () => {
    const readiness: BrowserReadiness = { kind: 'needs-setup', reason: 'Needs the Chromium download', fix }
    expect(state({ pack: 'installing', readiness })).toEqual({ kind: 'needs-setup', reason: 'Needs the Chromium download', fix })
  })

  it('shows the pack\'s own problem', () => {
    expect(state({ readiness: { kind: 'problem', message: 'no declaration' } })).toEqual({ kind: 'failed', failure: { cause: 'problem', message: 'no declaration' } })
  })

  it.each([
    ['available', { kind: 'installing', slow: false }],
    ['installing', { kind: 'installing', slow: false }],
    ['slow', { kind: 'installing', slow: true }],
    ['restart', { kind: 'restart' }],
    ['offline', { kind: 'failed', failure: { cause: 'offline' } }],
  ] as const)('shows the pack that is %s while the Host lists none', (pack: PackProgress, expected) => {
    expect(state({ pack, readiness: NOT_ADDED })).toEqual(expected)
  })

  it('keeps the installer\'s words for a pack that cannot be added', () => {
    expect(state({ pack: 'unavailable', packReason: 'a source checkout', readiness: NOT_ADDED })).toEqual({ kind: 'failed', failure: { cause: 'unavailable', reason: 'a source checkout' } })
    expect(state({ pack: 'failed', packReason: 'disk full', readiness: NOT_ADDED })).toEqual({ kind: 'failed', failure: { cause: 'failed', reason: 'disk full' } })
  })

  it('checks while the first answers are pending', () => {
    expect(state({ pack: 'checking', readiness: { kind: 'checking' } })).toEqual({ kind: 'checking' })
    expect(state({ pack: 'installed', readiness: { kind: 'checking' } })).toEqual({ kind: 'checking' })
  })

  // A check that cannot be read must not look like a Browser that is still starting.
  it('says the check was unreadable instead of waiting forever', () => {
    expect(state({ pack: 'checking', readiness: { kind: 'failed' } })).toEqual({ kind: 'failed', failure: { cause: 'unread' } })
    expect(state({ pack: 'installed', readiness: { kind: 'failed' } })).toEqual({ kind: 'failed', failure: { cause: 'unread' } })
  })
})
