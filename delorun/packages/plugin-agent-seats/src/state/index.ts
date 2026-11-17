/**
 * The seat's logged state, its `agentSeat` projection, the model picks, the Host routes and Stop.
 * @module @delorun/plugin-agent-seats/state
 */
export { FileModelChoices, loadModelChoices, MODEL_CHOICES_FILE } from './choices.ts'
export {
  agentOfProvider, DEFAULT_OWN_SETTINGS, foldSeat, LAST_ANSWER_LIMIT, NO_LOGGED, NO_SHOWN, SEAT_FOLD_VERSION, viewOf,
  type SeatLogged, type SeatProjectionState, type SeatShown,
} from './fold.ts'
export { mountSeatState, type SeatStateMount, type SeatStateOptions } from './mount.ts'
export { partingNotice, unresumableNotice, type PartingNotice, type ProgramTail, type ProgramTailReader } from './parting.ts'
export { seatPrograms } from './programs.ts'
export { AGENT_SEAT_KEY, agentSeatProjection, seatStateSchema } from './projection.ts'
export {
  SEAT_NOTICE_RECORD, SEAT_RUN_ALLOWED_RECORD, SEAT_STATE_RECORD, SEAT_STATUS_RECORD,
  type SeatNoticeKind, type SeatNoticeRecordData, type SeatRunAllowedRecordData, type SeatStateRecordData, type SeatStatusRecordData,
} from './record.ts'
export { CHOOSE_MODEL_PATH, chooseModelRoute, RESUME_PATH, resumeRoute, type SeatRoute, type SeatRouteOptions } from './routes.ts'
export { SeatRecords, type SeatSessions, type SeatStateReader, type StatusChange } from './store.ts'
export type { AgentSeatView, SeatAgent, SeatModelOffer, SeatModelPicker, SeatViewState } from './view.ts'
