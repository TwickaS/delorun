/**
 * The privacy observer end to end against the Docker engine, with no bench runner: a baseline run of a host-like
 * script, then a run of the same script plus a fixture plugin that does ordinary things it declares (fetches and posts
 * over HTTP and HTTPS, reads a credential file and the planted workspace file, listens, starts a program, keeps an
 * index of the chat). The observer plants the canaries, starts the helper, and turns the logs into the markers. The
 * plugin container is started as the runner starts one: no capabilities, the helper's network and process namespace,
 * the output folder mounted at `/out`. Every object carries `delorun.bench=1`; the spec removes only what it created.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrivacySection } from '../../../src/compat-bench/observer.ts'
import { realDocker } from '../../../src/compat-bench/privacy/docker.ts'
import { createPrivacyObserver } from '../../../src/compat-bench/privacy/observer.ts'
import type { PrivacyAdditions, PrivacyRunContext } from '../../../src/compat-bench/privacy/types.ts'

const NODE_IMAGE = 'node:24.21.0-bookworm'
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const LAYOUT = { userHome: '/home/node', workspace: '/home/node/workspace', delorunHome: '/home/node/home/delorun' }
const required = process.env['DELORUN_DOCKER_SPECS'] === '1'
const engine = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 120_000 }).status === 0
const runnable = engine && spawnSync('docker', ['image', 'inspect', NODE_IMAGE], { stdio: 'ignore', timeout: 120_000 }).status === 0
if (required && !runnable) throw new Error(`the Docker lane requires this spec: an engine that answers and the image ${NODE_IMAGE} (docker pull ${NODE_IMAGE})`)

const id = randomBytes(3).toString('hex')
const created: string[] = [`bench-helper-e2e-base-${id}`, `bench-helper-e2e-plugin-${id}`]
const folders: string[] = []
let report: PrivacySection
let additions: PrivacyAdditions

const docker = async (...args: string[]): Promise<string> => {
  const result = await realDocker(args, { timeoutMs: 180_000 })
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** Start a plugin container as the runner does, and put the observer's files in it. */
async function startPluginContainer(name: string, outDir: string, added: PrivacyAdditions): Promise<void> {
  created.push(name)
  const env = { ...added.env, NODE_OPTIONS: (added.preloads ?? []).map(path => `--import ${path}`).join(' '), ...added.caCertPath === undefined ? {} : { NODE_EXTRA_CA_CERTS: added.caCertPath }, HOME: LAYOUT.userHome }
  await docker('run', '--detach', '--name', name, '--label', 'delorun.bench=1', '--network', `container:${added.networkContainer}`, '--pid', `container:${added.networkContainer}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--volume', `${outDir}:/out`, ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), NODE_IMAGE, 'sleep', 'infinity')
  for (const file of added.files ?? []) {
    const written = await realDocker(['exec', '-i', name, 'sh', '-c', `mkdir -p "$(dirname '${file.path}')" && cat > '${file.path}' && chmod ${(file.mode ?? 0o644).toString(8)} '${file.path}'`], { input: file.content })
    if (written.status !== 0) throw new Error(`could not write ${file.path}: ${written.stderr}`)
  }
  await docker('cp', join(FIXTURES, 'host-like.mjs'), `${name}:/tmp/host-like.mjs`)
  await docker('cp', join(FIXTURES, 'declared-plugin.mjs'), `${name}:/tmp/declared-plugin.mjs`)
}

describe.skipIf(!runnable)('the privacy observer against a plugin container', () => {
  beforeAll(async () => {
    const baselineDir = await mkdtemp(join(tmpdir(), 'bench-e2e-baseline-'))
    folders.push(baselineDir)
    const observer = createPrivacyObserver({ layout: LAYOUT, baselineDir, proxyArgs: '--set ssl_insecure=true' })

    // The target the plugin talks to: plain HTTP on 8080 and HTTPS on 8443.
    const targetName = `bench-e2e-target-${id}`
    created.push(targetName)
    await docker('create', '--name', targetName, '--label', 'delorun.bench=1', '--cap-drop', 'ALL', '--user', '1000:1000', NODE_IMAGE, 'node', '/tmp/target-server.mjs')
    await docker('cp', join(FIXTURES, 'target-server.mjs'), `${targetName}:/tmp/target-server.mjs`)
    await docker('start', targetName)
    for (let attempt = 0; attempt < 100 && !(await docker('logs', targetName)).includes('ready'); attempt++) await new Promise(done => setTimeout(done, 200))
    const target = await docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', targetName)

    // The baseline: the host-like script alone, with the mock model's request for the test chat.
    const baseOut = await mkdtemp(join(tmpdir(), 'bench-e2e-base-out-'))
    folders.push(baseOut)
    const baseContext: PrivacyRunContext = { host: 'delorun', package: '(none)', outDir: baseOut, runId: `e2e-base-${id}`, baseline: true }
    const baseAdditions = await observer.prepare(baseContext) as PrivacyAdditions
    await startPluginContainer(`bench-${baseContext.runId}`, baseOut, baseAdditions)
    await docker('exec', `bench-${baseContext.runId}`, 'node', '/tmp/host-like.mjs')
    await mkdir(join(baseOut, 'logs'), { recursive: true })
    await writeFile(join(baseOut, 'logs', 'mock-requests.jsonl'), `${JSON.stringify({ model: 'm', system: 'You are helpful.', tools: [{ name: 'read' }], messages: [{ role: 'user', content: `hello ${baseAdditions.testChatMarker}` }] })}\n`)
    await observer.mark('uninstall', 'after', baseContext)
    expect(await observer.finish(baseContext)).toBeUndefined()
    await docker('rm', '--force', `bench-${baseContext.runId}`)

    // The plugin run.
    const out = await mkdtemp(join(tmpdir(), 'bench-e2e-out-'))
    folders.push(out)
    const context: PrivacyRunContext = { host: 'delorun', package: 'fixture-plugin', outDir: out, runId: `e2e-plugin-${id}`, baseline: false }
    additions = await observer.prepare(context) as PrivacyAdditions
    const name = `bench-${context.runId}`
    await startPluginContainer(name, out, additions)
    await docker('exec', name, 'node', '/tmp/host-like.mjs')
    await docker('exec', name, 'node', '/tmp/declared-plugin.mjs', target, additions.testChatMarker ?? '', LAYOUT.userHome, LAYOUT.workspace)
    await mkdir(join(out, 'logs'), { recursive: true })
    await writeFile(join(out, 'logs', 'mock-requests.jsonl'), `${JSON.stringify({ model: 'm', system: 'You are helpful.', tools: [{ name: 'read' }, { name: 'remember_all' }], messages: [{ role: 'user', content: `hello ${additions.testChatMarker}` }] })}\n`)
    await writeFile(join(out, 'plugin-package.json'), JSON.stringify({ name: 'fixture-plugin', dsh: { access: { sendsOut: 'Posts a note to the sync service.', opensADoor: 'Serves its status page.' } } }))
    await observer.mark('uninstall', 'after', context)
    report = await observer.finish(context) as PrivacySection
    await docker('rm', '--force', name)
  }, 900_000)

  afterAll(async () => {
    for (const name of created.reverse()) await realDocker(['rm', '--force', name])
    await Promise.all(folders.map(folder => rm(folder, { recursive: true, force: true })))
  }, 120_000)

  it('plants the canaries in the plugin container and adds the preload, the CA and the network', () => {
    expect(additions.networkContainer).toMatch(/^bench-helper-/)
    expect(additions.testChatMarker).toMatch(/^quokka-/)
    expect(additions.files?.map(file => file.path)).toContain('/home/node/.ssh/id_ed25519')
  })

  it('Sends out: names the service the plugin posted to, as the author declared', () => {
    expect(report.markers.sendsOut.state).toBe('declared')
    expect(report.markers.sendsOut.summary).toMatch(/^Connected to 172\.\d+\.\d+\.\d+:8080 and 172\.\d+\.\d+\.\d+:8443 in this test\. The author declared this: Posts a note to the sync service\.$/)
  })

  it('Your chats: the marker word left in the note, and a copy kept on disk after the plugin was removed', () => {
    expect(report.markers.chats.state).toBe('seen')
    expect(report.markers.chats.summary).toMatch(/Sent your chat to 172\.\d+\.\d+\.\d+:8080 in this test\./)
    expect(report.markers.chats.summary).toContain('Kept a copy of your chat in /home/node/.cache/fixture-plugin/index.json')
  })

  it('Model keys: the key in an Authorization header, and its variable looked up', () => {
    expect(report.markers.modelKeys.state).toBe('seen')
    expect(report.markers.modelKeys.summary).toMatch(/Sent your model key to 172\.\d+\.\d+\.\d+:8080 in this test\./)
  })

  it('Other secrets: the credential file opened and its contents sent over HTTPS', () => {
    expect(report.markers.otherSecrets.state).toBe('seen')
    expect(report.markers.otherSecrets.summary).toContain('Opened ~/.ssh/id_ed25519 in this test.')
    expect(report.markers.otherSecrets.summary).toMatch(/Sent the contents of ~\/\.ssh\/id_ed25519 to 172\.\d+\.\d+\.\d+:8443 in this test\./)
  })

  it('Your code: the planted workspace file opened and its contents sent', () => {
    expect(report.markers.code.state).toBe('seen')
    expect(report.markers.code.summary).toMatch(/Opened a file in your workspace that the test planted\. Sent the contents of a file in your workspace to 172\.\d+\.\d+\.\d+:8080 in this test\./)
  })

  it('Acts for you: a program started, and the model request that changed', () => {
    expect(report.markers.actsForYou.summary).toContain('Started sleep on your machine in this test.')
    expect(report.markers.actsForYou.summary).toContain('Changed what Delorun sent to the model in this test.')
    expect(report.markers.actsForYou.evidence).toContain('model request: a tool was added (remember_all)')
  })

  it('Opens a door: a listener on every address, declared by the author', () => {
    expect(report.markers.opensADoor.state).toBe('declared')
    expect(report.markers.opensADoor.summary).toContain('Started listening on all addresses, port 4000, where other machines can connect')
  })

  it('Leaves behind: the index the plugin kept, not the host\'s own files', () => {
    expect(report.markers.leavesBehind.state).toBe('seen')
    expect(report.markers.leavesBehind.summary).toContain('/home/node/.cache/fixture-plugin')
    expect(report.markers.leavesBehind.summary).not.toContain('.ssh')
  })

  it('does not show the baseline\'s own loopback listener, program or key lookup as the plugin\'s', () => {
    expect(report.markers.opensADoor.summary).not.toContain('18590')
    expect(report.markers.actsForYou.evidence.filter(line => line.startsWith('started'))).toHaveLength(1)
    expect(report.markers.modelKeys.summary).not.toContain('Looked up')
  })

  it('reads the encrypted traffic with the helper\'s CA', () => {
    expect(report.contentsChecked).toBe(true)
    expect(report.findings?.some(finding => finding.startsWith('Sends out'))).toBe(false)
    expect(report.findings?.some(finding => finding.startsWith('Your chats'))).toBe(true)
  })

  it('never prints a canary value in the card section', async () => {
    expect(JSON.stringify(report)).not.toMatch(/sk-bench-canary|BENCH-FAKE|bench-fake-/)
    expect(await readFile(join(folders[2] ?? '', 'privacy', 'report.json'), 'utf8')).not.toMatch(/sk-bench-canary|BENCH-FAKE|bench-fake-/)
  })
})
