import { describe, expect, it } from 'vitest'
import { buildPrivacy, isLoopback, normalisePath, phrase } from '../../../src/compat-bench/privacy/markers.ts'
import { DEFAULT_LAYOUT } from '../../../src/compat-bench/privacy/canaries.ts'
import { MARKER_KEYS } from '../../../src/compat-bench/privacy/types.ts'
import type { MarkerKey, Observed } from '../../../src/compat-bench/privacy/types.ts'

const quiet: Observed = { connects: [], listens: [], execs: [], envNames: [], envEnumerated: false, opens: [], fileChanges: [], leftCanaries: [], proxy: [], requestChanges: [], contentsChecked: true }
const section = (observed: Partial<Observed>, declared: Partial<Record<MarkerKey, string>> = {}) => buildPrivacy({ ...quiet, ...observed }, declared)
const BANNED = /\b(can only|only can|allowed|allow|permission|permissions|could access|may access)\b/i

describe('privacy markers', () => {
  it('shows all eight markers as not seen for a quiet run', () => {
    const result = section({})
    expect(Object.keys(result.markers)).toEqual([...MARKER_KEYS])
    for (const key of MARKER_KEYS) expect(result.markers[key].state).toBe('not-seen')
    expect(result.contentsChecked).toBe(true)
    expect(result.findings).toBeUndefined()
  })

  it('Your code: a planted workspace file that was opened, a workspace file that changed, and its contents leaving', () => {
    const result = section({
      opens: [{ label: 'workspace marker file', path: '/home/bench/workspace/bench-marker.txt' }],
      fileChanges: [{ kind: 'C', path: '/home/bench/workspace/src/index.ts' }],
      proxy: [{ host: 'api.example.com', port: '443', canaries: ['workspace marker file'], where: { 'workspace marker file': 'body' }, requests: 1, pinned: false }],
    })
    const marker = result.markers.code
    expect(marker.state).toBe('seen')
    expect(marker.summary).toContain('Opened a file in your workspace')
    expect(marker.summary).toContain('Changed 1 file in your workspace (src/index.ts)')
    expect(marker.summary).toContain('Sent the contents of a file in your workspace to api.example.com in this test')
    expect(marker.evidence).toContain('changed /home/bench/workspace/src/index.ts')
  })

  it('Your chats: the marker word reaching a host, and a copy kept after uninstall', () => {
    const result = section({
      proxy: [{ host: 'api.example.com', port: '443', canaries: ['chat word'], where: { 'chat word': 'body' }, requests: 2, pinned: false }],
      leftCanaries: [{ canary: 'chat word', path: '/home/bench/.cache/plugin/history.json' }],
    })
    expect(result.markers.chats.state).toBe('seen')
    expect(result.markers.chats.summary).toContain('Sent your chat to api.example.com in this test.')
    expect(result.markers.chats.summary).toContain('Kept a copy of your chat in /home/bench/.cache/plugin/history.json')
  })

  it('Model keys: the key in a request, the key store opened, the variable looked up', () => {
    const result = section({
      proxy: [{ host: 'collector.example.net', port: '8443', canaries: ['model key'], where: { 'model key': 'header' }, requests: 1, pinned: false }],
      opens: [{ label: 'Delorun key store', path: '/home/bench/.delorun/credentials.yaml' }],
      envNames: ['DEEPSEEK_API_KEY', 'HOME'],
    })
    expect(result.markers.modelKeys.state).toBe('seen')
    expect(result.markers.modelKeys.summary).toContain('Sent your model key to collector.example.net:8443 in this test.')
    expect(result.markers.modelKeys.summary).toContain('Opened the place Delorun keeps your model key.')
    expect(result.markers.modelKeys.summary).toContain('Looked up DEEPSEEK_API_KEY in its environment.')
    expect(result.markers.modelKeys.summary).not.toContain('HOME')
  })

  it('Other secrets: credential files, other tokens in the environment, a listing of the environment', () => {
    const result = section({
      opens: [{ label: '~/.ssh/id_ed25519', path: '/home/bench/.ssh/id_ed25519' }, { label: '~/.aws/', path: '/home/bench/.aws/credentials' }],
      envNames: ['GITHUB_TOKEN', 'PATH', 'DEEPSEEK_API_KEY'],
      envEnumerated: true,
      proxy: [{ host: 'paste.example.org', port: '443', canaries: ['~/.config/gh/hosts.yml'], where: {}, requests: 1, pinned: false }],
    })
    const marker = result.markers.otherSecrets
    expect(marker.state).toBe('seen')
    expect(marker.summary).toContain('Opened ~/.ssh/id_ed25519 and ~/.aws/ in this test.')
    expect(marker.summary).toContain('Sent the contents of ~/.config/gh/hosts.yml to paste.example.org in this test.')
    expect(marker.summary).toContain('Looked up GITHUB_TOKEN in its environment.')
    expect(marker.summary).toContain('Listed all the names in its environment.')
    expect(marker.summary).not.toContain('PATH')
  })

  it('Sends out: names the hosts outside this machine, not the loopback ones', () => {
    const result = section({ connects: [{ host: '127.0.0.1', port: '18750' }, { host: '203.0.113.9', port: '443', name: 'api.example.com' }, { host: '203.0.113.10', port: '8080' }] })
    expect(result.markers.sendsOut.state).toBe('seen')
    expect(result.markers.sendsOut.summary).toBe('Connected to api.example.com and 203.0.113.10:8080 in this test.')
    expect(result.markers.sendsOut.evidence).toEqual(['finding: seen and not declared in dsh.access', 'connect api.example.com (203.0.113.9):443', 'connect 203.0.113.10:8080'])
    expect(section({ connects: [{ host: '127.0.0.1', port: '18750' }, { host: 'localhost', port: '3000' }] }).markers.sendsOut.state).toBe('not-seen')
  })

  it('Acts for you: programs started and a changed model request', () => {
    const result = section({ execs: ['/usr/bin/git status --short', 'git log'], requestChanges: ['a tool was added (read_secret_note)'] })
    expect(result.markers.actsForYou.state).toBe('seen')
    expect(result.markers.actsForYou.summary).toContain('Started git on your machine in this test.')
    expect(result.markers.actsForYou.summary).toContain('Changed what Delorun sent to the model in this test.')
    expect(result.markers.actsForYou.evidence).toContain('model request: a tool was added (read_secret_note)')
  })

  it('Opens a door: says whether other machines can connect', () => {
    const open = section({ listens: [{ host: '0.0.0.0', port: '4000' }] })
    expect(open.markers.opensADoor.summary).toBe('Started listening on all addresses, port 4000, where other machines can connect, in this test.')
    const local = section({ listens: [{ host: '127.0.0.1', port: '4001' }] })
    expect(local.markers.opensADoor.summary).toBe('Started listening on 127.0.0.1:4001, on this machine only, in this test.')
    expect(local.markers.opensADoor.state).toBe('seen')
  })

  it('Leaves behind: files that remain after uninstall, not the workspace or temporary files', () => {
    const result = section({
      fileChanges: [
        { kind: 'A', path: '/home/bench/.delorun/plugins/fixture-plugin/data.json' },
        { kind: 'A', path: '/tmp/scratch' },
        { kind: 'D', path: '/home/bench/.delorun/plugins/old' },
        { kind: 'C', path: '/home/bench/workspace/notes.md' },
      ],
      leftCanaries: [{ canary: 'model key', path: '/home/bench/.delorun/plugins/fixture-plugin/data.json' }],
    })
    const marker = result.markers.leavesBehind
    expect(marker.state).toBe('seen')
    expect(marker.summary).toContain('Left 1 file behind after it was removed (/home/bench/.delorun/plugins/fixture-plugin/data.json).')
    expect(marker.summary).toContain('Kept copies of model key after it was removed.')
  })

  it('shows "not checked" for the content markers when the contents of what went out could not be read', () => {
    const result = section({
      connects: [{ host: '203.0.113.9', port: '443', name: 'pinned.example.com' }],
      proxy: [{ host: 'pinned.example.com', port: '443', canaries: [], where: {}, requests: 0, pinned: true }],
    })
    for (const key of ['code', 'chats', 'modelKeys', 'otherSecrets'] as const) {
      expect(result.markers[key].state).toBe('not-checked')
      expect(result.markers[key].summary).toContain('could not be read in this test, so this is not checked')
    }
    expect(result.markers.sendsOut.state).toBe('seen')
    expect(result.contentsChecked).toBe(false)
  })

  it('shows "not checked" when connections went out and no helper ran, but not when nothing went out', () => {
    expect(section({ contentsChecked: false, connects: [{ host: '203.0.113.9', port: '443' }] }).markers.chats.state).toBe('not-checked')
    expect(section({ contentsChecked: false }).markers.chats.state).toBe('not-seen')
  })

  it('shows a seen marker the author declared as declared, and one the author did not declare as a finding', () => {
    const result = section(
      { connects: [{ host: '203.0.113.9', port: '443', name: 'api.example.com' }], execs: ['git status'] },
      { sendsOut: 'Fetches the page you ask it to read.' },
    )
    expect(result.markers.sendsOut.state).toBe('declared')
    expect(result.markers.sendsOut.summary).toBe('Connected to api.example.com in this test. The author declared this: Fetches the page you ask it to read.')
    expect(result.markers.actsForYou.state).toBe('seen')
    expect(result.findings).toEqual(['Acts for you: seen and not declared in dsh.access. Started git on your machine in this test.'])
    expect(result.markers.actsForYou.evidence[0]).toBe('finding: seen and not declared in dsh.access')
    expect(result.markers.sendsOut.evidence[0]).toBe('connect api.example.com (203.0.113.9):443')
    expect(result.declared).toEqual({ sendsOut: 'Fetches the page you ask it to read.' })
  })

  it('shows a declared marker that was not seen as declared, with what the test saw', () => {
    const result = section({}, { opensADoor: 'Serves its settings page.' })
    expect(result.markers.opensADoor.state).toBe('declared')
    expect(result.markers.opensADoor.summary).toBe('The author declared: Serves its settings page. Did not start listening for connections in this test.')
    expect(result.findings).toBeUndefined()
  })

  it('never writes "can only", "allowed" or "permission" in a summary (L141)', () => {
    const everything = section(
      {
        opens: [{ label: '~/.ssh/id_ed25519', path: '/x' }, { label: 'Delorun key store', path: '/y' }, { label: 'workspace marker file', path: '/z' }],
        envNames: ['GITHUB_TOKEN', 'DEEPSEEK_API_KEY'], envEnumerated: true, execs: ['git'], listens: [{ host: '0.0.0.0', port: '1' }, { host: '127.0.0.1', port: '2' }],
        connects: [{ host: '203.0.113.9', port: '443' }], fileChanges: [{ kind: 'A', path: '/home/bench/.x' }], requestChanges: ['a tool was added (t)'],
        proxy: [{ host: 'h.example.com', port: '443', canaries: ['chat word', 'model key', '~/.aws/credentials', 'workspace marker file'], where: {}, requests: 1, pinned: false }],
        leftCanaries: [{ canary: 'chat word', path: '/q' }],
      },
      { code: 'Reads your files.' },
    )
    for (const key of MARKER_KEYS) expect(everything.markers[key].summary).not.toMatch(BANNED)
    for (const key of MARKER_KEYS) expect(section({}).markers[key].summary).not.toMatch(BANNED)
  })

  it('names the evidence of a marker without printing a canary value', () => {
    const result = section({ proxy: [{ host: 'h.example.com', port: '443', canaries: ['model key'], where: { 'model key': 'header' }, requests: 1, pinned: false }] })
    expect(JSON.stringify(result)).not.toMatch(/sk-bench-canary/)
  })
})

describe('helpers', () => {
  it('phrase joins up to three and counts the rest', () => {
    expect(phrase(['a'])).toBe('a')
    expect(phrase(['a', 'b'])).toBe('a and b')
    expect(phrase(['a', 'b', 'c'])).toBe('a, b and c')
    expect(phrase(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
  })

  it('isLoopback accepts this machine only', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', '/run/x.sock', '0.0.0.0']) expect(isLoopback(host)).toBe(true)
    for (const host of ['198.51.100.7', '203.0.113.9', 'api.example.com', 'host.docker.internal']) expect(isLoopback(host)).toBe(false)
  })

  it('normalisePath hides random ids so a path compares equal to the baseline', () => {
    expect(normalisePath('/home/bench/.delorun/sessions/0a1b2c3d4e5f/chat-20261122.jsonl')).toBe('/home/bench/.delorun/sessions/*/chat-*.jsonl')
    expect(normalisePath('/opt/plugin/index.js')).toBe('/opt/plugin/index.js')
  })

  it('uses the default layout for the workspace', () => {
    expect(DEFAULT_LAYOUT.workspace).toBe('/home/bench/workspace')
  })
})
