/** How the supervisor's errors read as refusals: C9's code with its detail, and the Docker engine's answer. */
import { describeFailure } from '@delo/home'
import { describe, expect, it } from 'vitest'
import { EngineError, engineDescriber, SupervisorError, supervisorDescriber } from '../src/index.ts'

describe('a supervisor refusal', () => {
  it('keeps C9\'s code and detail', () => {
    expect(describeFailure(new SupervisorError('BUSY', '8 connections are open'), [supervisorDescriber])).toEqual({ lead: 'The runtime supervisor refused the request.', reason: 'BUSY: 8 connections are open', remedies: [] })
  })

  it('offers to start Docker only when the engine did not answer', () => {
    expect(describeFailure(new EngineError(0, 'connect ENOENT /var/run/docker.sock'), [engineDescriber])).toEqual({ lead: 'Delorun could not use the Docker engine.', reason: 'docker engine: connect ENOENT /var/run/docker.sock', remedies: ['Check that Docker is running, then run the same command again.'] })
    expect(describeFailure(new EngineError(404, 'no such container'), [engineDescriber])).toEqual({ lead: 'Delorun could not use the Docker engine.', reason: 'docker engine: no such container (HTTP 404)', remedies: [] })
  })
})
