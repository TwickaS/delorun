/**
 * Delo's home process (contract C19, `delo/docs/contracts/c19-home-process.md`): one process per CLI profile that
 * holds C1's home lock, writes a new start token at each start, serves the update channel on
 * `run/<profile>/update.sock`, launches the Docker supervisor, runs the profile's Host and moves the profile to
 * another runtime only through the update handshake, which never switches `current` under a running chat. It logs
 * to C20's `home-<profile>` surface. `delorun start`, `stop` and `status` drive it.
 *
 * @module @delo/home-process
 */
export { listenUpdateChannel, updateSocketPath, type UpdateChannelOptions, type UpdateRequestHandler } from './channel.ts'
export { CountingChatGate } from './chat-gate.ts'
export { exchangeLines, queryHomeStatus, sendHomeRequest, updateChannelProbe, type ExchangeOptions, type ResponseLine, type UnsignedRequest } from './client.ts'
export { HomeProcessError, type HomeProcessFailure } from './errors.ts'
export { HANDOVER_LINE_MAX_BYTES, openHandoverPipe, startSuccessor, type HandoverLine, type HandoverPipe, type Successor } from './handover.ts'
export { UpdateHandshake, type HandshakeResult, type HandshakeSubject, type Progress, type UpdateState, type UpdateSupport } from './handshake.ts'
export { HomeProcess, type HomeProcessOptions } from './home-process.ts'
export { journalPath, readJournal, removeJournal, writeJournal } from './journal.ts'
export { captureHomeOutput, HOME_LOGGER, openHomeLog, type HomeLog, type HomeLogOptions } from './log.ts'
export { checkUpdateRequest, REPORT_ID_PATTERN } from './schema.ts'
export type { ChatGate, HomeCommand, HomeCommandMode, HostRunner, PreparedRuntime, ProfileSnapshots, RunningHost, RuntimePointers, RuntimeStore, UpdateChannelAccess } from './seams.ts'
export { launchSupervisor, type LaunchedSupervisor, type SupervisorSetup, type SupervisorStart } from './supervisor-launch.ts'
