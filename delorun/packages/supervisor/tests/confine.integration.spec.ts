/**
 * The S2 confinement gate's own parts, without a Docker engine: the mounts and the network C9 allows, the probe
 * commands of one workspace, and the typed refusal of every way a container can fail the gate.
 *
 * Each `it` names, in its last line of prose, the check whose removal makes it fail, so the suite is a ledger of the
 * refusals the gate keeps rather than a description of the code beside it.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HELPER_CHANNEL_DIR, HELPER_SOCKET_DIR, PRESETS } from '@delorun/contract-runtime-supervisor'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allowedMounts,
  confineContainer,
  CONFINEMENT_CHECKS,
  confinementProbes,
  createBody,
  dockerSocketPaths,
  hardeningDifferences,
  isWithin,
  networkFindings,
  probeFinding,
  readOnlyMounts,
  refusedMounts,
  requireConfined,
  SupervisorError,
  writableBinds,
  workspaceBinds,
  type ConfinementExpectation,
  type ConfinementReport,
  type CreateBody,
  type Engine,
  type InspectRecord,
} from '../src/index.ts'
import { appliedRecord, tempHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

const ROOT = '/p/w'
const HELPER = '/h/run/default/s2/0123456789ab'
const DELORUN_HOME = '/h'
const OS_HOME = '/home/p'

const expectation = (overrides: Partial<ConfinementExpectation> = {}): ConfinementExpectation => ({
  root: ROOT,
  helperDir: HELPER,
  delorunHome: DELORUN_HOME,
  osHome: OS_HOME,
  dockerSockets: ['/var/run/docker.sock'],
  limits: PRESETS.small,
  user: { uid: 1000, gid: 1000 },
  network: 'delorun-ws-0123456789ab',
  ...overrides,
})

const body = (binds = workspaceBinds(ROOT, HELPER)): CreateBody => createBody({
  name: 'delorun-ws-0123456789ab', image: `ghcr.io/twickas/delorun-workspace-s2@sha256:${'a'.repeat(64)}`,
  labels: {}, user: { uid: 1000, gid: 1000 }, limits: PRESETS.small, diskQuota: false, networks: ['delorun-ws-0123456789ab'], binds, env: [],
})

/** A record with one more bind mount than C9 allows. */
function withMount(record: InspectRecord, source: string, destination: string, extra: { readonly Type?: string, readonly ReadOnly?: boolean } = {}): InspectRecord {
  return { ...record, Mounts: [...record.Mounts ?? [], { Type: extra.Type ?? 'bind', Source: source, Destination: destination, ...extra.ReadOnly === undefined ? {} : { ReadOnly: extra.ReadOnly } }] }
}

/** A record of the container a start left running, which is the record the gate reads after the probes. */
function runningRecord(created: CreateBody = body()): InspectRecord {
  return { ...appliedRecord(created), State: { Status: 'running', Running: true } }
}

/** A report whose every probe passed, for the refusal specs to spoil. */
const passing = (): ConfinementReport => ({
  running: true,
  mounts: [],
  network: [],
  settings: [],
  probes: Object.fromEntries(CONFINEMENT_CHECKS.map(check => [check, { status: 'pass', evidence: 'sh exit 0' }])) as ConfinementReport['probes'],
})

function refusal(run: () => void): SupervisorError {
  try {
    run()
  } catch (error) {
    if (error instanceof SupervisorError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('the paths a container may reach', () => {
  it('treats a path as inside another only at a directory boundary', () => {
    expect(isWithin('/a/b', '/a')).toBe(true)
    expect(isWithin('/a', '/a')).toBe(true)
    expect(isWithin('/ab', '/a')).toBe(false)
    expect(isWithin('/a/b/c', '/a/b')).toBe(true)
  })

  it('names the active context\'s socket and the places an engine keeps one, once each', () => {
    const paths = dockerSocketPaths('/run/user/1000/docker.sock', OS_HOME, 1000)
    expect(paths).toContain('/run/user/1000/docker.sock')
    expect(paths).toContain('/var/run/docker.sock')
    expect(paths).toContain(`${OS_HOME}/.docker/run/docker.sock`)
    expect(new Set(paths).size).toBe(paths.length)
    // A network endpoint has no socket path of its own; the well-known places remain.
    expect(dockerSocketPaths(undefined, OS_HOME, undefined)).toEqual(['/var/run/docker.sock', '/run/docker.sock', `${OS_HOME}/.docker/run/docker.sock`])
  })
})

describe('the mounts C9 allows', () => {
  it('allows exactly the resolved root at its own path and the helper\'s directory with its channel', () => {
    expect([...allowedMounts(expectation())]).toEqual([[ROOT, ROOT], [HELPER, HELPER_SOCKET_DIR], [`${HELPER}/channel`, HELPER_CHANNEL_DIR]])
    expect(readOnlyMounts(expectation())).toEqual([HELPER])
    expect(refusedMounts(appliedRecord(body()), expectation())).toEqual([])
    // Removing the helper's directory from the allowed set makes its recorded mounts refusals: the directory, and the
    // channel it carries below it.
    const elsewhere = refusedMounts(appliedRecord(body(workspaceBinds(ROOT, '/elsewhere'))), expectation())
    expect(elsewhere).toHaveLength(2)
    expect(elsewhere.every(entry => entry.includes("not the workspace root or the helper's socket directory"))).toBe(true)
  })

  it('refuses a helper mount the container may write, which is the mount a workspace could add to', () => {
    const record = appliedRecord(body())
    const writable = { ...record, Mounts: (record.Mounts ?? []).map(mount => mount.Source === HELPER ? { ...mount, ReadOnly: false } : mount) }
    expect(refusedMounts(writable, expectation())).toEqual([expect.stringContaining("writable, and the helper's directory is read-only")])
    // The channel below it stays writable: it is where the helper creates its sockets.
    const channel = { ...record, Mounts: (record.Mounts ?? []).map(mount => mount.Source === `${HELPER}/channel` ? { ...mount, ReadOnly: true } : mount) }
    expect(refusedMounts(channel, expectation())).toEqual([])
    expect(writableBinds(channel, expectation())).toEqual([])
  })

  it('refuses a mount of the Delorun home, a path inside it, the OS home, a Docker socket and a system directory', () => {
    const record = appliedRecord(body())
    const cases: readonly (readonly [string, string, string])[] = [
      [DELORUN_HOME, DELORUN_HOME, 'a path in the Delorun home'],
      [`${DELORUN_HOME}/secrets`, '/secrets', 'a path in the Delorun home'],
      [OS_HOME, OS_HOME, 'the OS home directory or a path containing it'],
      ['/', '/host', 'the OS home directory or a path containing it'],
      ['/var/run/docker.sock', '/var/run/docker.sock', 'a Docker socket'],
      ['/usr', '/usr', 'a system directory'],
      ['/opt/other', '/opt/other', "not the workspace root or the helper's socket directory"],
    ]
    for (const [source, destination, reason] of cases) {
      const refused = refusedMounts(withMount(record, source, destination), expectation())
      expect(refused, `${source} at ${destination}`).toEqual([expect.stringContaining(reason)])
    }
  })

  it('refuses a volume mount, a tmpfs outside /tmp and the root at another path', () => {
    const record = appliedRecord(body())
    expect(refusedMounts(withMount(record, 'vol-1', '/data', { Type: 'volume' }), expectation())).toEqual([expect.stringContaining('not a bind mount')])
    expect(refusedMounts(withMount(record, 'tmpfs', '/mnt', { Type: 'tmpfs' }), expectation())).toEqual([expect.stringContaining('a tmpfs outside /tmp')])
    expect(refusedMounts(withMount(record, ROOT, '/elsewhere'), expectation())).toEqual([expect.stringContaining(`belongs at ${ROOT}`)])
  })

  it('names every bind a container writes on the host besides the root and the helper\'s directory', () => {
    const record = withMount(appliedRecord(body()), '/opt/extra', '/extra')
    expect(writableBinds(record, expectation())).toEqual(['/opt/extra'])
    // A read-only mount of the same path is not a way to write the machine.
    expect(writableBinds(withMount(appliedRecord(body()), '/opt/extra', '/extra', { ReadOnly: true }), expectation())).toEqual([])
  })

  it('allows the engine\'s own files, which every engine mounts at fixed destinations', () => {
    const engineFiles: readonly (readonly [string, string])[] = [
      ['/var/lib/docker/containers/1/hosts', '/etc/hosts'],
      ['/var/lib/docker/containers/1/hostname', '/etc/hostname'],
      ['/var/lib/docker/containers/1/resolv.conf', '/etc/resolv.conf'],
    ]
    const record = engineFiles.reduce((acc, [source, destination]) => withMount(acc, source, destination), appliedRecord(body()))
    // Refusing the engine's own files would refuse every container a native engine creates: an engine writes them
    // read-write, at a per-container source named after the fixed file.
    expect(refusedMounts(record, expectation())).toEqual([])
    expect(writableBinds(record, expectation())).toEqual([])
    expect(hardeningDifferences(record, body())).toEqual({ mounts: [], settings: [] })
    // A read-only bind and the same path on both sides are the engine's copies however their source is spelled.
    expect(refusedMounts(withMount(appliedRecord(body()), '/somewhere/else', '/etc/hosts', { ReadOnly: true }), expectation())).toEqual([])
    expect(refusedMounts(withMount(appliedRecord(body()), '/etc/hosts', '/etc/hosts'), expectation())).toEqual([])
  })

  it('refuses a bind that only borrows an engine file\'s destination, whatever it points at', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      // The audit's case: the Delorun home itself, and a path inside it, at a destination no check used to reach.
      [DELORUN_HOME, '/etc/hosts', 'a path in the Delorun home'],
      [`${DELORUN_HOME}/secrets`, '/etc/hostname', 'a path in the Delorun home'],
      // The machine's Docker socket, at the destination that carried the exemption.
      ['/var/run/docker.sock', '/etc/hosts', 'a Docker socket'],
      // The OS home and a system directory, which the destination alone never covered.
      [OS_HOME, '/etc/resolv.conf', 'the OS home directory or a path containing it'],
      ['/etc', '/etc/hosts', 'a system directory'],
      // The workspace root belongs at its own path, an engine destination or not.
      [ROOT, '/etc/hosts', `belongs at ${ROOT}`],
      // Any other host path is a mount C9 does not list.
      ['/opt/extra', '/etc/hosts', "not the workspace root or the helper's socket directory"],
    ]
    for (const [source, destination, reason] of cases) {
      const record = withMount(appliedRecord(body()), source, destination)
      expect(refusedMounts(record, expectation()), `${source} at ${destination}`).toEqual([expect.stringContaining(reason)])
      // The other two halves of the gate see it too: a borrowed destination hides neither the writable mount nor the
      // difference from what the start asked for. The root is the one source they know by path instead of by mount.
      if (source === ROOT) continue
      expect(writableBinds(record, expectation()), `${source} at ${destination}`).toEqual([source])
      expect(hardeningDifferences(record, body()).mounts, `${source} at ${destination}`).toEqual([`${source}:${destination}`])
    }
    // Keying the engine-file allowance on the destination alone, as the gate did, makes every case pass.
  })
})

describe('the network a container joins', () => {
  it('accepts only its own internal network', () => {
    const record = appliedRecord(body())
    expect(networkFindings(record, 'delorun-ws-0123456789ab')).toEqual([])
    expect(networkFindings({ ...record, HostConfig: { ...record.HostConfig, NetworkMode: 'host' } }, 'delorun-ws-0123456789ab')).toEqual([expect.stringContaining('not the workspace network')])
    expect(networkFindings({ ...record, NetworkSettings: { Networks: { 'delorun-ws-0123456789ab': {}, bridge: {} } } }, 'delorun-ws-0123456789ab')).toEqual([expect.stringContaining('NetworkSettings.Networks')])
    expect(networkFindings({ ...record, HostConfig: { ...record.HostConfig, PidMode: 'host' } }, 'delorun-ws-0123456789ab')).toEqual(['HostConfig.PidMode is host'])
  })
})

describe('the probes', () => {
  it('runs one command per checked property and passes each the workspace\'s own paths and limits', () => {
    const probes = confinementProbes(expectation())
    expect(Object.keys(probes).sort()).toEqual([...CONFINEMENT_CHECKS].sort())
    for (const [check, argv] of Object.entries(probes)) {
      expect(argv[0], check).toBe('sh')
      expect(argv.every(part => typeof part === 'string' && part.length > 0), check).toBe(true)
    }
    // The workspace's own limits, not a preset's: a hard-coded Small would put another number here.
    const advanced = confinementProbes(expectation({ limits: { ...PRESETS.small, memoryBytes: 6 * 1024 ** 3, pids: 777, cpus: 3 } }))
    expect(advanced.memory.at(-1)).toBe(String(6 * 1024 ** 3))
    expect(advanced.pids.at(-1)).toBe('777')
    expect(advanced.cpu.at(-1)).toBe(String(3e9))
    // The paths a probe reads are the resolved ones: the workspace root, the helper's channel and the mounts file.
    expect(probes['workspace-root-writable'].at(-1)).toBe(ROOT)
    expect(probes['helper-read-only'].slice(-2)).toEqual([HELPER_SOCKET_DIR, HELPER_CHANNEL_DIR])
    expect(probes['writable-mounts'].slice(-3)).toEqual([ROOT, HELPER_CHANNEL_DIR, '/proc/mounts'])
    expect(probes['delorun-home-hidden']).toContain(DELORUN_HOME)
    expect(probes['docker-socket-hidden']).toContain('/var/run/docker.sock')
    expect(probes.user.at(-1)).toBe('1000')
    // The tmpfs /tmp is checked against the workspace's own size, not a preset's.
    expect(probes['tmpfs-size'].at(-1)).toBe(String(PRESETS.small.tmpBytes))
    expect(confinementProbes(expectation({ limits: { ...PRESETS.small, tmpBytes: 512 * 1024 ** 2 } }))['tmpfs-size'].at(-1)).toBe(String(512 * 1024 ** 2))
  })

  it('reads an exit code as pass, fail or unconfirmed, never as pass when no code arrived', () => {
    expect(probeFinding(['sh', '-c', 'true'], 0).status).toBe('pass')
    expect(probeFinding(['sh', '-c', 'true'], 1).status).toBe('fail')
    expect(probeFinding(['sh', '-c', 'true'], 127).status).toBe('unconfirmed')
    expect(probeFinding(['sh', '-c', 'true'], undefined).status).toBe('unconfirmed')
    expect(probeFinding(['sh', '-c', 'true'], undefined).evidence).toContain('did not finish')
  })

  it('reads every writable mount whose destination the workspace was not given, tmpfs or not', () => {
    const probe = confinementProbes(expectation())['writable-mounts']
    // The probe reads the mounts file named by its last argument, so a fixture stands in for /proc/mounts here.
    const status = (mounts: readonly string[]): number => {
      const dir = mkdtempSync(join(tmpdir(), 'delorun-mounts-'))
      try {
        const file = join(dir, 'mounts')
        writeFileSync(file, `${mounts.join('\n')}\n`)
        const argv = [...probe.slice(0, -1), file]
        return spawnSync(argv[0] ?? 'sh', argv.slice(1), { encoding: 'utf8', timeout: 30_000 }).status ?? 1
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    const mount = (source: string, destination: string, fstype: string, options: string): string => `${source} ${destination} ${fstype} ${options} 0 0`
    // What every engine gives a workspace container: the root, the helper's directory read-only with its channel
    // below it writable, /tmp, the engine's own files and the kernel's writable filesystems, including Docker Desktop's
    // tmpfs masks under /proc.
    const allowed = [
      mount('overlay', '/', 'overlay', 'ro,relatime'),
      mount('proc', '/proc', 'proc', 'rw,nosuid,nodev,noexec,relatime'),
      mount('tmpfs', '/dev', 'tmpfs', 'rw,nosuid,size=65536k'),
      mount('devpts', '/dev/pts', 'devpts', 'rw,nosuid,noexec,relatime'),
      mount('shm', '/dev/shm', 'tmpfs', 'rw,nosuid,nodev,noexec,relatime'),
      mount('tmpfs', '/proc/interrupts', 'tmpfs', 'rw,nosuid,size=65536k'),
      mount('/dev/sde', '/etc/hosts', 'ext4', 'rw,relatime'),
      mount(ROOT, ROOT, 'ext4', 'rw,relatime'),
      mount(HELPER, HELPER_SOCKET_DIR, 'ext4', 'ro,relatime'),
      mount(`${HELPER}/channel`, HELPER_CHANNEL_DIR, 'ext4', 'rw,relatime'),
      mount('tmpfs', '/tmp', 'tmpfs', 'rw,nosuid,nodev,size=1048576k'),
    ]
    expect(status(allowed)).toBe(0)
    // A writable helper's directory is a writable mount the workspace was not given: skipping it by its destination
    // would pass a container that can replace what the harness connects to.
    expect(status(allowed.map(entry => entry.replace(`${HELPER} ${HELPER_SOCKET_DIR} ext4 ro,`, `${HELPER} ${HELPER_SOCKET_DIR} ext4 rw,`)))).toBe(1)
    // A tmpfs at any other destination is writable space the workspace was never given; skipping every tmpfs by its
    // filesystem type would pass it.
    expect(status([...allowed, mount('tmpfs', '/data', 'tmpfs', 'rw,nosuid,size=65536k')])).toBe(1)
    // So is a writable mount the record does not show either, even over a destination the engine itself uses.
    expect(status([...allowed, mount('/opt/extra', '/srv', 'ext4', 'rw,relatime')])).toBe(1)
    expect(status([...allowed, mount('/', '/dev', 'ext4', 'rw,relatime')])).toBe(1)
    // Kernel filesystems are the kernel's own wherever they are mounted, so they are not a host path.
    expect(status([...allowed, mount('proc', '/proc', 'proc', 'rw,nosuid,nodev,noexec,relatime')])).toBe(0)
  })
})

describe('the refusal of a container that fails the gate', () => {
  it('refuses a forbidden mount with ROOT_REFUSED and a setting with LIMITS_MISSING', () => {
    expect(refusal(() => { requireConfined({ ...passing(), mounts: ['bind /h at /h: a path in the Delorun home'] }) }).code).toBe('ROOT_REFUSED')
    expect(refusal(() => { requireConfined({ ...passing(), settings: ['HostConfig.Memory'] }) }).code).toBe('LIMITS_MISSING')
    expect(refusal(() => { requireConfined({ ...passing(), network: ['HostConfig.NetworkMode="host" is not the workspace network'] }) }).code).toBe('LIMITS_MISSING')
  })

  it('names the property a probe showed failing, and refuses a property no probe confirmed', () => {
    const failed = refusal(() => { requireConfined({ ...passing(), probes: { ...passing().probes, capabilities: { status: 'fail', evidence: 'sh exit 1' } } }) })
    expect(failed.code).toBe('LIMITS_MISSING')
    expect(failed.detail).toContain('capabilities')
    const unconfirmed = refusal(() => { requireConfined({ ...passing(), probes: { ...passing().probes, memory: { status: 'unconfirmed', evidence: 'sh exit 127' } } }) })
    expect(unconfirmed.code).toBe('LIMITS_MISSING')
    expect(unconfirmed.detail).toContain('unconfirmed for memory')
  })

  it('passes a container whose every property holds', () => {
    expect(() => { requireConfined(passing()) }).not.toThrow()
  })
})

describe('reading a container', () => {
  /** An engine that answers every exec with one exit code, recording the commands it ran. */
  const engine = (exit: number | undefined, seen: string[]): Engine => ({
    call: () => Promise.resolve(null),
    pull: () => Promise.reject(new Error('the spec never pulls')),
    execExitCode: (_container, cmd) => {
      seen.push(cmd.join(' '))
      return Promise.resolve(exit)
    },
  })

  it('runs one exec per checked property and passes every finding through', async () => {
    const seen: string[] = []
    const report = await confineContainer({ engine: engine(0, seen), container: 'c', read: () => Promise.resolve(runningRecord()), body: body(), expectation: expectation() })
    expect(seen).toHaveLength(CONFINEMENT_CHECKS.length)
    expect(Object.values(report.probes).every(finding => finding.status === 'pass')).toBe(true)
    expect(report).toMatchObject({ running: true, mounts: [], network: [], settings: [] })
    // One probed property at a time: a gate that ran fewer would leave a property unproven.
    expect(new Set(seen).size).toBe(CONFINEMENT_CHECKS.length)
  })

  it('reports a property the container fails and one the engine could not answer for', async () => {
    const failed = await confineContainer({ engine: engine(1, []), container: 'c', read: () => Promise.resolve(runningRecord()), body: body(), expectation: expectation() })
    expect(Object.values(failed.probes).every(finding => finding.status === 'fail')).toBe(true)
    const unanswered = await confineContainer({ engine: engine(undefined, []), container: 'c', read: () => Promise.resolve(runningRecord()), body: body(), expectation: expectation() })
    expect(Object.values(unanswered.probes).every(finding => finding.status === 'unconfirmed')).toBe(true)
  })

  it('reads the record too: a mount and a setting the engine added are found without a probe', async () => {
    const record = withMount(runningRecord(), DELORUN_HOME, DELORUN_HOME)
    const report = await confineContainer({ engine: engine(0, []), container: 'c', read: () => Promise.resolve(record), body: body(), expectation: expectation() })
    expect(refusal(() => { requireConfined(report) }).code).toBe('ROOT_REFUSED')
    const unhardened: InspectRecord = { ...runningRecord(), HostConfig: { ...runningRecord().HostConfig, CapDrop: [] } }
    const settings = await confineContainer({ engine: engine(0, []), container: 'c', read: () => Promise.resolve(unhardened), body: body(), expectation: expectation() })
    expect(refusal(() => { requireConfined(settings) }).detail).toContain('HostConfig.CapDrop')
  })

  it('refuses a container that stopped while the probes ran, whose record no longer shows it running', async () => {
    const exited: InspectRecord = { ...runningRecord(), State: { Status: 'exited', Running: false } }
    const report = await confineContainer({ engine: engine(0, []), container: 'c', read: () => Promise.resolve(exited), body: body(), expectation: expectation() })
    // Every property held while the probes ran; only the record read after them shows the container is gone.
    expect(Object.values(report.probes).every(finding => finding.status === 'pass')).toBe(true)
    const gone = refusal(() => { requireConfined(report) })
    expect(gone.code).toBe('ENGINE_REFUSED')
    expect(gone.detail).toContain('not running')
  })
})

describe('the Delorun home on the machine', () => {
  it('refuses a container that mounts a directory inside the Delorun home, which the helper\'s directory alone may', async () => {
    temp = await tempHome()
    const helperDir = `${temp.home}/run/default/s2/0123456789ab`
    const inside = expectation({ delorunHome: temp.home, helperDir })
    const record = withMount(appliedRecord(body(workspaceBinds(ROOT, helperDir))), `${temp.home}/secrets`, '/secrets')
    expect(refusedMounts(record, inside)).toEqual([expect.stringContaining('a path in the Delorun home')])
  })
})
