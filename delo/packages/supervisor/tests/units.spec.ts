/**
 * The supervisor's pure parts: the start token check, the presets and their bounds, the listed-image refusals, the
 * Docker context resolution, the hardened container body and its comparison with an inspect record, and the limit
 * findings, including a limit the engine ignored.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { StartToken } from '@delo/contract-home-layout'
import { GIB, IMAGES, PRESETS, type WorkspaceId } from '@delo/contract-runtime-supervisor'
import type { OciDigest } from '@delo/contract-release-manifest'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBody,
  endpointOf,
  EngineError,
  ensureListedImage,
  hardeningDifferences,
  isAllowlistHost,
  limitFindings,
  listedImage,
  parseStartToken,
  presetLimits,
  readStartTokenFile,
  resolveDockerContext,
  shapesOf,
  StartTokenCheck,
  startTokenFile,
  SupervisorError,
  workspaceNames,
  type CreateBody,
  type Engine,
  type InspectRecord,
  type ProbeEvidence,
} from '../src/index.ts'
import { ABSENT_DIGEST, fixtureManifest, PROFILE, tempHome, writeStartToken, type TempHome } from './support.ts'

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

describe('the start token', () => {
  it('accepts only the current token, compared whole', () => {
    const token = 'a'.repeat(43) as StartToken
    const check = new StartTokenCheck(token)
    expect(check.accepts(token)).toBe(true)
    for (const candidate of [undefined, null, 42, '', token.slice(1), `${token}a`, 'b'.repeat(43)]) expect(check.accepts(candidate)).toBe(false)
  })

  it('reads the token file through C1\'s protected-file check and refuses a readable one', async () => {
    temp = await tempHome()
    const token = await writeStartToken(temp.home)
    const file = startTokenFile(temp.home, PROFILE)
    expect(await readStartTokenFile(file)).toBe(token)
    chmodSync(file, 0o644)
    await expect(readStartTokenFile(file)).rejects.toMatchObject({ code: 'SECRET_FILE_MODE' })
  })

  it('refuses a token file that does not hold one token and one newline, without quoting it', async () => {
    temp = await tempHome()
    const file = startTokenFile(temp.home, PROFILE)
    writeFileSync(file, 'short-secret-value\n', { mode: 0o600 })
    await expect(readStartTokenFile(file)).rejects.toThrow(/does not hold one start token/)
    await expect(readStartTokenFile(file)).rejects.not.toThrow(/short-secret-value/)
    expect(parseStartToken('a'.repeat(43))).toBeDefined()
    expect(parseStartToken('a'.repeat(42))).toBeUndefined()
    expect(parseStartToken(`${'a'.repeat(42)}=`)).toBeUndefined()
  })
})

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
  name: 'delo-ws-000000000000', image: `${IMAGES.s2}@${ABSENT_DIGEST}`, labels: {}, user: { uid: 1000, gid: 1000 },
  limits: PRESETS.small, diskQuota: false, networks: ['delo-ws-000000000000'], binds: [{ source: '/p/w', target: '/p/w' }], env: [],
})

/** The inspect record an engine that applied every setting returns. */
function applied(created: CreateBody): InspectRecord {
  return {
    Id: 'c',
    HostConfig: { ...created.HostConfig, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] },
    Mounts: created.HostConfig.Mounts.map(mount => ({ Type: 'bind', Source: mount.Source, Destination: mount.Target })),
    NetworkSettings: { Networks: { 'delo-ws-000000000000': {} } },
  }
}

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

  it('names a workspace\'s objects after the first 12 hex digits of its id\'s SHA-256 digest', () => {
    const hex = createHash('sha256').update('ws-1').digest('hex').slice(0, 12)
    expect(workspaceNames('ws-1' as WorkspaceId)).toEqual({ container: `delo-ws-${hex}`, network: `delo-ws-${hex}`, outNetwork: `delo-ws-${hex}-out`, proxy: `delo-ws-${hex}-proxy` })
  })

  it('finds no difference when the engine applied the body, and names each one it did not apply', () => {
    const created = body()
    expect(hardeningDifferences(applied(created), created)).toEqual({ mounts: [], settings: [] })
    const changed = applied(created)
    const record: InspectRecord = {
      ...changed,
      HostConfig: { ...changed.HostConfig, Memory: 0, PidsLimit: null, SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] },
      Mounts: [{ Type: 'bind', Source: '/', Destination: '/p/w' }, { Type: 'volume', Source: 'v', Destination: '/data' }],
    }
    const differences = hardeningDifferences(record, created)
    expect(differences.settings).toEqual(expect.arrayContaining(['HostConfig.Memory', 'HostConfig.PidsLimit', 'HostConfig.SecurityOpt']))
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
    expect(limitFindings(evidence({ gateway: { skipped: 'no address' } }))['host-gateway-block'].status).toBe('unknown')
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
})
