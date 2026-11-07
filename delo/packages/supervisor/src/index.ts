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
  createBody,
  EGRESS_PROXY_ENTRY,
  hardeningDifferences,
  homeIdOf,
  labelsOf,
  networkBody,
  PROXY_VARIABLES,
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
export { engineAt, EngineError, isNotFound, type Engine } from './docker/engine.ts'
export { SupervisorError } from './errors.ts'
export { ensureListedImage, type ImagePull } from './images.ts'
export { encodeLaunch, LAUNCH_FD, LAUNCH_MAX_BYTES, parseLaunch, runSupervisorProcess, type SupervisorLaunch } from './launch.ts'
export { captureSupervisorOutput, openSupervisorLog, SUPERVISOR_LOGGER, type SupervisorLog, type SupervisorLogOptions } from './log.ts'
export { imagePlatform, listedImage, verifiedManifestSchema, type ListedImage, type VerifiedManifest } from './manifest.ts'
export { loadRootRules, resolveWorkspaceRoot, type RootRules } from './roots.ts'
export { decodeRequest, isAllowlistHost } from './schema.ts'
export { listenSupervisor, type ListenOptions, type RequestHandler, type SupervisorListener } from './server.ts'
export { Supervisor, supervisorSocketPath, type SupervisorOptions } from './supervisor.ts'
export { parseStartToken, readStartTokenFile, StartTokenCheck, startTokenFile } from './token.ts'
export { allowedHosts, presetLimits, Workspaces, type WorkspaceContext, type WorkspaceView } from './workspaces.ts'
