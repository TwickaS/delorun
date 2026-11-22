import { describe, expect, it } from 'vitest'
import { assemble, mergeHelper } from '../../../src/compat-bench/privacy/observed.ts'
import type { RunFacts } from '../../../src/compat-bench/privacy/observed.ts'
import { summarise } from '../../../src/compat-bench/privacy/events.ts'
import { signatureOf } from '../../../src/compat-bench/privacy/requests.ts'
import type { HookEvent } from '../../../src/compat-bench/privacy/types.ts'

const hooks = (events: HookEvent[]) => summarise(events)
const facts = (partial: Partial<RunFacts> = {}): RunFacts => ({ hooks: hooks([]), fileChanges: [], leftCanaries: [], ...partial })

describe('assembling observations', () => {
  it('merges the helper\'s connects, listens and programs, naming a connect once', () => {
    const merged = mergeHelper(
      hooks([{ t: 'connect', pid: 1, host: 'api.example.com', port: '443', proto: 'tcp' }, { t: 'connected', pid: 1, host: 'api.example.com', port: '443', address: '203.0.113.9' }]),
      { hosts: [], net: [{ t: 'connect', host: '203.0.113.9', port: '443' }, { t: 'connect', host: '203.0.113.20', port: '22', name: 'git.example.com' }, { t: 'listen', host: '0.0.0.0', port: '4000' }, { t: 'exec', cmd: 'git status' }] },
    )
    expect([...merged.connects.values()]).toEqual([{ host: '203.0.113.9', port: '443', name: 'api.example.com' }, { host: '203.0.113.20', port: '22', name: 'git.example.com' }])
    expect([...merged.listens.keys()]).toEqual(['0.0.0.0:4000'])
    expect([...merged.execs]).toEqual(['git status'])
  })

  it('leaves the hooks alone when no helper ran, and says the contents were not checked', () => {
    const observed = assemble(facts({ hooks: hooks([{ t: 'connect', pid: 1, host: '203.0.113.9', port: '443', proto: 'tcp' }]) }))
    expect(observed.connects).toEqual([{ host: '203.0.113.9', port: '443' }])
    expect(observed.contentsChecked).toBe(false)
  })

  it('subtracts the baseline from every list and keeps only proxy hosts with a canary or a pinned handshake', () => {
    const baseline = facts({
      hooks: hooks([{ t: 'connect', pid: 1, host: '203.0.113.50', port: '443', proto: 'tcp' }]),
      helper: { hosts: [{ host: 'update.delorun.example', port: '443', canaries: [], where: {}, requests: 1, pinned: true }], net: [] },
      fileChanges: [{ kind: 'A', path: '/home/bench/.delorun/sessions/0a1b2c3d4e5f/chat.jsonl' }],
      leftCanaries: [{ canary: 'chat word', path: '/home/bench/.delorun/sessions/0a1b2c3d4e5f/chat.jsonl' }],
      request: signatureOf(JSON.stringify({ model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }] }), 'w'),
    })
    const run = facts({
      hooks: hooks([{ t: 'connect', pid: 1, host: '203.0.113.50', port: '443', proto: 'tcp' }, { t: 'connect', pid: 1, host: '203.0.113.9', port: '443', proto: 'tcp' }]),
      helper: { hosts: [
        { host: 'update.delorun.example', port: '443', canaries: [], where: {}, requests: 1, pinned: true },
        { host: 'plain.example.com', port: '443', canaries: [], where: {}, requests: 3, pinned: false },
        { host: 'api.example.com', port: '443', canaries: ['chat word'], where: { 'chat word': 'body' }, requests: 1, pinned: false },
      ], net: [] },
      fileChanges: [{ kind: 'A', path: '/home/bench/.delorun/sessions/ffeeddccbbaa/chat.jsonl' }, { kind: 'A', path: '/home/bench/.delorun/plugins/p/index.js' }],
      leftCanaries: [{ canary: 'chat word', path: '/home/bench/.delorun/sessions/ffeeddccbbaa/chat.jsonl' }, { canary: 'chat word', path: '/home/bench/.cache/p/log.txt' }],
      request: signatureOf(JSON.stringify({ model: 'm', system: 's plus more', messages: [{ role: 'user', content: 'hi' }] }), 'w'),
    })
    const observed = assemble(run, baseline)
    expect(observed.connects).toEqual([{ host: '203.0.113.9', port: '443' }])
    expect(observed.proxy.map(host => host.host)).toEqual(['api.example.com'])
    expect(observed.fileChanges.map(change => change.path)).toEqual(['/home/bench/.delorun/plugins/p/index.js'])
    expect(observed.leftCanaries).toEqual([{ canary: 'chat word', path: '/home/bench/.cache/p/log.txt' }])
    expect(observed.requestChanges).toEqual(['the system prompt added 10 characters (" plus more")'])
    expect(observed.contentsChecked).toBe(true)
  })

  it('treats a datagram to another machine as contents not checked', () => {
    const observed = assemble(facts({ hooks: hooks([{ t: 'connect', pid: 1, host: '192.0.2.1', port: '9', proto: 'udp' }]), helper: { hosts: [], net: [] } }))
    expect(observed.proxy).toEqual([{ host: '192.0.2.1', port: '9', canaries: [], where: {}, requests: 0, pinned: true }])
  })
})
