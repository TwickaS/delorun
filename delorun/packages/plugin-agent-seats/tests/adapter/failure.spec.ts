/** Specs of the sentences and codes a person and the model meet when a seat's turn cannot run or fails. */
import { describe, expect, it } from 'vitest'
import { gateRefusal, programFailure } from '../../src/adapter/failure.ts'

describe('the sentence for a program that failed', () => {
  it.each([
    [{ category: 'signed-out' }, 'The agent is not signed in.', 'EXTERNAL_AGENT_SIGNED_OUT'],
    [{ category: 'limit' }, 'The agent\'s plan limit is reached.', 'EXTERNAL_AGENT_LIMIT'],
    [{ category: 'limit', resetsAt: Date.UTC(2026, 10, 18, 9, 30) }, 'The agent\'s plan limit is reached. It resets at 2026-11-18T09:30:00.000Z.', 'EXTERNAL_AGENT_LIMIT'],
    [{ category: 'model-not-offered', configured: 'big', offered: [] }, 'The agent\'s model is not offered on this plan. Pick another model.', 'EXTERNAL_AGENT_MODEL_NOT_OFFERED'],
    [{ category: 'resume-failed' }, 'The agent\'s own session could not be resumed.', 'EXTERNAL_AGENT_RESUME_FAILED'],
    [{ category: 'time-limit', limitMs: 1_800_000 }, 'The agent\'s turn was stopped at its time limit of 30 minutes.', 'EXTERNAL_AGENT_TIME_LIMIT'],
    [{ category: 'program', detail: 'the program\'s own words' }, 'The agent\'s turn failed.', 'EXTERNAL_AGENT_FAILED'],
  ] as const)('words %j', (failure, message, code) => {
    expect(programFailure(failure)).toEqual({ message, code })
  })

  it('never repeats the program\'s own words', () => {
    expect(programFailure({ category: 'program', detail: 'secret path /home/x' }).message).not.toContain('/home/x')
  })

  it('refuses a category it does not know rather than wording it', () => {
    expect(() => programFailure({ category: 'invented' } as never)).toThrow(/unhandled external agent failure/)
  })
})

describe('the sentence for a start the gate refused', () => {
  it.each([
    [{ category: 'not-installed' }, 'The agent is not added to this Delorun.', 'EXTERNAL_AGENT_NOT_INSTALLED'],
    [{ category: 'consent', reason: 'Running agents is switched off.' }, 'Running agents is switched off.', 'EXTERNAL_AGENT_CONSENT'],
    [{ category: 'limit', window: '5h', resetsAt: Date.UTC(2026, 10, 18, 9, 30) }, 'The agent\'s plan limit is reached. It resets at 2026-11-18T09:30:00.000Z.', 'EXTERNAL_AGENT_LIMIT'],
    [{ category: 'capacity', busy: ['codex'] }, 'Too many agents are running. Wait for one to finish.', 'EXTERNAL_AGENT_CAPACITY'],
    [{ category: 'seat-running' }, 'The agent is already running for this chat.', 'EXTERNAL_AGENT_RUNNING'],
  ] as const)('words %j', (refusal, message, code) => {
    expect(gateRefusal(refusal)).toEqual({ message, code })
  })

  it('refuses a category it does not know rather than wording it', () => {
    expect(() => gateRefusal({ category: 'invented' } as never)).toThrow(/unhandled external agent failure/)
  })
})
