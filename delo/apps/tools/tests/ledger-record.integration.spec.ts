import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest'
import { manifestErrors, MANIFEST_PATH, parseManifest, type PatchManifest, type PathRule } from '../src/fork-boundary.ts'
import { patchDigest } from '../src/ledger-digests.ts'
import { main, planRecord, SECURITY_CHANGED_STATUS } from '../src/ledger-record.ts'
import { diffHunks } from '../src/parity/composition/contributions.ts'
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
 * @param upstream - upstream files that replace or join the base's.
 * @returns the repository.
 */
function forkRepo(test: TestContext, fork: Record<string, string>, ledger: Partial<Omit<PatchManifest, 'upstream'>>, upstream: Record<string, string> = {}): Scratch {
  const repo = scratchRepo(test)
  const base = repo.commit({ [SOURCE]: 'a\n', [GATE]: 'gate\n', 'docs/a.md': 'a\n', ...upstream })
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
    repo.run(['add', '-A'])
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
    expect(printed).toContain('usage: ledger-record.ts [--check] | --non-model-visible-hunk <path>:<line> --reason "<one line>"')
    const repo = scratchRepo(test)
    repo.commit({ 'a.md': 'a\n' })
    expect(main([], repo.root)).toBe(2)
    expect(printed.at(-1)).toMatch(/^ledger-record: Error: ENOENT/u)
  })
})

describe('recording a non-model-visible hunk', () => {
  /** Upstream's gate. */
  const UPSTREAM_GATE = [
    'export function apply(ctx) {',
    '  const git = runner()',
    '  ctx.on("tools/pre-execute", (call, next) => next())',
    '  ctx.on("tools/result", (result, next) => next())',
    '}',
    'export const unrelated = 1',
    '',
  ].join('\n')
  /**
   * The fork's gate: hunk `-2 +2` changes line 2, hunk `-4 +3,0` deletes upstream's line 4 after line 3, and hunk
   * `-6 +5` changes line 5, outside the registering statement.
   */
  const FORK_GATE = [
    'export function apply(ctx) {',
    '  const git = confined(runner())',
    '  ctx.on("tools/pre-execute", (call, next) => next())',
    '}',
    'export const unrelated = 2',
    '',
  ].join('\n')
  const GIT_HUNK = diffHunks('@@ -2 +2 @@\n-  const git = runner()\n+  const git = confined(runner())\n')[0]?.sha256
  const DELETION_HUNK = diffHunks('@@ -4 +3,0 @@\n-  ctx.on("tools/result", (result, next) => next())\n')[0]?.sha256
  const NEW_GATE = 'packages/sandbox/sandbox/src/new-gate.ts'
  const reviewed = { path: GATE, class: 'security' as const, reason: 'moves a gate', sha256: patchDigest(FORK_GATE) }
  const REASON = 'binds git to the Session sandbox; no tool text changes'

  /**
   * A repository whose fork edits upstream's gate into {@link FORK_GATE}.
   * @param test - the running test.
   * @param ledger - the ledger's fields beside the pin.
   * @param fork - further fork edits.
   * @returns the repository.
   */
  const gateRepo = (test: TestContext, ledger: Partial<Omit<PatchManifest, 'upstream'>>, fork: Record<string, string> = {}): Scratch =>
    forkRepo(test, { [GATE]: FORK_GATE, ...fork }, ledger, { [GATE]: UPSTREAM_GATE })

  /**
   * Run the recorder for one hunk.
   * @param repo - the repository.
   * @param target - `<path>:<line>`.
   * @param reason - the record's reason.
   * @returns the exit status.
   */
  const record = (repo: Scratch, target: string, reason = REASON): number => main(['--non-model-visible-hunk', target, '--reason', reason], repo.root)

  it('records the digest of the hunk a line selects and exits with the security re-review status', (test) => {
    const feature = { path: SOURCE, class: 'delo-feature' as const, feature: 'f', reason: 'r' }
    const repo = gateRepo(test, { patches: [feature, reviewed] }, { [SOURCE]: 'b\n' })
    expect(record(repo, `${GATE}:2`)).toBe(SECURITY_CHANGED_STATUS)
    expect(record(repo, `${GATE}:3`)).toBe(SECURITY_CHANGED_STATUS)
    expect(ledgerOf(repo).patches).toEqual([feature, { ...reviewed, nonModelVisibleHunks: [{ sha256: GIT_HUNK, reason: REASON }, { sha256: DELETION_HUNK, reason: REASON }] }])
    expect(printed).toContain(`ledger-record: ${GATE}:2: recorded the non-model-visible hunk sha256 ${String(GIT_HUNK)}; the lead re-reviews the entry`)
    expect(printed).toContain(`ledger-record: updated ${MANIFEST_PATH}`)
    expect(main(['--check'], repo.root)).toBe(0)
  })

  it('drops a record whose hunk changed, keeps the records that still match, and asks for the lead\'s review', (test) => {
    const stale = { sha256: 'f'.repeat(64), reason: 'an older hunk' }
    const kept = { sha256: String(GIT_HUNK), reason: REASON }
    const repo = gateRepo(test, { patches: [{ ...reviewed, nonModelVisibleHunks: [kept, stale] }] })
    expect(main(['--check'], repo.root)).toBe(1)
    expect(printed).toContain(`ledger-record: ${GATE}: would drop the stale non-model-visible hunk record sha256 ${stale.sha256}; record the hunk that replaced it after review`)
    expect(main([], repo.root)).toBe(SECURITY_CHANGED_STATUS)
    expect(ledgerOf(repo).patches).toEqual([{ ...reviewed, nonModelVisibleHunks: [kept] }])
    const only = gateRepo(test, { patches: [{ ...reviewed, nonModelVisibleHunks: [stale] }] })
    expect(main([], only.root)).toBe(SECURITY_CHANGED_STATUS)
    expect(ledgerOf(only).patches).toEqual([reviewed])
    const twice = gateRepo(test, { patches: [{ ...reviewed, nonModelVisibleHunks: [kept, kept] }] })
    expect(main([], twice.root)).toBe(SECURITY_CHANGED_STATUS)
    expect(ledgerOf(twice).patches).toEqual([{ ...reviewed, nonModelVisibleHunks: [kept] }])
    const added = { path: NEW_GATE, class: 'security' as const, reason: 'a new gate', sha256: patchDigest(FORK_GATE), nonModelVisibleHunks: [kept] }
    const fresh = gateRepo(test, { patches: [reviewed, added] }, { [NEW_GATE]: FORK_GATE })
    expect(main([], fresh.root)).toBe(SECURITY_CHANGED_STATUS)
    expect(ledgerOf(fresh).patches).toEqual([reviewed, { path: NEW_GATE, class: 'security', reason: 'a new gate', sha256: patchDigest(FORK_GATE) }])
  })

  it('re-records a stale digest of the entry in the same write, so the lead\'s verdict covers the record', (test) => {
    const repo = gateRepo(test, { patches: [{ ...reviewed, sha256: patchDigest(UPSTREAM_GATE) }] })
    expect(record(repo, `${GATE}:2`)).toBe(SECURITY_CHANGED_STATUS)
    expect(ledgerOf(repo).patches[0]?.sha256).toBe(patchDigest(FORK_GATE))
    expect(printed).toContain(`ledger-record: ${GATE}: security file changed; re-recorded sha256 ${patchDigest(UPSTREAM_GATE)} → ${patchDigest(FORK_GATE)}; the lead re-reviews it`)
  })

  it('refuses a path whose entry is not of class security, and a path with no entry', (test) => {
    const repo = gateRepo(test, { patches: [{ path: SOURCE, class: 'delo-feature', feature: 'f', reason: 'r' }] }, { [SOURCE]: FORK_GATE })
    const before = readFileSync(join(repo.root, MANIFEST_PATH), 'utf8')
    expect(record(repo, `${SOURCE}:2`)).toBe(2)
    expect(printed).toContain(`ledger-record: ${SOURCE}:2: ${SOURCE} has no security entry; only a security entry records non-model-visible hunks`)
    expect(record(repo, `${GATE}:2`)).toBe(2)
    expect(printed).toContain(`ledger-record: ${GATE}:2: ${GATE} has no security entry; only a security entry records non-model-visible hunks`)
    expect(readFileSync(join(repo.root, MANIFEST_PATH), 'utf8')).toBe(before)
  })

  it('refuses a line no hunk is read at, and a file the pinned commit lacks', (test) => {
    const repo = gateRepo(test, { patches: [reviewed, { path: NEW_GATE, class: 'security', reason: 'adds a gate', sha256: patchDigest(FORK_GATE) }] }, { [NEW_GATE]: FORK_GATE })
    for (const line of [1, 40]) {
      expect(record(repo, `${GATE}:${String(line)}`)).toBe(2)
      expect(printed).toContain(`ledger-record: ${GATE}:${String(line)}: no hunk of the edit against the pinned commit adds this line or deletes after it`)
    }
    expect(record(repo, `${NEW_GATE}:2`)).toBe(2)
    expect(printed).toContain(`ledger-record: ${NEW_GATE}:2: the pinned commit lacks ${NEW_GATE}, so every contribution in it counts and no hunk can be recorded`)
    expect(ledgerOf(repo).patches.some(patch => patch.nonModelVisibleHunks !== undefined)).toBe(false)
  })

  it('refuses a hunk that touches no statement that registers a model-visible contribution', (test) => {
    const repo = gateRepo(test, { patches: [reviewed] })
    expect(record(repo, `${GATE}:5`)).toBe(2)
    expect(printed).toContain(`ledger-record: ${GATE}:5: the hunk touches no top-level statement that registers a model-visible contribution, so parity-switches does not count it`)
  })

  it('refuses a second record of a hunk whose digest has a record for every hunk with it', (test) => {
    const repo = gateRepo(test, { patches: [reviewed] })
    expect(record(repo, `${GATE}:2`)).toBe(SECURITY_CHANGED_STATUS)
    expect(record(repo, `${GATE}:2`)).toBe(2)
    expect(printed).toContain(`ledger-record: ${GATE}:2: every hunk with this digest (read at line 2) already has its record`)
    expect(ledgerOf(repo).patches[0]?.nonModelVisibleHunks).toHaveLength(1)
  })

  it('refuses an empty, blank or multi-line reason', (test) => {
    const repo = gateRepo(test, { patches: [reviewed] })
    for (const reason of ['', '   ', 'binds git\nto the sandbox']) {
      expect(record(repo, `${GATE}:2`, reason), JSON.stringify(reason)).toBe(2)
      expect(printed).toContain(`ledger-record: ${GATE}:2: the reason must be one line that holds a non-space character`)
    }
    expect(ledgerOf(repo).patches).toEqual([reviewed])
  })

  it('exits 2 for a malformed line, a line without a reason, a reason without a line, and a line with --check', () => {
    for (const argv of [
      ['--non-model-visible-hunk', GATE, '--reason', 'r'],
      ['--non-model-visible-hunk', `${GATE}:0`, '--reason', 'r'],
      ['--non-model-visible-hunk', `${GATE}:3`],
      ['--reason', 'r'],
      ['--check', '--non-model-visible-hunk', `${GATE}:3`, '--reason', 'r'],
    ]) {
      expect(main(argv, process.cwd()), argv.join(' ')).toBe(2)
    }
    expect(printed.filter(line => line.startsWith('usage: '))).toHaveLength(5)
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
