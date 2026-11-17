import { describe, expectTypeOf, it } from 'vitest'
import type { AccountObservation, ExternalAgentName, ExternalAgentsGate } from '../src/contract.ts'

describe('the gate\'s limits check', () => {
  it('takes only the agent and an abort signal: no folder, no child and no input', () => {
    expectTypeOf<ExternalAgentsGate['probe']>().parameters.toEqualTypeOf<[ExternalAgentName, AbortSignal]>()
    expectTypeOf<ExternalAgentsGate['probe']>().returns.toEqualTypeOf<Promise<AccountObservation>>()
    const probe = (_gate: ExternalAgentsGate): void => {
      const signal = new AbortController().signal
      // @ts-expect-error a limits check takes no folder
      void _gate.probe({ provider: 'codex', cwd: '/tmp', signal })
      // @ts-expect-error a limits check takes no child or third argument
      void _gate.probe('codex', signal, { child: 'seat' })
    }
    expectTypeOf(probe).toBeFunction()
  })
})
