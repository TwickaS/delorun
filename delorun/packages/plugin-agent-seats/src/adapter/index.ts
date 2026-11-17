/**
 * The seat model adapter and the ports it takes: its routes serve only a seat child's own turn.
 * @module @delorun/plugin-agent-seats/adapter
 */
export { SeatAdapter, type SeatAdapterOptions, type SeatHost } from './adapter.ts'
export {
  gateRefusal, HISTORY_PARTED, PROGRAM_CLOSED, programFailure, SEAT_FOLDER_UNKNOWN, SEAT_ROUTE_REFUSED,
  SEAT_ROUTE_REFUSED_MESSAGE, TASK_UNSEPARABLE, type FixedFailure,
} from './failure.ts'
export { newInput, RESULT_DELIVERY_GUIDANCE, type HarnessResult, type NewInput, type NewInputOptions } from './input.ts'
export { registerSeatRoutes, type SeatRouteDependencies, type SeatRouteRegistration, type SeatRouteSpec } from './register.ts'
export { SeatRun, type ProgramToolResult } from './run.ts'
export type {
  ModelNotOffered, SeatAdapterEvents, SeatModelChoices, SeatState, SeatStateStore,
} from './state-port.ts'
