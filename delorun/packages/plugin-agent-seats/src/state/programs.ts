/**
 * The `seatPrograms` service the seat executor injects, implemented over the adapters' live seats.
 * @module @delorun/plugin-agent-seats/state/programs
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import { CallRecordLedger } from '../executor/ledger.ts'
import type { SeatProgram, SeatPrograms } from '../executor/types.ts'

/**
 * The live program sessions of seat children.
 * @param runOf - the live seat of a child; the adapter's `runOf`, over every seat route.
 * @param records - the ledger of written call records; one is made when not given.
 * @returns the service.
 */
export function seatPrograms(runOf: (child: SessionId) => SeatProgram | undefined, records: CallRecordLedger = new CallRecordLedger()): SeatPrograms {
  return { records, program: sessionId => runOf(sessionId) }
}
