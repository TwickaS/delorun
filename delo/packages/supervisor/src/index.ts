/**
 * Delo's Docker supervisor (contract C9, `delo/docs/contracts/c09-runtime-supervisor.md`): the only Delo component
 * that calls Docker. It serves a fixed-schema API on `run/<profile>/supervisor.sock` that accepts only the current
 * home-process start's token, builds the capability report by inspecting a probe container, resolves workspace roots
 * against the setup-time roots file, runs only images the verified release manifest lists, and logs to C20's
 * `supervisor-<profile>` surface. The process entry is `./main.ts`, which the home process spawns.
 *
 * @module @delo/supervisor
 */
export { connectCommand, engineKind, inspectDocker, limitFindings, PROBE_COMMANDS, PROBE_ENTRY, shapesOf, type EngineInfo, type EngineMachine, type EngineVersion, type Inspection, type InspectOptions, type NetworkRecord, type ProbeEvidence } from './capabilities.ts'
export {
  allowedMounts,
  confineContainer,
  CONFINEMENT_CHECKS,
  CONFINEMENT_PROBE_MS,
  confinementProbes,
  confinementReport,
  dockerSocketPaths,
  isWithin,
  networkFindings,
  probeContainer,
  probeFinding,
  readOnlyMounts,
  refusedMounts,
  requireConfined,
  writableBinds,
  type ConfinementCheck,
  type ConfinementExpectation,
  type ConfinementFinding,
  type ConfinementReport,
  type ConfinementStatus,
} from './confine.ts'
export {
  createBody,
  ENGINE_FILE_MOUNTS,
  hardeningDifferences,
  helperChannelDirectory,
  homeIdOf,
  ISOLATED_GATEWAY_OPTIONS,
  labelsOf,
  LIMITS_LABEL,
  limitDifferences,
  limitsOf,
  networkBody,
  PROXY_VARIABLES,
  recordedLimits,
  workspaceBinds,
  workspaceEnv,
  workspaceHash,
  workspaceNames,
  workspaceUser,
  type ContainerPlan,
  type ContainerUser,
  type CreateBody,
  type InspectRecord,
  type NetworkBody,
  type Owner,
  type WorkspaceNames,
} from './container.ts'
export { endpointOf, resolveDockerContext, type DockerContext } from './docker/endpoint.ts'
export { engineAt, EngineError, isNotFound, type Engine, type EngineTimeouts } from './docker/engine.ts'
export { SupervisorError } from './errors.ts'
export { ensureListedImage, type ImagePull } from './images.ts'
export { encodeLaunch, LAUNCH_FD, LAUNCH_MAX_BYTES, parseLaunch, runSupervisorProcess, type SupervisorLaunch } from './launch.ts'
export { captureSupervisorOutput, openSupervisorLog, SUPERVISOR_LOGGER, type SupervisorLog, type SupervisorLogOptions } from './log.ts'
export { imagePlatform, listedImage, verifiedManifestSchema, type ListedImage, type VerifiedManifest } from './manifest.ts'
export { identityChain, loadRootRules, recheckMountedRoot, resolveWorkspaceRoot, type IdentityChain, type RootRules } from './roots.ts'
export { loadSeccompProfile, SECCOMP_PROFILE_MAX_BYTES } from './seccomp.ts'
export { checkRequest, decodeRequest, isAllowlistHost } from './schema.ts'
export { listenSupervisor, type ListenOptions, type RequestHandler, type SupervisorListener } from './server.ts'
export { Supervisor, supervisorSocketPath, type SupervisorOptions, type SupervisorTiming } from './supervisor.ts'
export { allowedHosts, engineRefusal, presetLimits, Workspaces, type WorkspaceContext, type WorkspaceView } from './workspaces.ts'
