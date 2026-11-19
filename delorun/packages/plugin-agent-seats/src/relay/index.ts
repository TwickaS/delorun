/**
 * The seat relay: how a live agent's permission questions reach the person.
 * @module @delorun/plugin-agent-seats/relay
 */
export { EXTERNAL_AGENT_GRANT, SeatRelay, assertMarked, type PrepareResult, type SeatRelayOptions } from './relay.ts'
export { RUN_ANSWER, RUN_SCOPE, RunScope } from './run-scope.ts'
export { seatRelay } from './hook.ts'
