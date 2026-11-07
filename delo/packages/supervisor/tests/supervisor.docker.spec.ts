/**
 * The supervisor against the Docker engine of the active context: C9's `capability-report-inspected`,
 * `supervisor-schema-closed` (no container is created) and `supervisor-image-unlisted`, and, where S2 is offered,
 * a workspace container whose `docker inspect` record carries C9's settings and only the resolved mounts.
 *
 * A stand-in S2 image is built from `fixtures/s2-image` and tagged under C9's repository name in the local engine;
 * its digest is the one the fixture manifest lists. No spec pulls from a registry. Every container, network and tag
 * a spec creates carries its temporary home's labels and is removed after the run, whether it passed or failed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPERVISOR_ROOTS_FILE } from '@delo/contract-home-layout'
import { HELPER_SOCKET_DIR, IMAGES, LABELS, PRESETS, type DockerLimit } from '@delo/contract-runtime-supervisor'
import type { FileRef, OciDigest, Sha256Hex } from '@delo/contract-release-manifest'
import { writeProtectedFile } from '@delo/home'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { homeIdOf, PROBE_COMMANDS } from '../src/index.ts'
import { ABSENT_DIGEST, fixtureManifest, send, startSupervisor, tempHome, type RunningSupervisor, type TempHome } from './support.ts'

const FIXTURE = fileURLToPath(new URL('fixtures/s2-image', import.meta.url))
const TAG = `${IMAGES.s2}:delo-supervisor-spec-${randomBytes(4).toString('hex')}`
const DOCKER_MS = 180_000

const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', timeout: DOCKER_MS }).trim()
const dockerUp = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 30_000 }).status === 0

let digest: OciDigest | undefined
let buildProblem: string | undefined
const homes: string[] = []
let temp: TempHome | undefined
let running: RunningSupervisor | undefined

/** Remove every container and network labelled with one home's id. */
function removeOwned(home: string): void {
  const filter = `label=${LABELS.home}=${homeIdOf(home)}`
  const containers = docker('ps', '-aq', '--filter', filter).split('\n').filter(line => line !== '')
  if (containers.length > 0) docker('rm', '-f', '-v', ...containers)
  const networks = docker('network', 'ls', '-q', '--filter', filter).split('\n').filter(line => line !== '')
  if (networks.length > 0) docker('network', 'rm', ...networks)
}

function owned(home: string): { readonly containers: string[], readonly networks: string[] } {
  const filter = `label=${LABELS.home}=${homeIdOf(home)}`
  return {
    containers: docker('ps', '-aq', '--filter', filter).split('\n').filter(line => line !== ''),
    networks: docker('network', 'ls', '-q', '--filter', filter).split('\n').filter(line => line !== ''),
  }
}

beforeAll(() => {
  if (!dockerUp) return
  docker('build', '-q', '-t', TAG, FIXTURE)
  const recorded = JSON.parse(docker('image', 'inspect', '--format', '{{json .RepoDigests}}', TAG)) as string[] | null
  const entry = (recorded ?? []).find(value => value.startsWith(`${IMAGES.s2}@`))
  if (entry === undefined) buildProblem = 'this engine records no repository digest for a locally built image (the classic image store); the specs need the containerd image store'
  else digest = entry.slice(IMAGES.s2.length + 1) as OciDigest
}, DOCKER_MS)

afterEach(async () => {
  await running?.stop()
  running = undefined
  temp?.remove()
  temp = undefined
})

afterAll(() => {
  if (!dockerUp) return
  for (const home of homes) removeOwned(home)
  spawnSync('docker', ['image', 'rm', TAG], { stdio: 'ignore' })
}, DOCKER_MS)

/**
 * The running supervisor, read through a call so a spec that stops and restarts it keeps its declared type.
 * @returns the running supervisor, if any.
 */
const current = (): RunningSupervisor | undefined => running

/** A seccomp profile for the fixture: Docker's own default is not needed to show the listed profile reaches the engine. */
const PROFILE_TEXT = '{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[{"names":["keyctl","add_key","request_key"],"action":"SCMP_ACT_ERRNO"}]}'

async function start(manifestDigest: OciDigest | undefined, seccomp?: { readonly listed: FileRef, readonly text: string }): Promise<{ readonly home: string, readonly socket: string, readonly token: string, readonly parent: string }> {
  temp = await tempHome()
  homes.push(temp.home)
  const parent = join(temp.outside, 'projects')
  mkdirSync(parent, { mode: 0o700 })
  await writeProtectedFile(join(temp.home, SUPERVISOR_ROOTS_FILE), JSON.stringify({ v: 1, parents: [parent] }))
  const seccompDirectory = join(temp.outside, 'seccomp')
  mkdirSync(seccompDirectory)
  if (seccomp !== undefined) writeFileSync(join(seccompDirectory, seccomp.listed.name), seccomp.text)
  running = await startSupervisor(temp.home, { manifest: fixtureManifest(manifestDigest, undefined, seccomp?.listed), env: process.env, pull: 'none', seccompDirectory })
  return { home: temp.home, socket: running.supervisor.socketPath, token: running.token, parent }
}

describe.skipIf(!dockerUp)('the supervisor against the active Docker engine', { timeout: DOCKER_MS }, () => {
  it('capability-report-inspected: every enforced limit matches the probe container\'s inspect record, and the probe leaves nothing behind', async (test) => {
    if (digest === undefined) return test.skip(buildProblem ?? 'no fixture image')
    const { home, socket, token } = await start(digest)
    const response = await send(socket, { v: 1, token, op: 'capabilities', args: { refresh: true } })
    expect(response).toMatchObject({ ok: true })
    const report = running?.supervisor.current
    const probe = report?.probe
    const limits = report?.docker?.limits
    expect(probe, 'the probe ran').toBeDefined()
    expect(limits).toBeDefined()
    if (probe === undefined || limits === undefined) return
    const host = probe.HostConfig ?? {}
    const matches: Readonly<Partial<Record<DockerLimit, () => boolean>>> = {
      'cpu': () => host.NanoCpus === PRESETS.small.cpus * 1e9,
      'memory': () => host.Memory === PRESETS.small.memoryBytes && host.MemorySwap === PRESETS.small.memoryBytes,
      'pids': () => host.PidsLimit === PRESETS.small.pids,
      'disk': () => host.StorageOpt?.size === String(PRESETS.small.diskBytes),
      'cap-drop': () => (host.CapDrop ?? []).includes('ALL') && (host.CapAdd ?? []).length === 0 && host.Privileged === false,
      'no-new-privileges': () => (host.SecurityOpt ?? []).some(option => option.startsWith('no-new-privileges')),
      'read-only-root': () => host.ReadonlyRootfs === true,
      'seccomp': () => !(host.SecurityOpt ?? []).some(option => option.includes('unconfined')),
      'network-isolation': () => Object.keys(probe.NetworkSettings?.Networks ?? {}).length === 1,
    }
    const enforced = Object.entries(limits).filter(([, found]) => found.status === 'enforced').map(([limit]) => limit as DockerLimit)
    expect(enforced.length).toBeGreaterThan(0)
    for (const limit of enforced) {
      const check = matches[limit]
      if (check !== undefined) expect(check(), `${limit}: ${limits[limit].evidence}`).toBe(true)
    }
    for (const [limit, check] of Object.entries(matches)) {
      if (!check()) expect(limits[limit as DockerLimit].status, `${limit} differs from the inspect record`).not.toBe('enforced')
    }
    expect(owned(home)).toEqual({ containers: [], networks: [] })
  })

  it('runs the probe under the seccomp profile the manifest lists, and refuses a listed profile whose file differs', async (test) => {
    if (digest === undefined) return test.skip(buildProblem ?? 'no fixture image')
    const listed: FileRef = { name: 's2.seccomp.json', length: Buffer.byteLength(PROFILE_TEXT), sha256: createHash('sha256').update(PROFILE_TEXT).digest('hex') as Sha256Hex }
    const { socket, token } = await start(digest, { listed, text: PROFILE_TEXT })
    expect(await send(socket, { v: 1, token, op: 'capabilities', args: { refresh: true } })).toMatchObject({ ok: true })
    expect(running?.supervisor.current.probe?.HostConfig?.SecurityOpt).toContain(`seccomp=${PROFILE_TEXT}`)
    expect(running?.supervisor.current.docker?.limits.seccomp.status).toBe('enforced')
    await running?.stop()
    running = undefined
    const { home } = await start(digest, { listed, text: PROFILE_TEXT.replace('keyctl', 'ptrace') })
    expect(current()?.supervisor.current.shapes.s2).toMatchObject({ available: false })
    expect(current()?.supervisor.current.docker?.limits.seccomp.status).toBe('unknown')
    expect(owned(home)).toEqual({ containers: [], networks: [] })
  })

  it('the cap-drop probe fails for a non-root user who keeps the bounding set, which CapEff alone does not show', async (test) => {
    if (digest === undefined) return test.skip(buildProblem ?? 'no fixture image')
    const run = (...flags: string[]): number | null => spawnSync('docker', ['run', '--rm', '--user', '1000:1000', ...flags, TAG, ...PROBE_COMMANDS.capabilities], { stdio: 'ignore', timeout: DOCKER_MS }).status
    expect(run()).not.toBe(0)
    expect(run('--cap-drop', 'ALL')).toBe(0)
  })

  it('supervisor-schema-closed: requests naming an image, a mount, an environment variable, a command or an unknown op create no container', async (test) => {
    if (digest === undefined) return test.skip(buildProblem ?? 'no fixture image')
    const { home, socket, token, parent } = await start(digest)
    const root = join(parent, 'w')
    mkdirSync(root)
    const args = { workspaceId: 'w', root, preset: 'small', egress: 'none', allowlistAdditions: [], credentials: 'none' }
    for (const extra of [{ image: 'docker.io/library/alpine:latest' }, { mounts: [{ source: '/', target: '/host' }] }, { env: ['A=1'] }, { cmd: ['sh', '-c', 'id'] }]) {
      expect(await send(socket, { v: 1, token, op: 'workspace.create', args: { ...args, ...extra } })).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    }
    expect(await send(socket, { v: 1, token, op: 'containers.create', args: { Image: 'alpine' } })).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    expect(owned(home)).toEqual({ containers: [], networks: [] })
  })

  it('supervisor-image-unlisted: a digest the verified manifest does not list is never run, even with an image of C9\'s name present', async (test) => {
    if (digest === undefined) return test.skip(buildProblem ?? 'no fixture image')
    const { home, socket, token, parent } = await start(ABSENT_DIGEST)
    const root = join(parent, 'w')
    mkdirSync(root)
    const response = await send(socket, { v: 1, token, op: 'workspace.create', args: { workspaceId: 'w', root, preset: 'small', egress: 'none', allowlistAdditions: [], credentials: 'none' } })
    // Where S2 is not offered, the shape refusal comes first; the probe's refusal of the image still shows.
    const offered = running?.supervisor.current.docker?.engine !== 'docker-desktop'
    expect(response).toMatchObject({ ok: false, error: offered ? 'IMAGE_NOT_IN_MANIFEST' : 'SHAPE_UNAVAILABLE' })
    expect(running?.supervisor.current.shapes.s2).toMatchObject({ available: false })
    expect(running?.supervisor.current.docker?.limits.memory).toMatchObject({ status: 'unknown', evidence: expect.stringContaining('IMAGE_NOT_IN_MANIFEST') })
    expect(owned(home)).toEqual({ containers: [], networks: [] })
  })

  it('a workspace container carries C9\'s settings and only the resolved mounts, and is removed whole', async (test) => {
    if (digest === undefined) return test.skip(buildProblem ?? 'no fixture image')
    const { home, socket, token, parent } = await start(digest)
    const s2 = running?.supervisor.current.shapes.s2
    if (s2?.available !== true) return test.skip(`S2 is not offered on this engine (${s2?.reason ?? 'unknown'}); its container runs where it is`)
    const root = join(parent, 'w')
    mkdirSync(root)
    const created = await send(socket, { v: 1, token, op: 'workspace.create', args: { workspaceId: 'w', root, preset: 'small', egress: 'none', allowlistAdditions: [], credentials: 'none' } })
    expect(created).toMatchObject({ ok: true, workspace: { state: 'created', egress: 'none', limits: { memoryBytes: PRESETS.small.memoryBytes } } })
    const name = created.ok && typeof created.workspace === 'object' && created.workspace !== null && 'container' in created.workspace ? String(created.workspace.container) : ''
    const record = (JSON.parse(docker('inspect', name)) as { readonly HostConfig: Record<string, unknown>, readonly Mounts: { readonly Type: string, readonly Source: string, readonly Destination: string }[] }[])[0]
    expect(record?.HostConfig).toMatchObject({ CapDrop: ['ALL'], ReadonlyRootfs: true, Privileged: false, Memory: PRESETS.small.memoryBytes, MemorySwap: PRESETS.small.memoryBytes, PidsLimit: PRESETS.small.pids, Init: true })
    expect(record?.Mounts.filter(mount => mount.Type === 'bind').map(mount => mount.Destination).sort()).toEqual([HELPER_SOCKET_DIR, root].sort())
    expect(record?.Mounts.find(mount => mount.Destination === root)?.Source).toBe(root)
    expect(await send(socket, { v: 1, token, op: 'workspace.start', args: { workspaceId: 'w' } })).toMatchObject({ ok: true, workspace: { state: 'running' } })
    expect(await send(socket, { v: 1, token, op: 'workspace.stop', args: { workspaceId: 'w', mode: 'kill' } })).toMatchObject({ ok: true })
    expect(await send(socket, { v: 1, token, op: 'workspace.remove', args: { workspaceId: 'w' } })).toEqual({ ok: true })
    expect(owned(home)).toEqual({ containers: [], networks: [] })
  })
})

describe.skipIf(dockerUp)('the supervisor against the active Docker engine', () => {
  it.skip('not run on this host: no Docker engine answers at the active context', () => {})
})
