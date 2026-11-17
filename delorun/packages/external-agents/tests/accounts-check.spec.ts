/**
 * A limits check through the start gate (`src/accounts/check.ts`): the gate's answer and each of its refusals as the
 * account service reads them.
 */
import { describe, expect, it } from 'vitest'
import { GateRefusedError, type AccountObservation, type GateRefusal } from '../src/contract.ts'
import { checkThrough } from '../src/accounts/check.ts'

const signal = new AbortController().signal
const OBSERVED: AccountObservation = { provider: 'codex', signedIn: 'yes', windows: [], source: 'probe' }

/**
 * @param refusal - the gate's refusal.
 * @returns a check over a gate that refuses with it.
 */
const refusing = (refusal: GateRefusal) => checkThrough({ probe: () => Promise.reject(new GateRefusedError(refusal)) })

describe('a check through the gate', () => {
  it('passes on the program\'s figures', async () => {
    await expect(checkThrough({ probe: () => Promise.resolve(OBSERVED) })('codex', signal)).resolves.toEqual({ kind: 'observed', observation: OBSERVED })
  })

  it('reads each gate refusal as not installed or refused, with a sentence for the person', async () => {
    await expect(refusing({ category: 'not-installed' })('codex', signal)).resolves.toEqual({ kind: 'not-installed' })
    await expect(refusing({ category: 'capacity', busy: ['claude-code', 'codex'] })('codex', signal)).resolves.toEqual({
      kind: 'refused', problem: 'The most agent programs this home runs at once are running (Claude Code, Codex). Check again once one finishes.',
    })
    await expect(refusing({ category: 'consent', reason: 'No.' })('codex', signal)).resolves.toEqual({ kind: 'refused', problem: 'No.' })
    await expect(refusing({ category: 'limit', window: 'five-hour', resetsAt: 1 })('claude-code', signal)).resolves.toEqual({ kind: 'refused', problem: 'Claude Code is at a plan limit, so it was not checked.' })
  })

  it('reads any other failure as a check that did not answer', async () => {
    await expect(checkThrough({ probe: () => Promise.reject(new Error('exited with code 1')) })('codex', signal)).resolves.toEqual({ kind: 'failed', problem: 'exited with code 1' })
  })
})
