/**
 * How the supervisor's errors read in `@delo/home`'s refusal format: a {@link SupervisorError} with contract C9's code,
 * and an {@link EngineError} the Docker engine raised.
 *
 * @module @delo/supervisor/refusal
 */
import { codedReason, refusalDescriber, type RefusalDescriber } from '@delo/home'
import { EngineError } from './docker/engine.ts'
import { SupervisorError } from './errors.ts'

/** How a {@link SupervisorError} reads: the runtime supervisor refused, with C9's code and detail. */
export const supervisorDescriber: RefusalDescriber<SupervisorError> = refusalDescriber(SupervisorError, error => ({
  lead: 'The runtime supervisor refused the request.',
  reason: codedReason(error.code, error.detail),
  remedies: [],
}))

/** How an {@link EngineError} reads: Delo could not use Docker, with the engine's message, and its HTTP status when it answered. */
export const engineDescriber: RefusalDescriber<EngineError> = refusalDescriber(EngineError, error => ({
  lead: 'Delorun could not use the Docker engine.',
  reason: error.status === 0 ? error.message : `${error.message} (HTTP ${String(error.status)})`,
  remedies: error.status === 0 ? ['Check that Docker is running, then run the same command again.'] : [],
}))
