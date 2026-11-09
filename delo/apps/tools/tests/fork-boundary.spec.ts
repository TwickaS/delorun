import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { checkRepository, formatDivergence } from '../src/check-fork-boundary.ts'
import { forkBoundaryErrors, isForkOwned, manifestErrors, parseManifest } from '../src/fork-boundary.ts'
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
 * @returns the JSON text of the ledger.
 */
function ledgerText(
  commit: string,
  patches: readonly object[] = [],
  retired: readonly object[] = [],
  forkOwned: readonly string[] = ['delo/', '.agents/skills/delo-*/', NOTE_RULE],
): string {
  return JSON.stringify({ upstream: { ...UPSTREAM, commit }, forkOwned, patches, retired }, null, 2)
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
      'upstream.ts: modified upstream file is not listed in delo/upstream-patches.json',
    ])
  })

  it('fails a stale entry whose path no longer differs from upstream', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [{ path: 'upstream.ts', class: 'delo-feature', reason: 'edit', sha256: patchDigest('a\n') }]) })
    expect(checkRepository(repo.root).errors).toEqual([
      'upstream.ts: listed patch no longer differs from upstream; remove the entry',
    ])
  })

  it('fails a listed patch whose checksum the ledger does not record, and passes it once recorded', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    const entry = (patch: object) => ledgerText(base, [patch])
    repo.commit({ 'upstream.ts': 'b\n', 'delo/upstream-patches.json': entry({ path: 'upstream.ts', class: 'delo-feature', reason: 'edit' }) })
    expect(checkRepository(repo.root).errors).toEqual([
      `upstream.ts: the ledger records no sha256 for this patch; run \`upstream-update.ts --record\` and commit the ledger`,
    ])
    repo.commit({ 'delo/upstream-patches.json': entry({ path: 'upstream.ts', class: 'delo-feature', reason: 'edit', sha256: patchDigest('b\n') }) })
    expect(checkRepository(repo.root).errors).toEqual([])
  })

  it('fails a recorded digest that no longer matches the file at HEAD, and passes one that does', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'a\n' })
    const entry = (sha256: string) => ledgerText(base, [{ path: 'upstream.ts', class: 'delo-feature', reason: 'edit', sha256 }])
    repo.commit({ 'upstream.ts': 'b\n', 'delo/upstream-patches.json': entry(patchDigest('a\n')) })
    expect(checkRepository(repo.root).errors).toEqual([
      `upstream.ts: recorded sha256 ${patchDigest('a\n')}, but the file is ${patchDigest('b\n')}`,
    ])
    repo.commit({ 'delo/upstream-patches.json': entry(patchDigest('b\n')) })
    expect(checkRepository(repo.root).errors).toEqual([])
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
      '.agents/notes/implemented/architecture/2026-11-06-upstream-ledger.md: added upstream file is not listed in delo/upstream-patches.json',
    ])
  })

  it('credits a retired entry: its entry and hunks leave the divergence count', (test) => {
    const repo = fixture(test)
    const base = repo.commit({ 'upstream.ts': 'one\ntwo\nthree\n' })
    repo.run(['checkout', '-q', '-b', 'upstream'])
    const absorbed = repo.commit({ 'upstream.ts': 'ONE\ntwo\nTHREE\n' })
    repo.run(['checkout', '-q', 'main'])
    repo.write({ 'upstream.ts': 'ONE\ntwo\nTHREE\n' })
    repo.commit({ 'delo/upstream-patches.json': ledgerText(base, [{ path: 'upstream.ts', class: 'delo-feature', reason: 'edit', sha256: patchDigest('ONE\ntwo\nTHREE\n') }]) })
    const before = checkRepository(repo.root)
    expect(before.errors).toEqual([])
    expect(before.divergence).toEqual({ entries: 1, hunks: 2, retired: [] })

    repo.run(['merge', '-q', '--no-edit', 'upstream'])
    const retired = { path: 'upstream.ts', reason: 'absorbed', upstreamCommit: absorbed, hunks: 2 }
    repo.commit({ 'delo/upstream-patches.json': ledgerText(absorbed, [], [retired]) })
    const after = checkRepository(repo.root)
    expect(after.errors).toEqual([])
    expect(after.divergence).toEqual({ entries: 0, hunks: 0, retired: [retired] })
    expect(formatDivergence('v1', after.divergence ?? { entries: 0, hunks: 0, retired: [] })).toEqual([
      'fork divergence against v1: 0 entries, 0 hunks',
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
    const commit = 'a'.repeat(40)
    const errors = manifestErrors({
      upstream: { ...UPSTREAM, commit },
      forkOwned: ['delo/'],
      patches: [
        { path: 'delo/x.md', class: 'delo-feature', reason: 'r' },
        { path: 'a', class: 'generic-fix', reason: ' ' },
        { path: 'a', class: 'generic-fix', reason: 'r' },
      ],
      retired: [],
    })
    expect(errors).toEqual([
      'a: listed more than once',
      'a: a patch needs a reason',
      'delo/x.md: fork-owned paths are not ledger entries; remove the entry',
    ])
  })

  it('refuses a compiled twin of a TypeScript source inside a fork-owned tree', () => {
    const files = new Set(['delo/apps/x/src/a.ts', 'delo/apps/x/src/a.js'])
    expect(forkBoundaryErrors({ upstream: { ...UPSTREAM, commit: 'a'.repeat(40) }, forkOwned: ['delo/'], patches: [], retired: [] },
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

  it('refuses a retired reason other than absorbed, an unknown field, and malformed JSON', () => {
    expect(() => parseManifest(JSON.stringify({ ...base, retired: [{ path: 'a', reason: 'superseded', upstreamCommit: commit, hunks: 1 }] })))
      .toThrow(/retired\.0\.reason/)
    expect(() => parseManifest(JSON.stringify({ ...base, extra: true }))).toThrow(/extra/)
    expect(() => parseManifest('{')).toThrow(/not valid JSON/)
  })

  it('accepts a recorded digest of the ledger schema and refuses one that is not a SHA-256', () => {
    const sha256 = patchDigest('a\n')
    expect(parseManifest(JSON.stringify({ ...base, patches: [{ path: 'a.ts', class: 'delo-feature', reason: 'edit', sha256 }] })).patches[0]?.sha256).toBe(sha256)
    expect(() => parseManifest(JSON.stringify({ ...base, patches: [{ path: 'a.ts', class: 'delo-feature', reason: 'edit', sha256: 'ABC' }] })))
      .toThrow(/patches\.0\.sha256/)
  })
})
