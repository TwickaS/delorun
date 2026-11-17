/**
 * The seat tool executor and the seat preset definition.
 * @module @delorun/plugin-agent-seats/executor
 */
export { CallRecordLedger, type CallRecordedListener } from './ledger.ts'
export { cutOutput, SEAT_OUTPUT_CAP, type CutOutput, type OutputCap } from './output-cap.ts'
export {
  RECORD_PROGRAM_LOST, RECORD_STOPPED, SeatProgramMissingError, SeatToolExecutor, type SeatToolExecutorOptions,
} from './executor.ts'
export { apply, Config, inject, name, SEAT_MAX_PARALLEL_HARNESS_TOOLS, schema } from './plugin.ts'
export { recordPrefixOf, SEAT_EXECUTOR_MODULE, seatPreset } from './preset.ts'
export type { SeatProgram, SeatProgramResult, SeatPrograms } from './types.ts'
