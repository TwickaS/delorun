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
export { acceptServer, declineServer, listServers, reloadPermissions, revokeServer, type AcceptedMcpServer, type LocalConsents, type McpEnvVariable, type McpPinnedFile, type McpServerChange, type McpServerState, type PendingMcpServer } from './consents.ts'
export { approveDevices, elevateDevices, PENDING_POLL_MS, removeDevice, type ChannelCaller, type ElevationsAtComputer, type LocalDeviceApproval, type PendingDevice, type PendingElevationRequest, type RunningElevation } from './devices-approve.ts'
export { reachApply, reachStatus, type LocalReach } from './reach.ts'
export { ChannelTokenCheck } from './studio-link.ts'
export { exchangeLines, queryHomeStatus, sendHomeRequest, updateChannelProbe, type ExchangeOptions, type ResponseLine, type UnsignedRequest } from './client.ts'
export { HomeProcessError, type HomeProcessFailure } from './errors.ts'
export { homeProcessDescriber } from './refusal.ts'
export { HANDOVER_LINE_MAX_BYTES, openHandoverPipe, startSuccessor, successorEnvironment, type HandoverLine, type HandoverPipe, type Successor } from './handover.ts'
export { UpdateHandshake, type HandshakeResult, type HandshakeSubject, type Progress, type UpdateState, type UpdateSupport } from './handshake.ts'
export { HomeProcess, type HomeProcessOptions } from './home-process.ts'
export { HostNotStoppedError, hostStopFailure, refuseBootedHost, REFUSED_HOST_STOP_S, stopHostWithin, type HostStopOutcome } from './host-stop.ts'
export { endUpdateRecord, hasStash, journalledUpdate, journalPath, journalRecord, markCommitted, markJournal, readJournal, removeJournal, removeStash, stashCommitted, stashPath, writeJournal, type JournalledUpdate } from './journal.ts'
export { captureHomeOutput, HOME_LOGGER, openedHomeLog, openHomeLog, type HomeLog, type HomeLogOptions, type OpenedHomeLog } from './log.ts'
export { checkUpdateRequest, REPORT_ID_PATTERN } from './schema.ts'
export { listenProcessSignals, SIGNAL_EXIT_CODES, type HomeSignal } from './signals.ts'
export type { BootRow, ChatGate, HealthExpectations, HealthVerdict, HostProtection, HomeCommand, HomeCommandMode, HostRunner, PreparedRuntime, ProfileSnapshots, RollbackSteps, RunningHost, RuntimePointers, RuntimeStore, SessionDataCopies, StudioLinkResult, UpdateChannelAccess } from './seams.ts'
export { launchSupervisor, type LaunchedSupervisor, type SupervisorSetup, type SupervisorStart } from './supervisor-launch.ts'
