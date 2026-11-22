import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Docker } from '../../../src/compat-bench/privacy/docker.ts'
import { createPrivacyObserver, parseDiff } from '../../../src/compat-bench/privacy/observer.ts'
import type { PrivacySection } from '../../../src/compat-bench/observer.ts'
import type { PrivacyAdditions, PrivacyRunContext } from '../../../src/compat-bench/privacy/types.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const folder = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'bench-observer-')); temporary.push(dir); return dir }

type Script = Readonly<{ diff?: string; found?: Record<string, string[]>; hosts?: object; net?: object[] }>
/** A fake docker that answers the observer's commands and records them. */
function fakeDocker(script: Script = {}): { docker: Docker; calls: string[][] } {
  const calls: string[][] = []
  const docker: Docker = async (args) => {
    calls.push([...args])
    const [command] = args
    if (command === 'exec' && args.includes('cat')) {
      const file = args[args.length - 1] ?? ''
      if (file === '/out/ca.pem') return { stdout: '-----CA-PEM-FOR-TEST-----\n', stderr: '', status: 0 }
      if (file === '/out/hosts.json') return { stdout: JSON.stringify(script.hosts ?? { hosts: [] }), stderr: '', status: 0 }
      if (file === '/out/net.jsonl') return { stdout: (script.net ?? []).map(event => JSON.stringify(event)).join('\n'), stderr: '', status: 0 }
    }
    if (command === 'exec' && args.includes('ls')) return { stdout: 'ca.pem\nhosts.json\nnet.jsonl\nready\n', stderr: '', status: 0 }
    if (command === 'diff') return { stdout: script.diff ?? '', stderr: '', status: 0 }
    if (command === 'exec' && args.includes('grep')) {
      const value = args[args.indexOf('-e') + 1] ?? ''
      return { stdout: (script.found?.[value] ?? []).join('\n'), stderr: '', status: 0 }
    }
    if (command === 'inspect') return { stdout: 'true', stderr: '', status: 0 }
    return { stdout: '', stderr: '', status: 0 }
  }
  return { docker, calls }
}

const context = (outDir: string, partial: Partial<PrivacyRunContext> = {}): PrivacyRunContext => ({ host: 'delorun', package: 'fixture-plugin', outDir, runId: 'run-a1', baseline: false, publish: { host: 18750, container: 18750 }, ...partial })

describe('the privacy observer', () => {
  it('starts the helper and tells the runner what to add to the plugin container', async () => {
    const out = await folder()
    const { docker, calls } = fakeDocker()
    const observer = createPrivacyObserver({ docker, baselineDir: await folder() })
    const additions = await observer.prepare(context(out, { baseline: true })) as PrivacyAdditions
    const run = calls.find(call => call[0] === 'run')
    expect(run).toBeDefined()
    expect(run).toContain('127.0.0.1:18750:18750')
    expect(additions.networkContainer).toBe('bench-helper-run-a1')
    expect(additions.pidContainer).toBe('bench-helper-run-a1')
    expect(additions.preloads).toEqual(['/home/bench/.bench-privacy/privacy-preload.mjs'])
    expect(additions.caCertPath).toBe('/home/bench/.bench-privacy/ca.pem')
    expect(additions.env?.DELORUN_PRIVACY_LOG).toBe('/out/privacy/events.jsonl')
    expect(additions.env?.NODE_EXTRA_CA_CERTS).toBe('/home/bench/.bench-privacy/ca.pem')
    expect(additions.env?.DEEPSEEK_API_KEY).toMatch(/^sk-bench-canary-/)
    expect(additions.testChatMarker).toMatch(/^quokka-/)
    expect(additions.files?.map(file => file.path)).toEqual(expect.arrayContaining(['/home/bench/.bench-privacy/privacy-preload.mjs', '/home/bench/.bench-privacy/ca.pem', '/home/bench/.ssh/id_ed25519', '/home/bench/workspace/.env']))
    expect(additions.files?.find(file => file.path === '/home/bench/.bench-privacy/ca.pem')?.content).toContain('CA-PEM-FOR-TEST')
    expect(JSON.parse(additions.env?.DELORUN_PRIVACY_WATCH ?? '[]')).toEqual(expect.arrayContaining([expect.objectContaining({ label: '~/.ssh/' })]))
    expect(additions.env?.DEEPSEEK_API_KEY).toBe(JSON.parse(run?.find(arg => arg.startsWith('BENCH_CANARIES=') )?.slice('BENCH_CANARIES='.length) ?? '{}')['model key'])
  })

  it('records a baseline, then reports a plugin run against it', async () => {
    const baselineDir = await folder()
    // The baseline: Delorun starts a studio on 18750 and reads its own key.
    const baseOut = await folder()
    const base = fakeDocker({ diff: 'A /home/bench/.delorun/sessions/0a1b2c3d4e5f/chat.jsonl\n' })
    const baseObserver = createPrivacyObserver({ docker: base.docker, baselineDir })
    await baseObserver.prepare(context(baseOut, { baseline: true, runId: 'base-1' }))
    await mkdir(join(baseOut, 'privacy'), { recursive: true })
    await writeFile(join(baseOut, 'privacy', 'events.jsonl'), `${JSON.stringify({ t: 'listen', pid: 1, host: '127.0.0.1', port: '18750' })}\n${JSON.stringify({ t: 'env', pid: 1, name: 'DEEPSEEK_API_KEY' })}\n`)
    expect(await baseObserver.finish(context(baseOut, { baseline: true, runId: 'base-1' }))).toBeUndefined()

    const out = await folder()
    const plugin = fakeDocker({
      diff: 'A /home/bench/.delorun/sessions/ffeeddccbbaa/chat.jsonl\nA /home/bench/.delorun/plugins/fixture-plugin\nA /home/bench/.delorun/plugins/fixture-plugin/data.json\nA /tmp/x\n',
      hosts: { hosts: [{ host: 'api.example.com', port: '443', canaries: ['chat word'], where: { 'chat word': 'body' }, requests: 1, pinned: false }] },
      net: [{ t: 'connect', host: '203.0.113.9', port: '443', name: 'api.example.com' }],
    })
    const observer = createPrivacyObserver({ docker: plugin.docker, baselineDir })
    const additions = await observer.prepare(context(out)) as PrivacyAdditions
    await writeFile(join(out, 'privacy', 'events.jsonl'), [
      { t: 'listen', pid: 1, host: '127.0.0.1', port: '18750' },
      { t: 'env', pid: 1, name: 'DEEPSEEK_API_KEY' },
      { t: 'exec', pid: 1, file: '/usr/bin/git', args: 'status' },
      { t: 'listen', pid: 1, host: '0.0.0.0', port: '4000' },
    ].map(event => JSON.stringify(event)).join('\n'))
    await mkdir(join(out, 'logs'), { recursive: true })
    await writeFile(join(out, 'plugin-package.json'), JSON.stringify({ name: 'fixture-plugin', dsh: { access: { version: 1, actsForYou: { actions: ['runs-commands'], why: 'Runs git status.' } } } }))
    await observer.mark('uninstall', 'after', context(out))
    expect(plugin.calls.some(call => call[0] === 'diff' && call[1] === 'bench-run-a1')).toBe(true)
    const report = await observer.finish(context(out)) as PrivacySection
    expect(additions.testChatMarker).toBeDefined()
    expect(report.markers.actsForYou.state).toBe('declared')
    expect(report.markers.opensADoor.summary).toContain('all addresses, port 4000')
    expect(report.markers.sendsOut.summary).toBe('Connected to api.example.com in this test.')
    expect(report.markers.chats.summary).toContain('Sent your chat to api.example.com in this test.')
    expect(report.markers.modelKeys.state).toBe('not-seen')
    expect(report.markers.leavesBehind.summary).toContain('/home/bench/.delorun/plugins/fixture-plugin')
    expect(report.markers.leavesBehind.summary).not.toContain('sessions')
    expect(report.markers.opensADoor.evidence[0]).toBe('finding: seen and not declared in dsh.access')
    expect(report.markers.actsForYou.evidence[0]).toBe('started /usr/bin/git status')
    expect(report.findings).toEqual(expect.arrayContaining([expect.stringMatching(/^Opens a door: seen and not declared/)]))
    expect(report.declared).toEqual({ actsForYou: 'Runs git status.' })
    expect(report).not.toHaveProperty('problems')
    const kept = JSON.parse(await readFile(join(out, 'privacy', 'report.json'), 'utf8'))
    expect(kept.findings).toEqual(expect.arrayContaining([expect.stringMatching(/^Opens a door: seen and not declared/)]))
    expect(kept.findings.some((finding: string) => finding.startsWith('Acts for you'))).toBe(false)
    expect(kept.declared).toEqual({ actsForYou: 'Runs git status.' })
    expect(plugin.calls.filter(call => call[0] === 'rm').length).toBeGreaterThan(0)
    expect(JSON.parse(await readFile(join(out, 'privacy', 'helper', 'hosts.json'), 'utf8')).hosts).toHaveLength(1)
  })

  it('refuses to start a plugin run before a baseline was recorded, and starts nothing', async () => {
    const out = await folder()
    const { docker, calls } = fakeDocker()
    const observer = createPrivacyObserver({ docker, baselineDir: await folder() })
    await expect(observer.prepare(context(out))).rejects.toThrow('no privacy baseline for delorun: run `bench baseline --host delorun` first')
    expect(calls).toEqual([])
  })

  it('returns nothing for a run it did not prepare', async () => {
    const { docker } = fakeDocker()
    expect(await createPrivacyObserver({ docker }).finish(context(await folder(), { runId: 'unknown' }))).toBeUndefined()
  })

  it('counts only what happened while the plugin was running, not the install or the removal', async () => {
    const baselineDir = await folder()
    const baseOut = await folder()
    const base = fakeDocker()
    const baseObserver = createPrivacyObserver({ docker: base.docker, baselineDir })
    await baseObserver.prepare(context(baseOut, { baseline: true, runId: 'base-2' }))
    await baseObserver.finish(context(baseOut, { baseline: true, runId: 'base-2' }))

    const out = await folder()
    let clock = Date.parse('2026-11-22T10:00:00.000Z')
    const at = (seconds: number): number => Date.parse('2026-11-22T10:00:00.000Z') + seconds * 1000
    const observer = createPrivacyObserver({ docker: fakeDocker().docker, baselineDir, now: () => new Date(clock) })
    await observer.prepare(context(out))
    await mkdir(join(out, 'privacy'), { recursive: true })
    const lines = [
      { ts: at(5), t: 'connect', pid: 1, host: 'registry.example.org', port: '443', proto: 'tcp' },
      { ts: at(25), t: 'connect', pid: 1, host: 'api.example.com', port: '443', proto: 'tcp' },
      { ts: at(75), t: 'exec', pid: 1, file: '/usr/bin/npm', args: 'rm' },
      { ts: at(26), t: 'exec', pid: 1, file: '/usr/local/bin/node', args: '/opt/bench/ctl.mjs link' },
    ]
    await writeFile(join(out, 'privacy', 'events.jsonl'), lines.map(line => JSON.stringify(line)).join('\n'))
    const stage = async (name: 'install' | 'start' | 'uninstall', from: number, to: number): Promise<void> => {
      clock = at(from)
      await observer.mark(name, 'before', context(out))
      clock = at(to)
      await observer.mark(name, 'after', context(out))
    }
    await stage('install', 0, 10)
    await stage('start', 20, 30)
    await stage('uninstall', 70, 80)
    const report = await observer.finish(context(out)) as PrivacySection
    expect(report.markers.sendsOut.summary).toBe('Connected to api.example.com in this test.')
    expect(report.markers.actsForYou.state).toBe('not-seen')
  })
})

describe('docker diff', () => {
  it('is parsed into added, changed and deleted paths', () => {
    expect(parseDiff('A /a\nC /b\nD /c\n\nsomething else\nA relative\n')).toEqual([{ kind: 'A', path: '/a' }, { kind: 'C', path: '/b' }, { kind: 'D', path: '/c' }])
  })
})
