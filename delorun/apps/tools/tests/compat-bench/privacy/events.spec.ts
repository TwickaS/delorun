import { describe, expect, it } from 'vitest'
import { parseEvents, subtractBaseline, summarise } from '../../../src/compat-bench/privacy/events.ts'
import type { HookEvent } from '../../../src/compat-bench/privacy/types.ts'

const lines = (events: object[]): string => events.map(event => JSON.stringify(event)).join('\n')

describe('hook events', () => {
  it('parses lines and skips a torn one', () => {
    const events = parseEvents(`${lines([{ t: 'start', pid: 1, cmd: 'x' }, { t: 'env', pid: 1, name: 'HOME' }])}\n{"t":"conn`)
    expect(events.map(event => event.t)).toEqual(['start', 'env'])
  })

  it('reduces events to sets, naming a host by the name the code gave when it resolved to an address', () => {
    const events: HookEvent[] = [
      { t: 'connect', pid: 1, host: 'api.example.com', port: '443', proto: 'tcp' },
      { t: 'connected', pid: 1, host: 'api.example.com', port: '443', address: '203.0.113.9' },
      { t: 'connect', pid: 1, host: '127.0.0.1', port: '18750', proto: 'tcp' },
      { t: 'connected', pid: 1, host: '127.0.0.1', port: '18750', address: '127.0.0.1' },
      { t: 'connect', pid: 1, host: '192.0.2.1', port: '9', proto: 'udp' },
      { t: 'listen', pid: 1, host: '127.0.0.1', port: '40000' },
      { t: 'exec', pid: 1, file: 'git', args: 'status' },
      { t: 'exec', pid: 1, file: 'node', args: '' },
      { t: 'env', pid: 1, name: 'HOME' },
      { t: 'env', pid: 1, name: 'HOME' },
      { t: 'env', pid: 1, name: '*' },
      { t: 'open', pid: 1, label: '~/.ssh/', path: '/home/bench/.ssh/id_ed25519' },
    ]
    const summary = summarise(events)
    expect([...summary.connects.values()]).toEqual([
      { host: '203.0.113.9', port: '443', name: 'api.example.com' },
      { host: '127.0.0.1', port: '18750' },
      { host: '192.0.2.1', port: '9', udp: true },
    ])
    expect([...summary.listens.values()]).toEqual([{ host: '127.0.0.1', port: '40000' }])
    expect([...summary.execs]).toEqual(['git status', 'node'])
    expect([...summary.envNames]).toEqual(['HOME'])
    expect(summary.envEnumerated).toBe(true)
    expect([...summary.opens.values()]).toEqual([{ label: '~/.ssh/', path: '/home/bench/.ssh/id_ed25519' }])
  })

  it('subtracts what the baseline did: connects by address or name, programs by file, environment names, opens', () => {
    const baseline = summarise([
      { t: 'connect', pid: 1, host: 'mock.local', port: '8000', proto: 'tcp' },
      { t: 'connected', pid: 1, host: 'mock.local', port: '8000', address: '198.51.100.5' },
      { t: 'listen', pid: 1, host: '127.0.0.1', port: '18750' },
      { t: 'listen', pid: 1, host: '127.0.0.1', port: '40001' },
      { t: 'exec', pid: 1, file: '/usr/bin/node', args: '/tmp/a1/worker.js' },
      { t: 'env', pid: 1, name: 'HOME' },
      { t: 'env', pid: 1, name: '*' },
      { t: 'open', pid: 1, label: 'Delorun key store', path: '/home/bench/.delorun/credentials.yaml' },
    ] as HookEvent[])
    const run = summarise([
      { t: 'connect', pid: 2, host: '198.51.100.5', port: '8000', proto: 'tcp' },
      { t: 'connect', pid: 2, host: '203.0.113.9', port: '443', proto: 'tcp' },
      { t: 'listen', pid: 2, host: '127.0.0.1', port: '18750' },
      { t: 'listen', pid: 2, host: '127.0.0.1', port: '40555' },
      { t: 'listen', pid: 2, host: '127.0.0.1', port: '40556' },
      { t: 'listen', pid: 2, host: '0.0.0.0', port: '4000' },
      { t: 'exec', pid: 2, file: '/usr/bin/node', args: '/tmp/b2/worker.js' },
      { t: 'exec', pid: 2, file: '/usr/bin/git', args: 'status' },
      { t: 'env', pid: 2, name: 'HOME' },
      { t: 'env', pid: 2, name: 'GITHUB_TOKEN' },
      { t: 'env', pid: 2, name: '*' },
      { t: 'open', pid: 2, label: 'Delorun key store', path: '/home/bench/.delorun/credentials.yaml' },
      { t: 'open', pid: 2, label: '~/.ssh/', path: '/home/bench/.ssh/id_ed25519' },
    ] as HookEvent[])
    const reduced = subtractBaseline(run, baseline)
    expect([...reduced.connects.keys()]).toEqual(['203.0.113.9:443'])
    // One system-chosen port at 127.0.0.1 is the baseline's pattern; the second one and the 0.0.0.0 listen are new.
    expect([...reduced.listens.keys()]).toEqual(['127.0.0.1:40556', '0.0.0.0:4000'])
    expect([...reduced.execs]).toEqual(['/usr/bin/git status'])
    expect([...reduced.envNames]).toEqual(['GITHUB_TOKEN'])
    expect(reduced.envEnumerated).toBe(false)
    expect([...reduced.opens.keys()]).toEqual(['/home/bench/.ssh/id_ed25519'])
  })
})
