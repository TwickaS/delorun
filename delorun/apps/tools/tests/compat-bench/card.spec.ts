import { describe, expect, it } from 'vitest'
import { CARD_SCHEMA, INDEPENDENCE_LINE, PRIVACY_LINE, PRIVACY_NOT_RECORDED, deriveVerdict, loadCauses, renderCard, validateCard, type Card, type StageResult } from '../../src/compat-bench/card.ts'

const pass = (name: StageResult['name']): StageResult => ({ name, status: 'pass', durationMs: 1200, failures: [] })

/** A valid card, with each stage passing. */
function sample(overrides: Partial<Card> = {}): Card {
  return {
    schema: CARD_SCHEMA, runId: 'r1', startedAt: '2026-11-22T10:00:00.000Z',
    plugin: { package: 'dsh-context', version: '1.2.3', repository: 'https://example.invalid/dsh-context', licence: 'MIT', engines: { dsh: '^0.2.2' } },
    host: { kind: 'delorun', version: '0.1.0-preview.3', commit: 'abc1234', shims: true },
    stages: (['install', 'start', 'harness', 'screens', 'feature', 'restart', 'update', 'clashes', 'cost', 'uninstall'] as const).map(pass),
    verdict: 'works', notes: [],
    ...overrides,
  }
}

const failed = (name: StageResult['name'], cause: string, fixClass: 'delorun-fix' | 'by-design' | 'parked' | 'upstream' | 'delorun-shim', extra: Partial<StageResult['failures'][number]> = {}): StageResult =>
  ({ name, status: 'fail', durationMs: 5, failures: [{ signature: 'Error: boom <n>', evidence: ['log line'], cause, fixClass, ...extra }] })

describe('card validation', () => {
  it('accepts a valid card and ships a cause list', () => {
    expect(validateCard(sample()).ok).toBe(true)
    expect(loadCauses().map(cause => cause.id)).toEqual(expect.arrayContaining(['approval-answering', 'plugin-manager-bypass', 'own-remote-channel', 'files-in-home', 'studio-overlap', 'stock-default-differs', 'fetch-outside-guard', 'version-range', 'needs-account', 'needs-real-model', 'platform', 'harness-broken', 'load-error', 'ui-error']))
  })

  it('refuses a wrong schema id, an unknown field, a bad verdict and a duplicate stage', () => {
    expect(validateCard({ ...sample(), schema: 'other/1' }).ok).toBe(false)
    expect(validateCard({ ...sample(), extra: 1 }).ok).toBe(false)
    expect(validateCard({ ...sample(), verdict: 'fine' }).ok).toBe(false)
    const twice = validateCard(sample({ stages: [pass('install'), pass('install')] }))
    expect(twice.ok).toBe(false)
  })

  it('refuses a failure with an unknown cause, a failed stage with no failure and a skip with no reason', () => {
    const unknown = validateCard(sample({ stages: [failed('install', 'made-up', 'upstream')] }))
    expect(unknown.ok ? [] : unknown.problems).toEqual(['stages.install: unknown cause "made-up"'])
    const bare = validateCard(sample({ stages: [{ name: 'install', status: 'fail', durationMs: 1, failures: [] }] }))
    expect(bare.ok).toBe(false)
    const skipped = validateCard(sample({ stages: [{ name: 'feature', status: 'skipped', durationMs: 0, failures: [] }] }))
    expect(skipped.ok ? [] : skipped.problems).toEqual(['stages.feature: skipped needs a reason'])
  })
})

describe('verdicts', () => {
  it('works when every stage passed, partly tested when one was skipped', () => {
    expect(deriveVerdict(sample().stages)).toBe('works')
    expect(deriveVerdict([pass('install'), { name: 'feature', status: 'skipped', reason: 'no exercise', durationMs: 0, failures: [] }])).toBe('works-partly-tested')
  })

  it('is blocked when the install or the harness fails for a cause upstream owns', () => {
    expect(deriveVerdict([failed('install', 'version-range', 'delorun-fix')])).toBe('blocked')
    expect(deriveVerdict([pass('install'), pass('start'), failed('harness', 'harness-broken', 'upstream')])).toBe('blocked')
  })

  it('is works-with-delorun-fix when the core stages passed and every failure is Delorun\'s to fix', () => {
    expect(deriveVerdict([pass('install'), pass('start'), pass('harness'), failed('clashes', 'studio-overlap', 'delorun-shim')])).toBe('works-with-delorun-fix')
  })

  it('is by-design or parked when every failure is of that class', () => {
    expect(deriveVerdict([pass('install'), failed('feature', 'own-remote-channel', 'by-design')])).toBe('by-design')
    expect(deriveVerdict([pass('install'), failed('feature', 'needs-account', 'parked')])).toBe('parked')
  })
})

describe('card render', () => {
  it('shows the verdict, stages, the not-recorded privacy line, and no allowance wording (L141)', () => {
    const text = renderCard(sample())
    expect(text).toContain('# dsh-context@1.2.3 on Delorun 0.1.0-preview.3')
    expect(text).toContain('Worked in the test.')
    expect(text).toContain('Seen in one test run (10 of 10 stages run, shims on)')
    expect(text).toContain(PRIVACY_NOT_RECORDED)
    expect(text).not.toContain(INDEPENDENCE_LINE)
    expect(text).not.toMatch(/can only|allowed|permission/i)
  })

  it('renders the eight markers with the fixed line, and says when contents were not checked', () => {
    const marker = (state: 'not-seen' | 'seen', evidence: string[] = []): { state: 'not-seen' | 'seen', summary: string, evidence: string[] } => ({ state, summary: '', evidence })
    const card = sample({ privacy: { contentsChecked: false, markers: { code: marker('not-seen'), chats: marker('seen', ['canary left to example.invalid']), modelKeys: marker('not-seen'), otherSecrets: marker('not-seen'), sendsOut: marker('seen', ['GET example.invalid']), actsForYou: marker('not-seen'), opensADoor: marker('not-seen'), leavesBehind: marker('not-seen') } } })
    const text = renderCard(card)
    for (const label of ['Your code', 'Your chats', 'Model keys', 'Other secrets', 'Sends out', 'Acts for you', 'Opens a door', 'Leaves behind']) expect(text).toContain(label)
    expect(text).toContain(PRIVACY_LINE)
    expect(text).toContain('| Your chats | seen in test |')
    expect(text).toContain('<summary>Details</summary>')
    expect(text).toContain('Contents of encrypted traffic were not checked.')
    expect(text).not.toContain(PRIVACY_NOT_RECORDED)
  })

  it('carries the A574 line in the public render', () => {
    expect(renderCard(sample(), { public: true })).toContain(INDEPENDENCE_LINE)
  })

  it('leaves out embargoed items in the public render and keeps them in the private one', () => {
    const card = sample({ stages: [pass('install'), failed('start', 'load-error', 'upstream', { signature: 'SECRET-FLAW-SIGNATURE', embargoed: true }), failed('harness', 'harness-broken', 'upstream', { signature: 'open-signature' })] })
    const publicText = renderCard(card, { public: true })
    expect(publicText).not.toContain('SECRET-FLAW-SIGNATURE')
    expect(publicText).toContain('open-signature')
    expect(publicText).toContain('1 item held back')
    expect(renderCard(card)).toContain('SECRET-FLAW-SIGNATURE')
  })

  it('holds the whole card back in the public render while its embargo date has not passed', () => {
    const card = sample({ embargo: '2026-12-22', notes: ['a note'] })
    const during = renderCard(card, { public: true, now: new Date('2026-11-30T00:00:00Z') })
    expect(during).toContain('Details are held back until 2026-12-22')
    expect(during).not.toContain('## Stages')
    expect(renderCard(card, { public: true, now: new Date('2027-01-01T00:00:00Z') })).toContain('## Stages')
    expect(renderCard(card, { now: new Date('2026-11-30T00:00:00Z') })).toContain('## Stages')
  })
})
