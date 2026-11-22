/**
 * The network helper against the Docker engine: config denial tests over `docker inspect` (the plugin container has no
 * capabilities and joins the helper's network; only the helper has NET_ADMIN), and the proxy's work: a plugin container
 * with nothing but the helper's network and CA has its HTTP and HTTPS traffic read, its connects, listens and programs
 * logged, and a client that does not trust the CA reported as "contents not checked". Every object carries the label
 * `delorun.bench=1`; the spec removes only what it created.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realDocker } from '../../../src/compat-bench/privacy/docker.ts'
import { buildHelperImage, collectHelper, startHelper, stopHelper } from '../../../src/compat-bench/privacy/helper/image.ts'
import type { StartedHelper } from '../../../src/compat-bench/privacy/helper/image.ts'
import { readHelperReport } from '../../../src/compat-bench/privacy/observer.ts'

const NODE_IMAGE = 'node:24.21.0-bookworm'
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const required = process.env['DELORUN_DOCKER_SPECS'] === '1'
const engine = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 120_000 }).status === 0
const haveNode = engine && spawnSync('docker', ['image', 'inspect', NODE_IMAGE], { stdio: 'ignore', timeout: 120_000 }).status === 0
const runnable = engine && haveNode
if (required && !runnable) throw new Error(`the Docker lane requires this spec: an engine that answers and the image ${NODE_IMAGE} (docker pull ${NODE_IMAGE})`)

const id = randomBytes(3).toString('hex')
const CANARY = `bench-fake-spec-canary-${id}-${randomBytes(8).toString('hex')}`
const created: string[] = []
let helper: StartedHelper
let outDir: string
let report: Awaited<ReturnType<typeof readHelperReport>>
let pluginId: string
let helperInspect: Record<string, any>
let pluginInspect: Record<string, any>
let pluginOutput: string
let capabilityLine: string
let failedClientOutput: string

const docker = async (...args: string[]): Promise<string> => {
  const result = await realDocker(args, { timeoutMs: 180_000 })
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}
const inspect = async (name: string): Promise<Record<string, any>> => (JSON.parse(await docker('inspect', name)) as Record<string, any>[])[0] ?? {}

/** Run a short-lived container that joins the helper's network and process namespace, with no capabilities. */
async function plugin(name: string, command: string[], extra: string[] = []): Promise<string> {
  created.push(name)
  await docker('create', '--name', name, '--label', 'delorun.bench=1', '--network', `container:${helper.name}`, '--pid', `container:${helper.name}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--memory', '512m', '--pids-limit', '128', ...extra, NODE_IMAGE, ...command)
  await docker('cp', helper.caPath, `${name}:/tmp/ca.pem`)
  return name
}

describe.skipIf(!runnable)('the network helper', () => {
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'bench-helper-spec-'))
    const image = await buildHelperImage(realDocker)
    helper = await startHelper(realDocker, image, { runId: `spec-${id}`, outDir, canaries: { 'model key': CANARY }, proxyArgs: '--set ssl_insecure=true' })
    created.push(helper.name)
    const targetName = `bench-spec-target-${id}`
    created.push(targetName)
    await docker('create', '--name', targetName, '--label', 'delorun.bench=1', '--cap-drop', 'ALL', '--user', '1000:1000', NODE_IMAGE, 'node', '/tmp/target-server.mjs')
    await docker('cp', join(FIXTURES, 'target-server.mjs'), `${targetName}:/tmp/target-server.mjs`)
    await docker('start', targetName)
    for (let attempt = 0; attempt < 100 && !(await docker('logs', targetName)).includes('ready'); attempt++) await new Promise(done => setTimeout(done, 200))
    const target = await docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', targetName)

    const name = `bench-spec-plugin-${id}`
    await plugin(name, ['node', '/tmp/plugin-activity.mjs', target, CANARY], ['--env', 'NODE_EXTRA_CA_CERTS=/tmp/ca.pem'])
    await docker('cp', join(FIXTURES, 'plugin-activity.mjs'), `${name}:/tmp/plugin-activity.mjs`)
    await docker('start', '--attach', name).then((output) => { pluginOutput = output })
    pluginId = name
    pluginInspect = await inspect(name)
    helperInspect = await inspect(helper.name)

    const noCa = await plugin(`bench-spec-nocert-${id}`, ['node', '-e', `fetch('https://${target}:8443/').then(() => console.log('reached'), () => console.log('refused'))`])
    failedClientOutput = await docker('start', '--attach', noCa)
    const caps = await plugin(`bench-spec-caps-${id}`, ['sh', '-c', 'grep CapEff /proc/self/status; id -u'])
    capabilityLine = await docker('start', '--attach', caps)
    await new Promise(done => setTimeout(done, 600))
    report = await readHelperReport(await collectHelper(realDocker, helper.name, outDir))
  }, 600_000)

  afterAll(async () => {
    for (const name of created.reverse()) await realDocker(['rm', '--force', name])
    if (outDir !== undefined) await rm(outDir, { recursive: true, force: true })
  }, 120_000)

  it('gives the helper only NET_ADMIN and the plugin container no capabilities, and the plugin container the helper\'s network', () => {
    expect((helperInspect.HostConfig.CapAdd as string[]).map(name => name.replace(/^CAP_/, ''))).toEqual(['NET_ADMIN'])
    expect(helperInspect.HostConfig.CapDrop).toEqual(['ALL'])
    expect(helperInspect.HostConfig.Privileged).toBe(false)
    expect(helperInspect.HostConfig.SecurityOpt).toContain('no-new-privileges')
    expect(helperInspect.HostConfig.ReadonlyRootfs).toBe(true)
    expect(helperInspect.HostConfig.Binds ?? []).toEqual([])
    expect(helperInspect.Config.Labels['delorun.bench']).toBe('1')
    expect(pluginInspect.HostConfig.CapAdd ?? []).toEqual([])
    expect(pluginInspect.HostConfig.CapDrop).toEqual(['ALL'])
    expect(pluginInspect.HostConfig.Privileged).toBe(false)
    expect(pluginInspect.HostConfig.SecurityOpt).toContain('no-new-privileges')
    expect(pluginInspect.HostConfig.NetworkMode).toBe(`container:${helperInspect.Id}`)
    expect(pluginInspect.HostConfig.Binds ?? []).toEqual([])
    expect(pluginInspect.Config.User).toBe('1000:1000')
  })

  it('shows the plugin container an empty effective capability set, as a non-root user', () => {
    expect(capabilityLine).toContain('CapEff:\t0000000000000000')
    expect(capabilityLine.trim().split('\n').pop()).toBe('1000')
  })

  it('lets the plugin\'s HTTP and HTTPS requests through the proxy, and finds the canary in the URL, a header and the body', () => {
    expect(JSON.parse(pluginOutput.trim().split('\n').pop() ?? '{}')).toEqual({ http: 200, https: 200 })
    const hosts = report.hosts.filter(host => host.canaries.includes('model key'))
    expect(hosts.map(host => host.port).sort()).toEqual(['8080', '8443'])
    const plain = hosts.find(host => host.port === '8080')
    expect(plain?.where['model key']).toBe('url')
    expect(plain?.requests).toBe(1)
    expect(hosts.find(host => host.port === '8443')?.where['model key']).toBe('body')
  })

  it('reports a client that does not trust the proxy\'s CA as contents not checked', async () => {
    expect(failedClientOutput.trim()).toBe('refused')
    expect(report.hosts.some(host => host.pinned && host.port === '8443')).toBe(true)
  })

  it('logs the plugin container\'s listens and the programs it starts', () => {
    expect(report.net).toContainEqual(expect.objectContaining({ t: 'listen', host: '0.0.0.0', port: '4000' }))
    expect(report.net.some(event => event.t === 'exec' && event.cmd.includes('sleep 1'))).toBe(true)
    expect(report.net.some(event => event.t === 'connect' && event.port === '8080')).toBe(true)
  })

  it('made a throwaway CA for this run', async () => {
    const pem = await readFile(helper.caPath, 'utf8')
    expect(pem).toContain('BEGIN CERTIFICATE')
    expect(pluginId).toContain(id)
  })

  it('stops and removes the helper', async () => {
    await stopHelper(realDocker, helper.name)
    expect((await realDocker(['inspect', helper.name])).status).not.toBe(0)
  })
})
