/**
 * The confinement gate of an S2 workspace container (contract C9, "Containers", "Networks and egress" and "Supervisor
 * roots"): what a container the supervisor created must still show before its workspace may use it. Two halves, both
 * required, because either alone can be fooled:
 *
 * - the inspect record, read structurally: the bind mounts are the resolved workspace root, the helper's directory
 *   read-only with its channel writable below it, and the engine's own files, nothing else, no mount source is the OS
 *   home, the Delo home or a Docker socket, and the container is a member of its own internal network alone;
 * - the container's own view, read by fixed probe commands whose exit code alone is read: every capability dropped,
 *   `no-new-privileges`, seccomp, a read-only root, the preset's cgroup limits, the workspace user, the Delo home and
 *   the machine's Docker sockets absent, `/tmp` a tmpfs of the preset's size, the helper's directory read-only and its
 *   channel writable, and no writable mount besides the workspace root, the helper's channel, `/tmp` and the engine's
 *   own files and devices.
 *
 * The probes create nothing and read nothing back, so a probe command never carries a secret and its output never
 * leaves the container. A probe that cannot run, or does not finish, is `unconfirmed`: the gate fails closed, because a
 * property the machine cannot show is not a property the workspace may rely on.
 *
 * @module @delo/supervisor/confine
 */
import { HELPER_CHANNEL_DIR, HELPER_SOCKET_DIR, type ResourceLimits } from '@delo/contract-runtime-supervisor'
import { ENGINE_FILE_MOUNTS, hardeningDifferences, helperChannelDirectory, type ContainerUser, type CreateBody, type InspectRecord } from './container.ts'
import type { Engine } from './docker/engine.ts'
import { SupervisorError } from './errors.ts'

/** The properties the gate checks from inside the container, each by one probe command. */
export const CONFINEMENT_CHECKS = [
  'capabilities',
  'no-new-privileges',
  'seccomp',
  'read-only-root',
  'workspace-root-writable',
  'helper-read-only',
  'writable-mounts',
  'delo-home-hidden',
  'docker-socket-hidden',
  'tmp-is-tmpfs',
  'tmpfs-size',
  'memory',
  'pids',
  'cpu',
  'user',
  'network-isolation',
] as const

/** One property the gate checks from inside the container. */
export type ConfinementCheck = (typeof CONFINEMENT_CHECKS)[number]

/** What one workspace container must show. Every path is canonical, as the supervisor resolved it. */
export interface ConfinementExpectation {
  /** The workspace's root on the machine, which the container mounts at its own path and may write. */
  readonly root: string
  /** The helper's socket directory on the machine, `run/<profile>/s2/<12 hex>/`, mounted at {@link HELPER_SOCKET_DIR}. */
  readonly helperDir: string
  /** C1's Delo home, which no container may see. */
  readonly deloHome: string
  /** The person's OS home directory, which no container may mount. */
  readonly osHome: string
  /** The Docker socket paths of the active context and of the well-known places, which no container may see. */
  readonly dockerSockets: readonly string[]
  /** The limits in effect. */
  readonly limits: ResourceLimits
  /** The user the container runs and its commands run as. */
  readonly user: ContainerUser
  /** The workspace's own internal network, the container's only network. */
  readonly network: string
}

/** The status of one checked property. */
export type ConfinementStatus = 'pass' | 'fail' | 'unconfirmed'

/** One checked property and what showed it. */
export interface ConfinementFinding {
  /** `pass` when it holds, `fail` when the probe showed it does not, `unconfirmed` when no exit code arrived. */
  readonly status: ConfinementStatus
  /** The inspected field or the probe's argv and exit code, never a secret. */
  readonly evidence: string
}

/** Everything the gate read: the structural findings and the probes'. */
export interface ConfinementReport {
  /** Whether the container still ran when its record was read after the probes. */
  readonly running: boolean
  /** Mount sources the record must not carry; empty when it carries none. */
  readonly mounts: readonly string[]
  /** Network findings; empty when the container is isolated. */
  readonly network: readonly string[]
  /** Settings the record does not carry, as `hardeningDifferences` names them; empty when it carries them all. */
  readonly settings: readonly string[]
  /** One finding per probe. */
  readonly probes: Readonly<Record<ConfinementCheck, ConfinementFinding>>
}

/**
 * The Docker socket paths no container may mount or see: the active context's endpoint when it is a socket, and the
 * places an engine keeps one.
 * @param endpoint - the active context's socket path, when the endpoint is a local socket.
 * @param osHome - the person's OS home directory.
 * @param uid - the person's uid, for the per-user engine sockets; `undefined` where the platform has none.
 * @returns the paths, without duplicates.
 */
export function dockerSocketPaths(endpoint: string | undefined, osHome: string, uid: number | undefined): string[] {
  const paths = [
    ...endpoint === undefined ? [] : [endpoint],
    '/var/run/docker.sock',
    '/run/docker.sock',
    `${osHome}/.docker/run/docker.sock`,
    ...uid === undefined ? [] : [`/run/user/${String(uid)}/docker.sock`],
  ]
  return [...new Set(paths)]
}

/**
 * Whether one path lies inside another, compared as text with a directory boundary, which is enough here because both
 * are canonical paths the supervisor resolved itself.
 * @param path - the path to test.
 * @param parent - the directory.
 * @returns true when `path` is `parent` or lies under it.
 */
export function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

/** System directories no workspace container mounts: a mount of one of these hands the workspace the machine. */
const SYSTEM_DIRECTORIES: readonly string[] = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var', '/var/run']

/** The destinations a tmpfs may have beyond `/tmp`: the engine's own files and the engine's own devices. */
const ENGINE_TMPFS_DESTINATIONS: readonly string[] = ['/dev', '/dev/shm', ...ENGINE_FILE_MOUNTS]

/**
 * The mounts C9 allows in an S2 workspace container, by source and destination: the resolved workspace root at its own
 * path, and the helper's directory at {@link HELPER_SOCKET_DIR} with its channel below it. No other host path is
 * mounted.
 * @param expectation - the workspace's resolved paths.
 * @returns each allowed source with the destination it must have.
 */
export function allowedMounts(expectation: ConfinementExpectation): ReadonlyMap<string, string> {
  return new Map([
    [expectation.root, expectation.root],
    [expectation.helperDir, HELPER_SOCKET_DIR],
    [helperChannelDirectory(expectation.helperDir), HELPER_CHANNEL_DIR],
  ])
}

/**
 * The allowed mounts a container must not write: the helper's directory, so nothing the workspace runs can add to it,
 * rename anything in it or replace it. The channel below it and the workspace root stay writable.
 * @param expectation - the workspace's resolved paths.
 * @returns the allowed sources that must be mounted read-only.
 */
export function readOnlyMounts(expectation: ConfinementExpectation): readonly string[] {
  return [expectation.helperDir]
}

/**
 * The mounts of a container that C9 forbids: any mount that is not one of {@link allowedMounts} or the engine's own
 * files and tmpfs mounts, and any that reaches the Delo home, the OS home, a Docker socket or a system directory, which
 * is why each is named separately.
 * @param record - the container's inspect record.
 * @param expectation - the workspace's resolved paths.
 * @returns one entry per refused mount, naming its type, source and destination.
 */
export function refusedMounts(record: InspectRecord, expectation: ConfinementExpectation): string[] {
  const refused: string[] = []
  const allowed = allowedMounts(expectation)
  const readOnly = readOnlyMounts(expectation)
  for (const mount of record.Mounts ?? []) {
    const source = mount.Source ?? ''
    const destination = mount.Destination ?? ''
    const named = `${mount.Type ?? 'unknown'} ${source} at ${destination}`
    if (mount.Type === 'tmpfs') {
      // The preset's /tmp and the engine's own tmpfs mounts are the only tmpfs mounts a container has.
      if (destination !== '/tmp' && !ENGINE_TMPFS_DESTINATIONS.includes(destination)) refused.push(`${named}: a tmpfs outside /tmp and the engine's own mounts`)
      continue
    }
    if (mount.Type !== 'bind') {
      refused.push(`${named}: not a bind mount`)
      continue
    }
    // The engine mounts its own files at fixed destinations; they are the engine's, not a host path the container chose.
    if (ENGINE_FILE_MOUNTS.includes(destination)) continue
    if (allowed.get(source) === destination) {
      // The helper's directory is the one allowed mount the container must only read: a writable one there is the
      // workspace's second way into the machine, beside the channel it was given.
      if (readOnly.includes(source) && mount.ReadOnly !== true) refused.push(`${named}: writable, and the helper's directory is read-only`)
      continue
    }
    if (allowed.has(source)) {
      refused.push(`${named}: ${source} belongs at ${allowed.get(source) ?? ''}`)
    } else if (isWithin(source, expectation.deloHome)) {
      refused.push(`${named}: a path in the Delo home`)
    } else if (isWithin(expectation.osHome, source)) {
      refused.push(`${named}: the OS home directory or a path containing it`)
    } else if (expectation.dockerSockets.some(socket => isWithin(source, socket) || isWithin(socket, source))) {
      refused.push(`${named}: a Docker socket`)
    } else if (SYSTEM_DIRECTORIES.includes(source)) {
      refused.push(`${named}: a system directory`)
    } else {
      refused.push(`${named}: not the workspace root or the helper's socket directory`)
    }
  }
  return refused
}

/**
 * The bind mounts a container writes on the host: the workspace root, the helper's channel below its directory, which
 * holds the helper's sockets alone. A mount of anything else that is writable is a second way into the machine.
 * @param record - the container's inspect record.
 * @param expectation - the workspace's resolved paths.
 * @returns the writable bind sources other than those.
 */
export function writableBinds(record: InspectRecord, expectation: ConfinementExpectation): string[] {
  const written = [expectation.root, helperChannelDirectory(expectation.helperDir)]
  return (record.Mounts ?? [])
    .filter(mount => mount.Type === 'bind' && mount.ReadOnly !== true)
    .filter(mount => !ENGINE_FILE_MOUNTS.includes(mount.Destination ?? ''))
    .map(mount => mount.Source ?? '')
    .filter(source => !written.includes(source))
}

/**
 * The network findings of a container: it is a member of its own internal network alone, and it is in none of the
 * host's namespaces.
 * @param record - the container's inspect record.
 * @param network - the workspace's internal network name.
 * @returns one entry per finding; empty when the container is isolated.
 */
export function networkFindings(record: InspectRecord, network: string): string[] {
  const findings: string[] = []
  const mode = record.HostConfig?.NetworkMode ?? ''
  if (mode !== network) findings.push(`HostConfig.NetworkMode=${JSON.stringify(mode)} is not the workspace network ${network}`)
  const joined = Object.keys(record.NetworkSettings?.Networks ?? {})
  if (joined.length !== 1 || joined[0] !== network) findings.push(`NetworkSettings.Networks=${JSON.stringify(joined)} is not ${JSON.stringify([network])}`)
  for (const [field, value] of [['HostConfig.PidMode', record.HostConfig?.PidMode], ['HostConfig.IpcMode', record.HostConfig?.IpcMode], ['HostConfig.UsernsMode', record.HostConfig?.UsernsMode]] as const) {
    if (value === 'host') findings.push(`${field} is host`)
  }
  return findings
}

/**
 * The probe commands of one workspace container, each an argv whose exit code 0 means the property holds.
 * @param expectation - the workspace's resolved paths and limits.
 * @returns one argv per {@link CONFINEMENT_CHECKS} entry.
 */
export function confinementProbes(expectation: ConfinementExpectation): Record<ConfinementCheck, readonly string[]> {
  const hidden = (paths: readonly string[]): string[] => ['sh', '-c', 'for p in "$@"; do if [ -e "$p" ]; then exit 1; fi; done', 'sh', ...paths]
  return {
    // CapEff is empty for any non-root user; the bounding, permitted and ambient sets show what the container could gain.
    'capabilities': ['sh', '-c', 'for set in CapBnd CapPrm CapEff CapAmb; do grep -Eq "^$set:[[:space:]]+0+$" /proc/self/status || exit 1; done'],
    'no-new-privileges': ['sh', '-c', 'grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status'],
    'seccomp': ['sh', '-c', 'grep -Eq "^Seccomp:[[:space:]]+2$" /proc/self/status'],
    'read-only-root': ['sh', '-c', 'grep -Eq "^[^ ]+ / [^ ]+ ro[, ]" /proc/mounts'],
    'workspace-root-writable': ['sh', '-c', 'test -d "$0" && test -w "$0"', expectation.root],
    // The helper's directory is mounted read-only and its channel is not: a write there fails, and the sockets the
    // helper starts have somewhere to go. A workspace that can write the directory itself can replace what the harness
    // connects to, which is what this shows it cannot do.
    'helper-read-only': ['sh', '-c', 'test -d "$0" && test -d "$1" && [ ! -w "$0" ] && test -w "$1"', HELPER_SOCKET_DIR, HELPER_CHANNEL_DIR],
    // Every writable mount whose destination is not one the container must have: the workspace root, the helper's
    // channel, /tmp, the engine's own files, the kernel's own filesystems and the engine's own tmpfs over its devices
    // and the kernel files it masks. A writable mount anywhere else, tmpfs or not, is writable space the workspace was
    // not given. The mounts file is the last argument, so a spec can read a fixture.
    'writable-mounts': ['sh', '-c', [
      'awk -v root="$1" -v channel="$2" \'',
      '  $4 ~ /(^|,)rw(,|$)/ {',
      '    dest = $2',
      '    type = $3',
      '    if (dest == root || dest == channel || dest == "/tmp") next',
      '    if (dest == "/etc/hosts" || dest == "/etc/hostname" || dest == "/etc/resolv.conf") next',
      '    if (type ~ /^(proc|sysfs|devpts|devtmpfs|mqueue|cgroup|cgroup2|securityfs|debugfs|nsfs)$/) next',
      '    if (type == "tmpfs" || type == "shm") {',
      '      if (dest == "/dev" || index(dest, "/dev/") == 1) next',
      '      if (index(dest, "/proc/") == 1 || index(dest, "/sys/") == 1) next',
      '    }',
      '    print dest',
      '    found = 1',
      '  }',
      '  END { exit found }',
      '\' "$3"',
    ].join('\n'), 'sh', expectation.root, HELPER_CHANNEL_DIR, '/proc/mounts'],
    'delo-home-hidden': hidden([expectation.deloHome]),
    'docker-socket-hidden': hidden(expectation.dockerSockets),
    'tmp-is-tmpfs': ['sh', '-c', 'grep -Eq "^[^ ]+ /tmp tmpfs " /proc/mounts'],
    // The tmpfs /tmp is the preset's size: the kernel reports it rounded down to a page, so anything within one large
    // page below the limit is that limit.
    'tmpfs-size': ['sh', '-c', 'v=$(df -B1 --output=size /tmp 2>/dev/null | tail -n 1 | tr -dc 0-9); test -n "$v" && test "$v" -le "$0" && test $(( $0 - v )) -lt 65536', String(expectation.limits.tmpBytes)],
    'memory': ['sh', '-c', 'v=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes); test "$v" = "$0"', String(expectation.limits.memoryBytes)],
    'pids': ['sh', '-c', 'v=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max); test "$v" = "$0"', String(expectation.limits.pids)],
    'cpu': ['sh', '-c', 'if [ -r /sys/fs/cgroup/cpu.max ]; then read q p < /sys/fs/cgroup/cpu.max; else q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us); p=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us); fi; test "$q" != max && test $((q * 1000000000 / p)) = "$0"', String(Math.round(expectation.limits.cpus * 1e9))],
    'user': ['sh', '-c', 'test "$(id -u)" = "$0"', String(expectation.user.uid)],
    // The kernel keeps a rejecting IPv6 default route on `lo` in every namespace; only a route on another interface leaves.
    'network-isolation': ['sh', '-c', 'awk \'NR > 1 && $2 == "00000000" { found = 1 } END { exit found }\' /proc/net/route && { [ ! -r /proc/net/ipv6_route ] || awk \'$1 ~ /^0+$/ && $2 == "00" && $10 != "lo" { found = 1 } END { exit found }\' /proc/net/ipv6_route; }'],
  }
}

/** How long one probe command may run, in milliseconds. */
export const CONFINEMENT_PROBE_MS = 10_000

/** Exit codes that mean the probe tool is missing or not runnable, not that the property failed. */
const TOOL_MISSING = new Set([126, 127])

/**
 * One probe's finding from its exit code.
 * @param argv - the probe's argv, whose last entries name the paths it read.
 * @param exit - its exit code, or `undefined` when it did not finish.
 * @returns the finding.
 */
export function probeFinding(argv: readonly string[], exit: number | undefined): ConfinementFinding {
  const tool = argv[0] ?? 'sh'
  const evidence = exit === undefined ? `${tool} did not finish within ${String(CONFINEMENT_PROBE_MS)} ms` : `${tool} exit ${String(exit)}`
  if (exit === 0) return { status: 'pass', evidence }
  if (exit === undefined || TOOL_MISSING.has(exit)) return { status: 'unconfirmed', evidence }
  return { status: 'fail', evidence }
}

/**
 * Run one probe per checked property in a running container.
 * @param input - the engine, the container and what it must show.
 * @returns one finding per probe.
 */
export async function probeContainer(input: {
  readonly engine: Engine
  readonly container: string
  readonly expectation: ConfinementExpectation
}): Promise<Record<ConfinementCheck, ConfinementFinding>> {
  const probes = confinementProbes(input.expectation)
  const exits = await Promise.all(CONFINEMENT_CHECKS.map(async check => [check, await input.engine.execExitCode(input.container, probes[check], CONFINEMENT_PROBE_MS)] as const))
  return Object.fromEntries(exits.map(([check, exit]) => [check, probeFinding(probes[check], exit)])) as Record<ConfinementCheck, ConfinementFinding>
}

/**
 * Everything a container's record and probes show.
 * @param input - the container's record, the body it must match, what it must show and its probes' findings.
 * @returns the report.
 */
export function confinementReport(input: {
  readonly record: InspectRecord
  readonly body: CreateBody
  readonly expectation: ConfinementExpectation
  readonly probes: Record<ConfinementCheck, ConfinementFinding>
}): ConfinementReport {
  return {
    running: input.record.State?.Running === true,
    mounts: [...refusedMounts(input.record, input.expectation), ...writableBinds(input.record, input.expectation).map(source => `writable ${source}: not the workspace root or the helper's socket directory`)],
    network: networkFindings(input.record, input.body.HostConfig.NetworkMode),
    settings: hardeningDifferences(input.record, input.body).settings,
    probes: input.probes,
  }
}

/**
 * Read a running container's confinement: one probe per property first, then the record as it stands after them, so a
 * container the machine altered while the probes ran is reported as it is and not as it was.
 * @param input - the engine, the container, how to read its record, the body it must match and what it must show.
 * @returns the report; it never throws for a property that fails, only for an engine that does not answer.
 */
export async function confineContainer(input: {
  readonly engine: Engine
  readonly container: string
  readonly read: () => Promise<InspectRecord>
  readonly body: CreateBody
  readonly expectation: ConfinementExpectation
}): Promise<ConfinementReport> {
  const probes = await probeContainer({ engine: input.engine, container: input.container, expectation: input.expectation })
  return confinementReport({ record: await input.read(), body: input.body, expectation: input.expectation, probes })
}

/**
 * Refuse a container whose gate did not pass: a container that stopped while its record was read, then the properties
 * it does not show, then the ones no probe could confirm.
 * @param report - what {@link confineContainer} read.
 * @throws {SupervisorError} `ENGINE_REFUSED` for a container that was not running when its record was read after the
 *   probes, `ROOT_REFUSED` for a refused mount, `LIMITS_MISSING` for a setting, a network finding or a property that
 *   failed or was not confirmed.
 */
export function requireConfined(report: ConfinementReport): void {
  if (!report.running) throw new SupervisorError('ENGINE_REFUSED', 'the container was not running when its confinement was read')
  if (report.mounts.length > 0) throw new SupervisorError('ROOT_REFUSED', `the container mounts what C9 forbids: ${report.mounts.join('; ')}`)
  const failed = CONFINEMENT_CHECKS.filter(check => report.probes[check].status === 'fail')
  const unconfirmed = CONFINEMENT_CHECKS.filter(check => report.probes[check].status === 'unconfirmed')
  const missing = [...report.settings, ...report.network, ...failed]
  if (missing.length > 0) throw new SupervisorError('LIMITS_MISSING', `the container does not show ${missing.join(', ')}`)
  if (unconfirmed.length > 0) throw new SupervisorError('LIMITS_MISSING', `the container's confinement is unconfirmed for ${unconfirmed.map(check => `${check} (${report.probes[check].evidence})`).join(', ')}`)
}
