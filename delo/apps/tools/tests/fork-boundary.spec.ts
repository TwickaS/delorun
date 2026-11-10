import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { checkRepository, formatCoverage, formatDivergence } from '../src/check-fork-boundary.ts'
import {
  forkBoundaryErrors,
  isForkOwned,
  isUpstreamSource,
  manifestErrors,
  parseManifest,
  ruleCoverage,
  type PatchManifest,
  type PathRule,
} from '../src/fork-boundary.ts'
import { patchDigest } from '../src/ledger-digests.ts'

const UPSTREAM = { repository: 'https://example.invalid/upstream.git', ref: 'v1' }
const NOTE_RULE = '.agents/notes/**/*-delo-*'

/**
 * A temporary repository whose history stays inside it: its own identity, and no global or system git configuration.
 * @param test - the running test, whose teardown removes the repository.
 * @returns helpers that run git, commit files, and write uncommitted files.
 */
function fixture(test: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'delo-ledger-'))
  test.onTestFinished(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Ledger test',
    GIT_AUTHOR_EMAIL: 'ledger@example.invalid',
    GIT_COMMITTER_NAME: 'Ledger test',
    GIT_COMMITTER_EMAIL: 'ledger@example.invalid',
  }
  const run = (args: readonly string[]): string => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  run(['init', '-q', '-b', 'main'])
  /**
   * Write files and commit everything in the working tree.
   * @param files - repository-relative paths and their text.
   * @returns the new commit id.
   */
  function commit(files: Record<string, string>): string {
    write(files)
    run(['add', '-A'])
    run(['commit', '-q', '--allow-empty', '-m', 'fixture'])
    return run(['rev-parse', 'HEAD'])
  }
  /**
   * Write files without committing them.
   * @param files - repository-relative paths and their text.
   */
  function write(files: Record<string, string>): void {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
  }
  return { root, run, commit, write }
}

/**
 * The ledger text for a repository, pinned to one commit.
 * @param commit - the pinned upstream commit.
 * @param patches - listed patches.
 * @param retired - retired entries.
 * @param forkOwned - fork-owned entries.
 * @param rules - path rules.
 * @returns the JSON text of the ledger.
 */
function ledgerText(
  commit: string,
  patches: readonly object[] = [],
  retired: readonly object[] = [],
  forkOwned: readonly string[] = ['delo/', '.agents/skills/delo-*/', NOTE_RULE],
  rules: readonly PathRule[] = [],
): string {
  return JSON.stringify({ upstream: { ...UPSTREAM, commit }, forkOwned, rules, patches, retired }, null, 2)
}

/**
 * A feature entry for a path.
 * @param path - the listed path.
 * @returns the entry, without a digest.
 */
function feature(path: string): object {
  return { path, class: 'delo-feature', feature: 'a-feature', reason: 'edit' }
}

/**
 * A security entry for a path.
 * @param path - the listed path.
 * @param content - the file's content, whose digest the entry records; omitted for an entry that records none.
 * @returns the entry.
 */
function security(path: string, content?: string): object {
  return { path, class: 'security', reason: 'moves a gate; lead verdict: keep', ...content === undefined ? {} : { sha256: patchDigest(content) } }
}

/** A rule for spec files under any `tests/` directory. */
const TESTS_RULE: PathRule = { pattern: '**/tests/**', kind: 'tests', reason: 'specs of edited packages' }

/**
 * A ledger value with the given entries and rules, for the checks that read no repository.
 * @param patches - listed patches.
 * @param rules - path rules.
 * @returns the ledger.
 */
function manifest(patches: PatchManifest['patches'], rules: readonly PathRule[] = []): PatchManifest {
  return { upstream: { ...UPSTREAM, commit: 'a'.repeat(40) }, forkOwned: ['delo/'], rules: [...rules], patches, retired: [] }
}

describe('divergence ledger checks', () => {
  it('fails a ledger entry without a class', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    repo.commit({
      'delo/upstream-patches.json': JSON.stringify({
        upstream: { ...UPSTREAM, commit: base },
        forkOwned: ['delo/'],
        patches: [{ path: 'upstream.ts', reason: 'edit' }],
        retired: [],
      }),
    })
    expect(checkRepository(repo.root).errors.join('\n')).toMatch(/^delo\/upstream-patches\.json: patches\.0\.class: /)
  })

  it('fails a ledger whose upstream commit is not an ancestor of HEAD', (test) => {
    const repo = fixture(test)
    repo.commit({ 'upstream.ts': 'a\n' })
    repo.run(['checkout', '-q', '-b', 'side'])
    const side = repo.commit({})
    repo.run(['checkout', '-q', 'main'])
    repo.commit({ 'delo/upstream-patches.json': ledgerText(side) })
    expect(checkRepository(repo.root).errors).toEqual([
      'HEAD does not contain upstream v1; record the merged upstream commit in delo/upstream-patches.json',
    ])
  })

  it('fails an unlisted upstream change and passes a fork-owned one', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n', 'delo/own.ts': 'a\n' })
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base) })
    repo.write({ 'upstream.ts': 'b\n', 'delo/own.ts': 'b\n' })
    expect(checkRepository(repo.root).errors).toEqual([
      'upstream.ts: modified upstream file is not listed in delo/upstream-patches.json and no path rule covers it',
    ])
  })

  it('fails a stale entry whose path no longer differs from upstream', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [feature('upstream.ts')]) })
    expect(checkRepository(repo.root).errors).toEqual([
      'upstream.ts: listed patch no longer differs from upstream; remove the entry',
    ])
  })

  it('fails a security entry whose checksum the ledger does not record, and passes it once recorded', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    repo.commit({ 'upstream.ts': 'b\n', 'delo/upstream-patches.json': ledgerText(base, [security('upstream.ts')]) })
    expect(checkRepository(repo.root).errors).toEqual([
      'upstream.ts: a security entry records the sha256 of its file; run `ledger-record.ts` after the lead\'s review',
    ])
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [security('upstream.ts', 'b\n')]) })
    expect(checkRepository(repo.root).errors).toEqual([])
  })

  it('fails a security digest that no longer matches the file at HEAD, and passes one that does', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    repo.commit({ 'upstream.ts': 'b\n', 'delo/upstream-patches.json': ledgerText(base, [security('upstream.ts', 'a\n')]) })
    expect(checkRepository(repo.root).errors).toEqual([
      `upstream.ts: recorded sha256 ${patchDigest('a\n')}, but the file is ${patchDigest('b\n')}`,
    ])
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [security('upstream.ts', 'b\n')]) })
    expect(checkRepository(repo.root).errors).toEqual([])
  })

  it('passes a feature entry without a digest, and fails one that records a digest', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    repo.commit({ 'upstream.ts': 'b\n', 'delo/upstream-patches.json': ledgerText(base, [feature('upstream.ts')]) })
    expect(checkRepository(repo.root).errors).toEqual([])
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [{ ...feature('upstream.ts'), sha256: patchDigest('b\n') }]) })
    expect(checkRepository(repo.root).errors).toEqual([
      'upstream.ts: only a security entry records a sha256; remove it from this delo-feature entry',
    ])
  })

  it('treats a Delo agent note as fork-owned by its -delo- name, and an upstream note as unlisted', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base) })
    repo.write({
      '.agents/notes/implemented/architecture/2026-11-06-delo-ledger.md': '# Ledger\n',
      '.agents/notes/implemented/architecture/2026-11-06-delo-ledger.zh.md': '# 台账\n',
      '.agents/notes/implemented/architecture/2026-11-06-delo-ledger.i18n.yaml': 'source: x\n',
      '.agents/notes/implemented/architecture/2026-11-06-upstream-ledger.md': '# Upstream\n',
    })
    expect(checkRepository(repo.root).errors).toEqual([
      '.agents/notes/implemented/architecture/2026-11-06-upstream-ledger.md: added upstream file is not listed in delo/upstream-patches.json and no path rule covers it',
    ])
  })

  it('credits a retired entry: its entry and hunks leave the divergence count', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'one\ntwo\nthree\n' })
    repo.run(['checkout', '-q', '-b', 'upstream'])
    const absorbed = repo.commit({ 'upstream.ts': 'ONE\ntwo\nTHREE\n' })
    repo.run(['checkout', '-q', 'main'])
    repo.write({ 'upstream.ts': 'ONE\ntwo\nTHREE\n' })
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [feature('upstream.ts')]) })
    const before = checkRepository(repo.root)
    expect(before.errors).toEqual([])
    expect(before.divergence).toEqual({ entries: 1, hunks: 2, ruled: { paths: 0, hunks: 0 }, retired: [] })

    repo.run(['merge', '-q', '--no-edit', 'upstream'])
    const retired = { path: 'upstream.ts', reason: 'absorbed', upstreamCommit: absorbed, hunks: 2 }
    repo.commit({ 'delo/upstream-patches.json': ledgerText(absorbed, [], [retired]) })
    const after = checkRepository(repo.root)
    expect(after.errors).toEqual([])
    expect(after.divergence).toEqual({ entries: 0, hunks: 0, ruled: { paths: 0, hunks: 0 }, retired: [retired] })
    expect(formatDivergence('v1', after.divergence ?? { entries: 0, hunks: 0, ruled: { paths: 0, hunks: 0 }, retired: [] })).toEqual([
      'fork divergence against v1: 0 entries, 0 hunks',
      'covered by path rules: 0 paths, 0 hunks',
      'retired as absorbed upstream (credited): 1 entry, 2 hunks',
      `  upstream.ts: absorbed at ${absorbed}, 2 hunks`,
    ])
  })

  it('fails a retired entry whose path still differs from upstream', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    repo.write({ 'upstream.ts': 'b\n' })
    repo.commit({
      'delo/upstream-patches.json': ledgerText(base, [], [{ path: 'upstream.ts', reason: 'absorbed', upstreamCommit: base, hunks: 1 }]),
    })
    expect(checkRepository(repo.root).errors).toEqual([
      'upstream.ts: retired as absorbed upstream but still differs from it; list it under patches',
    ])
  })
})

describe('fork-owned entries', () => {
  const forkOwned = ['delo/', '.agents/skills/delo-*/', NOTE_RULE]

  it.each([
    ['delo/apps/tools/src/check-fork-boundary.ts', true],
    ['delo-docs/readme.md', false],
    ['.agents/skills/delo-dev-workflow/SKILL.md', true],
    ['.agents/skills/dsh-pre-push-checks/SKILL.md', false],
    ['packages/core/agent/src/index.ts', false],
  ])('covers %s: %s', (path, owned) => {
    expect(isForkOwned(path, forkOwned)).toBe(owned)
  })

  it.each([
    ['.agents/notes/implemented/architecture/2026-11-06-delo-ledger.md', true],
    ['.agents/notes/implemented/architecture/2026-11-06-delo-ledger.zh.md', true],
    ['.agents/notes/implemented/architecture/2026-11-06-delo-ledger.i18n.yaml', true],
    ['.agents/notes/2026-11-06-delo-root.md', true],
    ['.agents/notes/implemented/architecture/2026-11-06-upstream-ledger.md', false],
  ])('owns the Delo agent note %s: %s', (path, owned) => {
    expect(isForkOwned(path, forkOwned)).toBe(owned)
  })

  it('reports a patch that is also fork-owned or lists a path twice', () => {
    const errors = manifestErrors(manifest([
      { path: 'delo/x.md', class: 'delo-feature', feature: 'f', reason: 'r' },
      { path: 'a', class: 'generic-fix', feature: 'f', reason: ' ' },
      { path: 'a', class: 'generic-fix', feature: 'f', reason: 'r' },
    ]))
    expect(errors).toEqual([
      'a: listed more than once',
      'a: a patch needs a reason',
      'delo/x.md: fork-owned paths are not ledger entries; remove the entry',
    ])
  })

  it('refuses a compiled twin of a TypeScript source inside a fork-owned tree', () => {
    const files = new Set(['delo/apps/x/src/a.ts', 'delo/apps/x/src/a.js'])
    expect(forkBoundaryErrors(manifest([]),
      [{ path: 'delo/apps/x/src/a.js', status: 'added' }], files)).toEqual([
      'delo/apps/x/src/a.js: compiled output beside delo/apps/x/src/a.ts; delete it and keep build output out of source trees',
    ])
  })
})

describe('ledger parsing', () => {
  const commit = 'a'.repeat(40)
  const base = { upstream: { ...UPSTREAM, commit }, forkOwned: ['delo/'], patches: [], retired: [] }

  it('accepts the schema, including a $schema key and a retired entry', () => {
    const retired = { path: 'a.ts', reason: 'absorbed', upstreamCommit: commit, hunks: 3 }
    expect(parseManifest(JSON.stringify({ $schema: './upstream-patches.schema.json', ...base, retired: [retired] })).retired).toEqual([retired])
  })

  it('reads a ledger without rules as one with no rules, and keeps the rules a ledger has', () => {
    expect(parseManifest(JSON.stringify(base)).rules).toEqual([])
    expect(parseManifest(JSON.stringify({ ...base, rules: [TESTS_RULE] })).rules).toEqual([TESTS_RULE])
  })

  it('refuses a rule pattern that is absolute, negated or climbs out of the repository, and an unknown kind', () => {
    for (const pattern of ['/docs/**', '!docs/**', '../docs/**', 'docs/\t*.md']) {
      expect(() => parseManifest(JSON.stringify({ ...base, rules: [{ ...TESTS_RULE, pattern }] })), pattern).toThrow(/rules\.0\.pattern: must be a repository-relative glob/)
    }
    expect(() => parseManifest(JSON.stringify({ ...base, rules: [{ ...TESTS_RULE, kind: 'source' }] }))).toThrow(/rules\.0\.kind/)
  })

  it('refuses a retired reason other than absorbed, an unknown field, and malformed JSON', () => {
    expect(() => parseManifest(JSON.stringify({ ...base, retired: [{ path: 'a', reason: 'superseded', upstreamCommit: commit, hunks: 1 }] })))
      .toThrow(/retired\.0\.reason/)
    expect(() => parseManifest(JSON.stringify({ ...base, extra: true }))).toThrow(/extra/)
    expect(() => parseManifest('{')).toThrow(/not valid JSON/)
  })

  it('accepts a recorded digest of the ledger schema and refuses one that is not a SHA-256', () => {
    const sha256 = patchDigest('a\n')
    expect(parseManifest(JSON.stringify({ ...base, patches: [{ path: 'a.ts', class: 'security', reason: 'edit', sha256 }] })).patches[0]?.sha256).toBe(sha256)
    expect(() => parseManifest(JSON.stringify({ ...base, patches: [{ path: 'a.ts', class: 'security', reason: 'edit', sha256: 'ABC' }] })))
      .toThrow(/patches\.0\.sha256/)
  })

  describe('non-model-visible hunk records', () => {
    const sha256 = patchDigest('a\n')
    const entry = (nonModelVisibleHunks: unknown): string =>
      JSON.stringify({ ...base, patches: [{ path: 'a.ts', class: 'security', reason: 'edit', sha256, nonModelVisibleHunks }] })

    it('accepts a security entry\'s records of a hunk digest and a one-line reason', () => {
      const records = [{ sha256: patchDigest('@@ -1 +1 @@\n-a\n+b\n'), reason: 'renames a local' }]
      const ledger = parseManifest(entry(records))
      expect(ledger.patches[0]?.nonModelVisibleHunks).toEqual(records)
      expect(manifestErrors(ledger)).toEqual([])
    })

    it('refuses an empty list, a digest that is not a SHA-256, and a reason that is empty, blank or spans lines', () => {
      expect(() => parseManifest(entry([]))).toThrow(/patches\.0\.nonModelVisibleHunks/)
      expect(() => parseManifest(entry([{ sha256: 'ABC', reason: 'r' }]))).toThrow(/patches\.0\.nonModelVisibleHunks\.0\.sha256/)
      for (const reason of ['', '  ', 'first line\nsecond line', 'first line\r\n']) {
        expect(() => parseManifest(entry([{ sha256, reason }])), JSON.stringify(reason)).toThrow(/nonModelVisibleHunks\.0\.reason: must be one line/)
      }
      expect(() => parseManifest(entry([{ sha256, reason: 'r', line: 3 }]))).toThrow(/line/)
    })

    it('refuses records on an entry that is not of class security', () => {
      const ledger = parseManifest(JSON.stringify({
        ...base, patches: [{ path: 'a.ts', class: 'generic-fix', feature: 'f', reason: 'edit', nonModelVisibleHunks: [{ sha256, reason: 'r' }] }],
      }))
      expect(manifestErrors(ledger)).toEqual(['a.ts: only a security entry records `nonModelVisibleHunks`; remove them from this generic-fix entry'])
    })
  })
})

describe('upstream source', () => {
  it.each([
    ['packages/core/session/src/index.ts', true],
    ['packages/client/ui-chat/src/client/chat/View.module.css', true],
    ['apps/cli/src/bin.ts', true],
    ['native/system/src/lib.rs', true],
    ['python/dsh/client.py', true],
    ['scripts/gen-tool-catalog.ts', true],
    ['scripts/release/families.ts', true],
    ['scripts/install-lefthook.mjs', true],
    ['vendor/loader/src/index.ts', true],
    ['vendor/loader/README.md', true],
    ['vendor/cordis/tests/a.spec.ts', true],
    ['packages/core/session/src/index.spec.ts', false],
    ['packages/core/session/src/view.test.tsx', false],
    ['packages/core/session/tests/a.spec.ts', false],
    ['packages/core/session/src/__tests__/a.ts', false],
    ['packages/core/session/src/fixtures/a.ts', false],
    ['packages/core/session/src/snapshots/a.ts', false],
    ['packages/core/session/src/README.md', false],
    ['packages/core/session/src/strings.i18n.yaml', false],
    ['packages/core/session/README.md', false],
    ['packages/core/session/package.json', false],
    ['native/system/test/launcher.test.js', false],
    ['python/tests/test_client.py', false],
    ['python/README.md', false],
    ['scripts/tests/a.ts', false],
    ['scripts/a.spec.ts', false],
    ['scripts/doc-budgets.manifest.json', false],
    ['docs/architecture.md', false],
    ['snapshots/sdk/sdk.snapshot.ts', false],
    ['.github/workflows/ci.yml', false],
  ])('%s is source: %s', (path, source) => {
    expect(isUpstreamSource(path)).toBe(source)
  })
})

describe('path rules', () => {
  it('fails a new upstream source file without an entry, and passes a new test file a rule covers', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'packages/core/session/src/index.ts': 'a\n' })
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [], [], ['delo/'], [TESTS_RULE]) })
    repo.write({ 'packages/core/session/tests/zz-probe.spec.ts': 'probe\n' })
    const ruled = checkRepository(repo.root)
    expect(ruled.errors).toEqual([])
    expect(ruled.coverage).toEqual(new Map([['**/tests/**', 1]]))
    repo.write({ 'packages/core/session/src/zz-probe.ts': 'probe\n' })
    expect(checkRepository(repo.root).errors).toEqual([
      'packages/core/session/src/zz-probe.ts: added upstream source file is not listed in delo/upstream-patches.json; source needs an entry',
    ])
  })

  it('fails a differing path that is not source when no rule covers it', () => {
    expect(forkBoundaryErrors(manifest([], [TESTS_RULE]), [{ path: 'docs/a.md', status: 'modified' }], new Set(['docs/a.md']))).toEqual([
      'docs/a.md: modified upstream file is not listed in delo/upstream-patches.json and no path rule covers it',
    ])
  })

  it('refuses a rule that matches upstream source, naming one source path', () => {
    const tree = ['packages/core/session/src/index.ts', 'docs/a.md']
    expect(manifestErrors(manifest([], [{ pattern: 'packages/core/**', kind: 'documentation', reason: 'r' }]), tree)).toEqual([
      'rule packages/core/**: matches upstream source such as packages/core/session/src/index.ts; source paths need a listed entry',
    ])
  })

  it('refuses a rule broad enough to reach source even with no tree at hand', () => {
    expect(manifestErrors(manifest([], [{ pattern: '**/*.ts', kind: 'tests', reason: 'r' }]))).toEqual([
      'rule **/*.ts: matches upstream source such as packages/group/package/src/index.ts; source paths need a listed entry',
    ])
    expect(manifestErrors(manifest([], [{ pattern: '**', kind: 'tests', reason: 'r' }]))).toEqual([
      'rule **: a bare `**` covers every path; name the paths the rule covers',
    ])
  })

  it('refuses a repeated pattern and a rule without a reason', () => {
    expect(manifestErrors(manifest([], [TESTS_RULE, { ...TESTS_RULE, reason: ' ' }]))).toEqual([
      'rule **/tests/**: listed more than once',
      'rule **/tests/**: a rule needs a reason',
    ])
    expect(manifestErrors(manifest([], [{ ...TESTS_RULE, reason: 'TODO' }]))).toEqual(['rule **/tests/**: a rule needs a reason'])
  })

  it('refuses a feature entry that a rule also covers, and keeps a security entry under a rule as an entry', () => {
    const test = 'packages/core/session/tests/a.spec.ts'
    expect(manifestErrors(manifest([{ path: test, class: 'delo-feature', feature: 'f', reason: 'r' }], [TESTS_RULE]))).toEqual([
      `${test}: listed and ruled by **/tests/**; remove the entry or narrow the rule`,
    ])
    expect(manifestErrors(manifest([{ path: test, class: 'security', reason: 'r', sha256: patchDigest('a') }], [TESTS_RULE]))).toEqual([])
  })

  it('never lets a rule cover a vendor path, while a vendor test does not make the rule an error', () => {
    const vendorTest = 'vendor/cordis/tests/a.spec.ts'
    const ledger = manifest([], [TESTS_RULE])
    expect(manifestErrors(ledger, [vendorTest])).toEqual([])
    expect(forkBoundaryErrors(ledger, [{ path: vendorTest, status: 'modified' }], new Set([vendorTest]))).toEqual([
      `${vendorTest}: modified upstream source file is not listed in delo/upstream-patches.json; source needs an entry`,
    ])
    expect(manifestErrors(manifest([], [{ pattern: 'vendor/loader/src/index.ts', kind: 'generated', reason: 'r' }]))).toEqual([])
    expect(manifestErrors(manifest([], [{ pattern: 'vendor/loader/src/index.ts', kind: 'generated', reason: 'r' }]), ['vendor/loader/src/index.ts'])).toEqual([
      'rule vendor/loader/src/index.ts: matches upstream source such as vendor/loader/src/index.ts; source paths need a listed entry',
    ])
  })

  it('lets an exact generated rule cover a source file that names its generator, and fails one that does not', (test) => {
    const catalog = 'packages/extensions/tool-cordis/src/api-catalog.ts'
    const rule: PathRule = { pattern: catalog, kind: 'generated', reason: 'regenerated' }
    const repo = fixture(test)
    const base = repo.commit({ [catalog]: '// Generated by scripts/gen-cordis-catalog.ts\nexport const a = 1\n' })
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [], [], ['delo/'], [rule]) })
    repo.write({ [catalog]: '// Generated by scripts/gen-cordis-catalog.ts\nexport const a = 2\n' })
    expect(checkRepository(repo.root).errors).toEqual([])
    repo.write({ [catalog]: 'export const a = 2\n' })
    expect(checkRepository(repo.root).errors).toEqual([
      `${catalog}: a generated rule covers this source file, but its first 5 lines do not hold "Generated by scripts/"; list it as an entry`,
    ])
  })

  it('refuses a generated rule whose glob reaches source', () => {
    expect(manifestErrors(manifest([], [{ pattern: 'packages/*/*/src/api-catalog.ts', kind: 'generated', reason: 'r' }]), ['packages/a/b/src/api-catalog.ts'])).toEqual([
      'rule packages/*/*/src/api-catalog.ts: matches upstream source such as packages/a/b/src/api-catalog.ts; source paths need a listed entry',
    ])
  })

  it('counts the differing paths each rule covers and warns about a rule that covers none', () => {
    const docs: PathRule = { pattern: 'docs/**/*.md', kind: 'documentation', reason: 'r' }
    const ledger = manifest([{ path: 'packages/a/b/tests/listed.spec.ts', class: 'security', reason: 'r', sha256: patchDigest('a') }], [TESTS_RULE, docs])
    const coverage = ruleCoverage(ledger, [
      { path: 'packages/a/b/tests/a.spec.ts', status: 'added' },
      { path: 'packages/a/b/tests/listed.spec.ts', status: 'modified' },
      { path: 'delo/tests/own.spec.ts', status: 'added' },
    ])
    expect(coverage).toEqual(new Map([['**/tests/**', 1], ['docs/**/*.md', 0]]))
    expect(formatCoverage(ledger, coverage)).toEqual([
      'rule **/tests/** (tests): covers 1 differing path',
      'rule docs/**/*.md (documentation): covers 0 differing paths',
      'warning: rule docs/**/*.md covers no differing path; remove it',
    ])
  })
})

describe('entry fields by class', () => {
  it('requires a digest and no feature on a security entry', () => {
    expect(manifestErrors(manifest([{ path: 'a.ts', class: 'security', feature: 'f', reason: 'r' }]))).toEqual([
      'a.ts: a security entry records the sha256 of its file; run `ledger-record.ts` after the lead\'s review',
      'a.ts: a security entry names no feature; remove `feature`',
    ])
  })

  it('requires a kebab-case feature and no digest on the other classes', () => {
    expect(manifestErrors(manifest([
      { path: 'a.ts', class: 'delo-feature', reason: 'r', sha256: patchDigest('a') },
      { path: 'b.ts', class: 'generic-fix', feature: 'Not Kebab', reason: 'r' },
      { path: 'c.ts', class: 'delo-feature', feature: 'profile-history', reason: 'r' },
    ]))).toEqual([
      'a.ts: only a security entry records a sha256; remove it from this delo-feature entry',
      'a.ts: a delo-feature entry names the feature it serves in `feature`',
      'b.ts: feature "Not Kebab" is not a kebab-case identifier',
    ])
  })

  it('refuses the TODO placeholders a stub entry carries', () => {
    expect(manifestErrors(manifest([{ path: 'a.ts', class: 'delo-feature', feature: 'TODO', reason: 'TODO' }]))).toEqual([
      'a.ts: the reason is TODO; the lead writes the reason',
      'a.ts: the feature is TODO; the lead names the feature this entry serves',
    ])
  })
})
