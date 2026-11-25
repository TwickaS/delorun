import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { baselinePath, loadBaseline, saveBaseline } from '../../../src/compat-bench/privacy/baseline.ts'
import { summarise } from '../../../src/compat-bench/privacy/events.ts'
import { signatureOf } from '../../../src/compat-bench/privacy/requests.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const folder = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'bench-baseline-')); temporary.push(dir); return dir }

describe('baseline', () => {
  it('round-trips a run\'s facts', async () => {
    const dir = await folder()
    const facts = {
      hooks: summarise([{ t: 'connect', pid: 1, host: 'mock.local', port: '8000', proto: 'tcp' }, { t: 'env', pid: 1, name: 'HOME' }, { t: 'listen', pid: 1, host: '127.0.0.1', port: '18750' }]),
      helper: { hosts: [], net: [{ t: 'listen' as const, host: '0.0.0.0', port: '8080' }] },
      fileChanges: [{ kind: 'A' as const, path: '/x' }],
      leftCanaries: [{ canary: 'chat word', path: '/y' }],
      request: signatureOf('{"model":"m","messages":[]}', 'w'),
    }
    const path = await saveBaseline(dir, 'delorun', facts, '2026-11-22T10:00:00.000Z')
    expect(path).toBe(baselinePath(dir, 'delorun'))
    const loaded = await loadBaseline(dir, 'delorun')
    expect(loaded).toEqual(facts)
  })

  it('is per host kind, and missing or foreign files read as no baseline', async () => {
    const dir = await folder()
    expect(await loadBaseline(dir, 'stock')).toBeUndefined()
    await writeFile(baselinePath(dir, 'stock'), '{"schema":"other"}')
    expect(await loadBaseline(dir, 'stock')).toBeUndefined()
    await writeFile(baselinePath(dir, 'stock'), 'not json')
    expect(await loadBaseline(dir, 'stock')).toBeUndefined()
  })
})
