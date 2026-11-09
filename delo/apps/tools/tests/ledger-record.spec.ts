import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest'
import { manifestErrors, MANIFEST_PATH, parseManifest, type PatchManifest, type PathRule } from '../src/fork-boundary.ts'
import { patchDigest } from '../src/ledger-digests.ts'
import { main, planRecord, SECURITY_CHANGED_STATUS } from '../src/ledger-record.ts'
import { scratchRepo, type Scratch } from './gates/support.ts'

const UPSTREAM = { repository: 'https://example.invalid/upstream.git', ref: 'v1' }
const SOURCE = 'packages/core/session/src/index.ts'
const GATE = 'packages/sandbox/sandbox/src/gate.ts'
const TESTS_RULE: PathRule = { pattern: '**/tests/**', kind: 'tests', reason: 'specs of edited packages' }

/** The lines the command printed, standard output and standard error together. */
let printed: string[] = []

beforeEach(() => {
  printed = []
  const record = (...parts: unknown[]): void => { printed.push(parts.map(String).join(' ')) }
  vi.spyOn(console, 'log').mockImplementation(record)
  vi.spyOn(console, 'error').mockImplementation(record)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * A repository whose first commit is the upstream base and whose second commit holds the fork's edits and its ledger.
 * @param test - the running test.
 * @param fork - the fork's edits.
 * @param ledger - the ledger's fields beside the pin.
 * @returns the repository.
 */
function forkRepo(test: TestContext, fork: Record<string, string>, ledger: Partial<Omit<PatchManifest, 'upstream'>>): Scratch {
  const repo = scratchRepo(test)
  const base = repo.commit({ [SOURCE]: 'a\n', [GATE]: 'gate\n', 'docs/a.md': 'a\n' })
  const manifest = { upstream: { ...UPSTREAM, commit: base }, forkOwned: ['delo/'], rules: [], patches: [], retired: [], ...ledger }
  repo.commit({ ...fork, [MANIFEST_PATH]: `${JSON.stringify(manifest, null, 2)}\n` })
  return repo
}

/**
 * The fork's ledger as the file on disk holds it.
 * @param repo - the repository.
 * @returns the parsed ledger.
 */
function ledgerOf(repo: Scratch): PatchManifest {
  return parseManifest(readFileSync(join(repo.root, MANIFEST_PATH), 'utf8'))
}

describe('the ledger writer', () => {
  it('leaves a ledger in step with the tree alone and exits 0', (test) => {
    const repo = forkRepo(test, { [SOURCE]: 'b\n' }, { patches: [{ path: SOURCE, class: 'delo-feature', feature: 'f', reason: 'r' }] })
    const before = readFileSync(join(repo.root, MANIFEST_PATH), 'utf8')
    expect(main(['--check'], repo.root)).toBe(0)
    expect(main([], repo.root)).toBe(0)
    expect(readFileSync(join(repo.root, MANIFEST_PATH), 'utf8')).toBe(before)
    expect(printed).toContain(`ledger-record: ${MANIFEST_PATH} is in step with the tree`)
  })

  it('adds a TODO stub for a differing path nothing covers, which the entry rules refuse until the lead fills it', (test) => {
    const repo = forkRepo(test, {}, { rules: [TESTS_RULE] })
    repo.write({
      'packages/core/session/src/zz-probe.ts': 'probe\n',
      'packages/core/session/tests/zz-probe.spec.ts': 'probe\n',
      'delo/own.ts': 'own\n',
      'docs/a.md': 'b\n',
    })
    expect(main(['--check'], repo.root)).toBe(1)
    expect(ledgerOf(repo).patches).toEqual([])
    expect(printed).toContain('ledger-record: packages/core/session/src/zz-probe.ts: would add a stub entry; the lead writes its class, feature and reason')
    expect(main([], repo.root)).toBe(0)
    const ledger = ledgerOf(repo)
    expect(ledger.patches).toEqual([
      { path: 'docs/a.md', class: 'delo-feature', feature: 'TODO', reason: 'TODO' },
      { path: 'packages/core/session/src/zz-probe.ts', class: 'delo-feature', feature: 'TODO', reason: 'TODO' },
    ])
    expect(manifestErrors(ledger)).toEqual([
      'docs/a.md: the reason is TODO; the lead writes the reason',
      'docs/a.md: the feature is TODO; the lead names the feature this entry serves',
      'packages/core/session/src/zz-probe.ts: the reason is TODO; the lead writes the reason',
      'packages/core/session/src/zz-probe.ts: the feature is TODO; the lead names the feature this entry serves',
    ])
  })

  it('removes an entry whose path no longer differs', (test) => {
    const repo = forkRepo(test, {}, { patches: [{ path: SOURCE, class: 'delo-feature', feature: 'f', reason: 'r' }] })
    expect(main(['--check'], repo.root)).toBe(1)
    expect(main([], repo.root)).toBe(0)
    expect(ledgerOf(repo).patches).toEqual([])
    expect(printed).toContain(`ledger-record: ${SOURCE}: removed the entry, because the path no longer differs from upstream`)
  })

  it('re-records a changed security file, prints it, and exits 3 so the caller cannot miss the re-review', (test) => {
    const repo = forkRepo(test, { [GATE]: 'gate, edited\n' }, {
      patches: [{ path: GATE, class: 'security', reason: 'moves a gate', sha256: patchDigest('gate, reviewed\n') }],
    })
    expect(main(['--check'], repo.root)).toBe(1)
    expect(ledgerOf(repo).patches[0]?.sha256).toBe(patchDigest('gate, reviewed\n'))
    expect(main([], repo.root)).toBe(SECURITY_CHANGED_STATUS)
    expect(ledgerOf(repo).patches[0]?.sha256).toBe(patchDigest('gate, edited\n'))
    expect(printed).toContain(
      `ledger-record: ${GATE}: security file changed; re-recorded sha256 ${patchDigest('gate, reviewed\n')} → ${patchDigest('gate, edited\n')}; the lead re-reviews it`,
    )
    expect(main([], repo.root)).toBe(0)
  })

  it('records the first digest of a security entry that has none', (test) => {
    const repo = forkRepo(test, { [GATE]: 'gate, edited\n' }, { patches: [{ path: GATE, class: 'security', reason: 'moves a gate' }] })
    expect(main([], repo.root)).toBe(SECURITY_CHANGED_STATUS)
    expect(printed).toContain(`ledger-record: ${GATE}: security file changed; re-recorded sha256 none → ${patchDigest('gate, edited\n')}; the lead re-reviews it`)
  })

  it('reports a security entry whose file is gone and exits 1 without changing it', (test) => {
    const repo = forkRepo(test, {}, { patches: [{ path: GATE, class: 'security', reason: 'moves a gate', sha256: patchDigest('gate\n') }] })
    rmSync(join(repo.root, GATE))
    expect(main(['--check'], repo.root)).toBe(1)
    expect(main([], repo.root)).toBe(1)
    expect(ledgerOf(repo).patches[0]?.sha256).toBe(patchDigest('gate\n'))
    expect(printed).toContain(`ledger-record: ${GATE}: security entry holds no file to digest; restore the file or remove the entry`)
  })

  it('exits 2 for an unknown option and for a repository without a ledger', (test) => {
    expect(main(['--write'], process.cwd())).toBe(2)
    expect(printed).toContain('usage: ledger-record.ts [--check]')
    const repo = scratchRepo(test)
    repo.commit({ 'a.md': 'a\n' })
    expect(main([], repo.root)).toBe(2)
    expect(printed.at(-1)).toMatch(/^ledger-record: Error: ENOENT/u)
  })
})

describe('planning a run', () => {
  const manifest: PatchManifest = {
    upstream: { ...UPSTREAM, commit: 'a'.repeat(40) },
    forkOwned: ['delo/'],
    rules: [TESTS_RULE],
    patches: [],
    retired: [{ path: 'docs/absorbed.md', reason: 'absorbed', upstreamCommit: 'a'.repeat(40), hunks: 1 }],
  }

  it('adds no stub for a retired path that differs again, a fork-owned path or a path a rule covers', () => {
    const plan = planRecord(manifest, [
      { path: 'docs/absorbed.md', status: 'modified' },
      { path: 'delo/own.ts', status: 'added' },
      { path: 'packages/a/b/tests/a.spec.ts', status: 'added' },
    ], new Map())
    expect(plan.added).toEqual([])
    expect(plan.manifest).toEqual(manifest)
  })
})
