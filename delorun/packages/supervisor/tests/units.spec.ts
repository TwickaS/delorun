/**
 * The supervisor's pure parts: the presets and their bounds, the listed-image refusals, the
 * Docker context resolution, the hardened container body and its comparison with an inspect record, and the limit
 * findings, including a limit the engine ignored.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { GIB, HELPER_CHANNEL_DIR, HELPER_SOCKET_DIR, IMAGES, PRESETS, type DockerLimit, type WorkspaceId } from '@delorun/contract-runtime-supervisor'
import type { OciDigest, Sha256Hex } from '@delorun/contract-release-manifest'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBody,
  endpointOf,
  EngineError,
  engineRefusal,
  LIMITS_LABEL,
  loadSeccompProfile,
  ensureListedImage,
  hardeningDifferences,
  isAllowlistHost,
  limitFindings,
  listedImage,
  networkBody,
  presetLimits,
  resolveDockerContext,
  shapesOf,
  SupervisorError,
  workspaceBinds,
  workspaceNames,
  type CreateBody,
  type Engine,
  type InspectRecord,
  type ProbeEvidence,
} from '../src/index.ts'
import { ABSENT_DIGEST, appliedRecord, fixtureManifest, tempHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

function refusal(run: () => unknown): SupervisorError {
  try {
    run()
  } catch (error) {
    if (error instanceof SupervisorError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

async function refusalOf(run: () => Promise<unknown>): Promise<SupervisorError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SupervisorError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('allowlist additions', () => {
  it('accepts host names and *.-prefixed suffixes, and refuses addresses, single labels and overlong names', () => {
    for (const host of ['example.com', '*.example.com', 'a-b.example.co']) expect(isAllowlistHost(host), host).toBe(true)
    for (const host of ['192.0.2.1', '::1', 'localhost', '*.', '-a.example.com', 'a..b', `${'a'.repeat(250)}.com`, '1.2.3.4.5', 'example.123']) expect(isAllowlistHost(host), host).toBe(false)
  })
})

describe('presets', () => {
  const machine = { cpus: 4, memoryBytes: 8 * GIB }

  it('gives the fixed presets that fit the machine and refuses one above it', () => {
    expect(presetLimits('small', undefined, machine)).toEqual(PRESETS.small)
    expect(presetLimits('balanced', undefined, machine)).toEqual(PRESETS.balanced)
    expect(refusal(() => presetLimits('large', undefined, machine)).code).toBe('PRESET_OUT_OF_RANGE')
  })

  it('refuses an Advanced value outside its bound, naming the field', () => {
    const ok = { cpus: 2, memoryBytes: 4 * GIB, diskBytes: 20 * GIB, pids: 512, tmpBytes: GIB }
    expect(presetLimits('advanced', ok, machine)).toEqual(ok)
    const cases = [
      [{ ...ok, cpus: 5 }, 'limits.cpus'],
      [{ ...ok, memoryBytes: 8 * GIB }, 'limits.memoryBytes'],
      [{ ...ok, diskBytes: 9 * GIB }, 'limits.diskBytes'],
      [{ ...ok, pids: 100 }, 'limits.pids'],
      [{ ...ok, tmpBytes: 3 * GIB }, 'limits.tmpBytes'],
    ] as const
    for (const [limits, field] of cases) {
      const error = refusal(() => presetLimits('advanced', limits, machine))
      expect(error.code).toBe('PRESET_OUT_OF_RANGE')
      expect(error.detail).toContain(field)
    }
  })
})

describe('listed images', () => {
  const digest = `sha256:${'a'.repeat(64)}` as OciDigest

  it('takes C9\'s repository at the platform\'s listed digest', () => {
    const image = listedImage(fixtureManifest(digest), 's2', 'linux/amd64')
    expect(image.reference).toBe(`${IMAGES.s2}@${digest}`)
  })

  it('refuses a manifest entry naming another repository, and a platform without a digest', () => {
    const manifest = fixtureManifest(digest)
    const other = { images: { ...manifest.images, s2: { ...manifest.images.s2, repository: 'docker.io/library/alpine' } } }
    expect(refusal(() => listedImage(other, 's2', 'linux/amd64')).code).toBe('IMAGE_NOT_IN_MANIFEST')
    expect(refusal(() => listedImage(manifest, 's2', undefined)).code).toBe('IMAGE_NOT_IN_MANIFEST')
    expect(refusal(() => listedImage({}, 's2', 'linux/amd64')).code).toBe('IMAGE_NOT_IN_MANIFEST')
  })

  function engineWith(images: Readonly<Record<string, readonly string[]>>, pulled: string[]): Engine {
    return {
      call: (_method, path) => {
        const reference = decodeURIComponent(/^\/images\/(.+)\/json$/.exec(path)?.[1] ?? '')
        const digests = images[reference]
        if (digests === undefined) return Promise.reject(new EngineError(404, 'no such image'))
        return Promise.resolve({ Id: 'sha256:x', RepoDigests: digests })
      },
      pull: (repository, value) => {
        pulled.push(`${repository}@${value}`)
        return Promise.resolve()
      },
      execExitCode: () => Promise.resolve(0),
    }
  }

  it('refuses an absent image when pulling is off, and never pulls', async () => {
    const pulled: string[] = []
    const engine = engineWith({}, pulled)
    const error = await refusalOf(async () => ensureListedImage(engine, listedImage(fixtureManifest(digest), 's2', 'linux/amd64'), 'none'))
    expect(error.code).toBe('IMAGE_NOT_IN_MANIFEST')
    expect(pulled).toEqual([])
  })

  it('refuses an image whose recorded digests include none the manifest lists', async () => {
    const image = listedImage(fixtureManifest(digest), 's2', 'linux/amd64')
    const engine = engineWith({ [image.reference]: [`${IMAGES.s2}@${ABSENT_DIGEST}`] }, [])
    expect((await refusalOf(async () => ensureListedImage(engine, image, 'none'))).code).toBe('IMAGE_NOT_IN_MANIFEST')
    const listed = engineWith({ [image.reference]: [`${IMAGES.s2}@${digest}`] }, [])
    expect(await ensureListedImage(listed, image, 'none')).toBe(image.reference)
  })
})

describe('the Docker context', () => {
  it('reads DOCKER_HOST, a named context\'s metadata and the default endpoint', async () => {
    temp = await tempHome()
    const config = join(temp.outside, 'docker')
    const name = 'rootless'
    const meta = join(config, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'))
    mkdirSync(meta, { recursive: true })
    writeFileSync(join(meta, 'meta.json'), JSON.stringify({ Name: name, Endpoints: { docker: { Host: 'unix:///run/user/1000/docker.sock' } } }))
    writeFileSync(join(config, 'config.json'), JSON.stringify({ currentContext: name }))
    expect(await resolveDockerContext({ DOCKER_CONFIG: config })).toEqual({ name, endpoint: { kind: 'unix', path: '/run/user/1000/docker.sock' }, host: 'unix:///run/user/1000/docker.sock' })
    expect((await resolveDockerContext({ DOCKER_CONFIG: config, DOCKER_HOST: 'tcp://192.0.2.2:2376' })).endpoint).toEqual({ kind: 'tcp' })
    expect((await resolveDockerContext({ DOCKER_CONFIG: join(temp.outside, 'none') })).name).toBe('default')
    await expect(resolveDockerContext({ DOCKER_CONFIG: config, DOCKER_CONTEXT: 'missing' })).rejects.toThrow(/has no docker endpoint/)
    expect(endpointOf('npipe:////./pipe/docker_engine')).toEqual({ kind: 'npipe', path: '\\\\.\\pipe\\docker_engine' })
    expect(endpointOf('fd://')).toBeUndefined()
  })
})

const body = (): CreateBody => createBody({
  name: 'delorun-ws-000000000000', image: `${IMAGES.s2}@${ABSENT_DIGEST}`, labels: {}, user: { uid: 1000, gid: 1000 },
  limits: PRESETS.small, diskQuota: false, networks: ['delorun-ws-000000000000'], binds: [{ source: '/p/w', target: '/p/w' }], env: [],
})

/** The inspect record an engine that applied every setting returns. */
const applied = appliedRecord

describe('the hardened container', () => {
  it('drops every capability, keeps the engine\'s seccomp profile and sets every C9 setting', () => {
    const created = body()
    expect(created.HostConfig).toMatchObject({
      CapDrop: ['ALL'], CapAdd: [], Privileged: false, SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true,
      NanoCpus: 2e9, Memory: 4 * GIB, MemorySwap: 4 * GIB, PidsLimit: 1024, Init: true, RestartPolicy: { Name: 'no' }, Devices: [],
    })
    expect(JSON.stringify(created)).not.toMatch(/seccomp|privileged":true|docker\.sock|host-gateway/i)
    expect(created.HostConfig.StorageOpt).toBeUndefined()
  })

  it('mounts the helper\'s directory read-only, with its channel writable below it', () => {
    const helperDir = '/h/run/default/s2/0123456789ab'
    const created = createBody({
      name: 'delorun-ws-000000000000', image: `${IMAGES.s2}@${ABSENT_DIGEST}`, labels: {}, user: { uid: 1000, gid: 1000 },
      limits: PRESETS.small, diskQuota: false, networks: ['delorun-ws-000000000000'], binds: workspaceBinds('/p/w', helperDir), env: [],
    })
    expect(created.HostConfig.Mounts).toEqual([
      { Type: 'bind', Source: '/p/w', Target: '/p/w', ReadOnly: false },
      { Type: 'bind', Source: helperDir, Target: HELPER_SOCKET_DIR, ReadOnly: true },
      { Type: 'bind', Source: `${helperDir}/channel`, Target: HELPER_CHANNEL_DIR, ReadOnly: false },
    ])
    // A record whose helper mount the container may write is not the container that was asked for.
    const record = appliedRecord(created)
    const loosened: InspectRecord = { ...record, Mounts: (record.Mounts ?? []).map(mount => mount.Destination === HELPER_SOCKET_DIR ? { ...mount, ReadOnly: false } : mount) }
    expect(hardeningDifferences(loosened, created).mounts).toEqual([expect.stringContaining('is writable, not read-only')])
  })

  it('names a workspace\'s objects after the first 12 hex digits of its id\'s SHA-256 digest', () => {
    const hex = createHash('sha256').update('ws-1').digest('hex').slice(0, 12)
    expect(workspaceNames('ws-1' as WorkspaceId)).toEqual({ container: `delorun-ws-${hex}`, network: `delorun-ws-${hex}`, outNetwork: `delorun-ws-${hex}-out`, proxy: `delorun-ws-${hex}-proxy` })
  })

  it('records the limits it was created with on the container itself', () => {
    const created = body()
    // The fields a `docker update` can change are not a record of what was asked; the label is.
    expect(JSON.parse(created.Labels[LIMITS_LABEL] ?? 'null')).toEqual(PRESETS.small)
  })

  it('finds no difference when the engine applied the body, and names each one it did not apply', () => {
    const created = body()
    expect(hardeningDifferences(applied(created), created)).toEqual({ mounts: [], settings: [] })
    const changed = applied(created)
    const record: InspectRecord = {
      ...changed,
      HostConfig: { ...changed.HostConfig, Memory: 0, PidsLimit: null, SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'], CgroupnsMode: 'host' },
      Mounts: [{ Type: 'bind', Source: '/', Destination: '/p/w' }, { Type: 'volume', Source: 'v', Destination: '/data' }],
    }
    const differences = hardeningDifferences(record, created)
    expect(differences.settings).toEqual(expect.arrayContaining(['HostConfig.Memory', 'HostConfig.PidsLimit', 'HostConfig.SecurityOpt', 'HostConfig.CgroupnsMode']))
    expect(differences.mounts).toEqual(expect.arrayContaining(['/:/p/w', '/p/w:/p/w', 'volume:/data']))
  })
})

describe('limit findings', () => {
  const exits = { capabilities: 0, noNewPrivileges: 0, seccomp: 0, readOnlyRoot: 0, memory: 0, pids: 0, cpu: 0, userNamespace: 1, noDefaultRoute: 0, disk: 1 }
  const evidence = (overrides: Partial<ProbeEvidence> = {}): ProbeEvidence => {
    const created = body()
    return {
      info: { SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'] },
      inspect: applied(created),
      body: created,
      network: { Internal: true },
      exits,
      diskRefused: 'storage-opt is supported only for overlay over xfs',
      gateway: { address: '198.51.100.1', exit: 1 },
      loopback: [{ target: 'host.docker.internal:1', exit: 1 }, { target: '192.0.2.2:1', exit: 124 }],
      ...overrides,
    }
  }

  it('reports a limit enforced only when the inspect record shows it and the probe confirms it', () => {
    const findings = limitFindings(evidence())
    for (const limit of ['cpu', 'memory', 'pids', 'cap-drop', 'no-new-privileges', 'read-only-root', 'seccomp', 'network-isolation', 'host-gateway-block', 'host-loopback-block'] as const) {
      expect(findings[limit].status, limit).toBe('enforced')
    }
    expect(findings.memory.evidence).toContain(`HostConfig.Memory=${String(4 * GIB)}`)
    expect(findings['user-namespace'].status).toBe('not-enforced')
    expect(findings.disk).toMatchObject({ status: 'not-enforced', evidence: expect.stringContaining('xfs') })
    expect(findings['egress-allowlist'].status).toBe('unknown')
  })

  it('reports a limit the engine ignored as not-enforced', () => {
    const base = evidence()
    const ignored = limitFindings(evidence({ inspect: { ...base.inspect, HostConfig: { ...base.inspect.HostConfig, Memory: 0, MemorySwap: 0 } } }))
    expect(ignored.memory.status).toBe('not-enforced')
    const unconfirmed = limitFindings(evidence({ exits: { ...exits, pids: 1 } }))
    expect(unconfirmed.pids.status).toBe('not-enforced')
    const quota = createBody({ name: 'n', image: 'i', labels: {}, user: { uid: 1, gid: 1 }, limits: PRESETS.small, diskQuota: true, networks: ['n'], binds: [], env: [] })
    const { diskRefused: _ignored, ...sized } = evidence({ body: quota, inspect: applied(quota) })
    expect(limitFindings({ ...sized, exits: { ...exits, disk: 1 } }).disk.status).toBe('not-enforced')
    expect(limitFindings({ ...sized, exits: { ...exits, disk: 0 } }).disk.status).toBe('enforced')
    const reachable = limitFindings(evidence({ loopback: [{ target: 'host.docker.internal:1', exit: 0 }] }))
    expect(reachable['host-loopback-block'].status).toBe('not-enforced')
  })

  it('reports unknown when a probe tool is missing or did not finish', () => {
    expect(limitFindings(evidence({ exits: { ...exits, seccomp: 127 } })).seccomp.status).toBe('unknown')
    expect(limitFindings(evidence({ exits: { ...exits, cpu: undefined } })).cpu.status).toBe('unknown')
    expect(limitFindings(evidence({ gateway: { skipped: 'the supervisor cannot listen on the gateway address 198.51.100.1 (EADDRNOTAVAIL)' } }))['host-gateway-block'].status).toBe('unknown')
  })

  it('reports the host gateway blocked when the probe network has no gateway address to reach', () => {
    // The probe network is created with the bridge driver's isolated gateway mode, and an engine that applies it gives
    // the network no gateway address: there is nothing on the machine for the container to connect to. An engine that
    // ignores the option leaves the address in place, and the connect's exit code decides.
    expect(limitFindings(evidence({ gateway: { isolated: true } }))['host-gateway-block']).toMatchObject({ status: 'enforced', evidence: expect.stringContaining('no gateway address') })
    expect(limitFindings(evidence({ gateway: { address: '198.51.100.1', exit: 0 } }))['host-gateway-block'].status).toBe('not-enforced')
    expect(limitFindings(evidence({ gateway: { address: '198.51.100.1', exit: undefined } }))['host-gateway-block'].status).toBe('unknown')
  })
})

describe('shapes', () => {
  const docker = (engine: 'docker-engine' | 'docker-desktop', status: 'enforced' | 'unknown' = 'enforced') => ({
    engine, version: '29', rootless: false, context: 'default', endpoint: { kind: 'unix' as const, path: '/var/run/docker.sock' }, storageDriver: 'overlay2',
    limits: Object.fromEntries(['cpu', 'memory', 'pids', 'disk', 'cap-drop', 'no-new-privileges', 'read-only-root', 'seccomp', 'user-namespace', 'network-isolation', 'host-gateway-block', 'host-loopback-block', 'egress-allowlist'].map(key => [key, { status, evidence: '' }])) as ReturnType<typeof limitFindings>,
  })

  it('offers both shapes on a Linux engine with every required limit, and S2 never on Docker Desktop', () => {
    expect(shapesOf(docker('docker-engine'), undefined, {})).toEqual({ s2: { available: true, fileWatching: 'supported' }, s3: { available: true, fileWatching: 'supported' } })
    expect(shapesOf(docker('docker-desktop'), undefined, {})).toEqual({ s2: { available: false, reason: 's2-transport-unsupported', fileWatching: 'unsupported' }, s3: { available: true, fileWatching: 'unsupported' } })
  })

  it('names the reason a shape is not offered', () => {
    expect(shapesOf(docker('docker-engine', 'unknown'), undefined, {}).s2.reason).toBe('limits-missing')
    expect(shapesOf(docker('docker-engine'), undefined, { s3: 'unlisted' }).s3.reason).toBe('image-unverified')
    expect(shapesOf({ ...docker('docker-engine'), endpoint: { kind: 'tcp' } }, undefined, {}).s2.reason).toBe('docker-endpoint-network')
    expect(shapesOf(undefined, 'docker-unavailable', {}).s3.reason).toBe('docker-unavailable')
  })

  it('does not offer S2 when a limit its container needs is unknown or not enforced', () => {
    const withLimit = (limit: DockerLimit, status: 'unknown' | 'not-enforced'): ReturnType<typeof docker> => {
      const base = docker('docker-engine')
      return { ...base, limits: { ...base.limits, [limit]: { status, evidence: 'fixture' } } }
    }
    // A container that cannot be shown to hold any of these is not one C9 allows, so the shape is refused up front
    // rather than offered and then refused at every start. `host-gateway-block` is among them: a network whose gateway
    // the workspace can reach gives it the machine's own services, which no other limit of the container stands in for.
    for (const limit of ['cpu', 'read-only-root', 'host-gateway-block'] as const) {
      expect(shapesOf(withLimit(limit, 'not-enforced'), undefined, {}).s2).toMatchObject({ available: false, reason: 'limits-missing' })
      expect(shapesOf(withLimit(limit, 'unknown'), undefined, {}).s2.reason).toBe('limits-missing')
    }
  })

  it('creates an internal network with the bridge driver\'s isolated gateway mode, and the way out without it', () => {
    const internal = networkBody('delorun-ws-0123456789ab', true, {})
    expect(internal.Options).toEqual({ 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' })
    // The proxy reaches the internet through the way out's own gateway, which the isolated mode would remove.
    expect(networkBody('delorun-ws-0123456789ab-out', false, {}).Options).toEqual({})
    expect(internal).toMatchObject({ Driver: 'bridge', Internal: true, Attachable: false })
  })
})

describe('listed seccomp profiles', () => {
  const PROFILE_TEXT = '{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[{"names":["keyctl"],"action":"SCMP_ACT_ERRNO"}]}'
  const listed = (name: string, text: string = PROFILE_TEXT) => ({ name, length: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') as Sha256Hex })

  it('reads a profile that matches its listed length and digest', async () => {
    temp = await tempHome()
    writeFileSync(join(temp.outside, 's2.seccomp.json'), PROFILE_TEXT)
    expect(await loadSeccompProfile(temp.outside, listed('s2.seccomp.json'))).toBe(PROFILE_TEXT)
  })

  it('refuses a profile whose bytes, length or name do not match, or that is missing, with IMAGE_NOT_IN_MANIFEST', async () => {
    temp = await tempHome()
    const dir = temp.outside
    writeFileSync(join(dir, 'p.json'), PROFILE_TEXT.replace('ERRNO', 'ALLOW'))
    const cases = [
      listed('p.json'),
      { ...listed('p.json', PROFILE_TEXT.replace('ERRNO', 'ALLOW')), length: 3 },
      listed('../p.json', PROFILE_TEXT.replace('ERRNO', 'ALLOW')),
      listed('absent.json'),
    ]
    for (const entry of cases) expect((await refusalOf(async () => loadSeccompProfile(dir, entry))).code, entry.name).toBe('IMAGE_NOT_IN_MANIFEST')
  })

  it('passes a listed profile to the engine and requires the inspect record to carry it', () => {
    const created = createBody({ name: 'n', image: 'i', labels: {}, user: { uid: 1, gid: 1 }, limits: PRESETS.small, diskQuota: false, networks: ['n'], binds: [], env: [], seccomp: PROFILE_TEXT })
    expect(created.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true', `seccomp=${PROFILE_TEXT}`])
    const record = applied(created)
    expect(hardeningDifferences({ ...record, HostConfig: { ...record.HostConfig, SecurityOpt: created.HostConfig.SecurityOpt } }, created).settings).toEqual([])
    expect(hardeningDifferences({ ...record, HostConfig: { ...record.HostConfig, SecurityOpt: ['no-new-privileges:true'] } }, created).settings).toContain('HostConfig.SecurityOpt')
  })
})

describe('engine refusals', () => {
  it('maps an engine that does not answer to DOCKER_UNAVAILABLE and a refused call to ENGINE_REFUSED with its message', () => {
    expect(engineRefusal(new EngineError(0, 'no answer'))).toMatchObject({ code: 'DOCKER_UNAVAILABLE' })
    expect(engineRefusal(new EngineError(500, 'conflict in the engine'))).toMatchObject({ code: 'ENGINE_REFUSED', detail: 'docker engine: conflict in the engine' })
    const other = new Error('x')
    expect(engineRefusal(other)).toBe(other)
  })

  it('refuses a failed pull of a listed digest with IMAGE_PULL_FAILED', async () => {
    const digest = `sha256:${'b'.repeat(64)}` as OciDigest
    const engine: Engine = {
      call: () => Promise.reject(new EngineError(404, 'no such image')),
      pull: () => Promise.reject(new EngineError(500, 'manifest unknown')),
      execExitCode: () => Promise.resolve(0),
    }
    expect((await refusalOf(async () => ensureListedImage(engine, listedImage(fixtureManifest(digest), 's2', 'linux/amd64'), 'registry'))).code).toBe('IMAGE_PULL_FAILED')
  })
})
