import { describe, expect, it } from 'vitest'
import { CODEX_LEVELS, levelPolicy, ownApprovalPolicy, threadMatches, type LevelPolicy } from '../src/levels.ts'

const RUN = '/work/run'

describe('agent levels (EA34)', () => {
  it('maps each level to its thread and turn settings', () => {
    expect(Object.fromEntries(CODEX_LEVELS.map(level => [level, levelPolicy(level, RUN, 'untrusted')]))).toEqual({
      careful: {
        thread: { approvalPolicy: 'on-request', sandbox: 'read-only' },
        turn: { type: 'workspaceWrite', writableRoots: [RUN], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      },
      standard: {
        thread: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'read-only' },
        turn: { type: 'workspaceWrite', writableRoots: [RUN], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      },
      own: { thread: { approvalPolicy: 'untrusted' } },
      unrestricted: { thread: { approvalPolicy: 'on-request', sandbox: 'read-only' }, turn: { type: 'dangerFullAccess' } },
    })
  })

  it('never asks Codex for a writable thread sandbox, which would write a trust entry', () => {
    for (const level of CODEX_LEVELS) expect([undefined, 'read-only']).toContain(levelPolicy(level, RUN, 'on-request').thread.sandbox)
  })

  it.each([
    ['untrusted', 'untrusted'],
    ['on-request', 'on-request'],
    ['never', 'on-request'],
    [null, 'on-request'],
    [undefined, 'on-request'],
    [{ granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } }, 'on-request'],
  ])('runs the own level under %j as %s', (configured, used) => {
    expect(ownApprovalPolicy(configured)).toBe(used)
  })

  describe('the opened thread', () => {
    const standard = levelPolicy('standard', RUN, 'on-request')
    const own = levelPolicy('own', RUN, 'untrusted')
    const readOnly = { type: 'readOnly' }

    it('matches when Codex reports the level\'s settings', () => {
      expect(threadMatches(standard, { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: readOnly })).toBe(true)
      expect(threadMatches(own, { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } })).toBe(true)
    })

    it.each<[string, LevelPolicy, Parameters<typeof threadMatches>[1]]>([
      ['another policy', standard, { approvalPolicy: 'never', approvalsReviewer: 'auto_review', sandbox: readOnly }],
      ['another reviewer', standard, { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: readOnly }],
      ['no reviewer', standard, { approvalPolicy: 'on-request', sandbox: readOnly }],
      ['a writable thread sandbox', standard, { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: { type: 'dangerFullAccess' } }],
      ['another policy under own', own, { approvalPolicy: 'on-request', sandbox: readOnly }],
    ])('refuses %s', (_name, policy, opened) => {
      expect(threadMatches(policy, opened)).toBe(false)
    })
  })
})
