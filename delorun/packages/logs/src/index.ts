/**
 * Delorun's operational logs (contract C20, `delorun/docs/contracts/c20-operational-logs.md`): the logger every surface
 * writes through, the redactor, rotation and retention, captured output, and the readers `delorun logs` uses. The
 * Cordis logger exporter is the `@delorun/logs/cordis` entry, so a surface without Cordis does not load it.
 *
 * @module @delorun/logs
 */
export { LineCapture, captureStream, interceptStdio, type CapturedStream, type InterceptOptions } from './capture.ts'
export { isLogsFailure, LogsError, type LogsErrorCode, type LogsFailure } from './errors.ts'
export { logsDescriber } from './refusal.ts'
export { checkProfile, resolveSurface, rotatedFile, surfaceOfDirectory, type SurfaceLocation, type SurfaceRequest } from './files.ts'
export { followLines, parseRecord, readLines, type FollowOptions, type StoredLine } from './reader.ts'
export { serializeRecord, type LogKeys } from './record.ts'
export { Redactor, REDACTED_VALUE, redactionMarker, type PatternKind, type RedactedError } from './redact.ts'
export {
  clearLocalLogs,
  clearStartupReports,
  clearSurface,
  localSurfaces,
  oldestRecordTime,
  pruneLocalSurfaces,
  pruneStartupReports,
  pruneSurface,
  startAgeChecks,
  startupReports,
  surfaceFiles,
  type AgeCheckOptions,
  type RetentionReport,
  type SurfaceFiles,
} from './retention.ts'
export { LEVEL_RANK, rotateFiles, SurfaceLog, type DelorunLogDetails, type DelorunLogger, type LogEntry, type SurfaceLogOptions } from './writer.ts'
