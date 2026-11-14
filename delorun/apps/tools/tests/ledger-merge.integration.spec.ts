import { readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { parseManifest, type Patch, type PathRule, type RetiredEntry } from '../src/fork-boundary.ts'
import { mergeLedgerTexts } from '../src/ledger-merge.ts'
import { REPO, runTsx, scratchRepo, type Scratch } from './gates/support.ts'

const LEDGER = 'delorun/upstream-patches.json'
const DRIVER = join(REPO, 'delorun/apps/tools/src/ledger-merge.ts')
const TSX = join(REPO, 'node_modules/.bin/tsx')
/** The driver command that the setup step configures, with absolute paths so that a temporary repository can run it. */
const DRIVER_COMMAND = `${[TSX, DRIVER].map(path => `"${path.replace(/\\/gu, '/')}"`).join(' ')} %O %A %B`
/** Each driver run starts tsx, so a test that runs the driver needs more than the default test timeout. */
const PROCESS_TIMEOUT_MS = 60_000

const UPSTREAM = { repository: 'https://example.invalid/upstream.git', ref: 'v1', commit: '0123456789abcdef0123456789abcdef01234567' }
const MOVED_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98'

/**
 * A patch entry whose reason names its path unless a reason is given.
 * @param path - the upstream path the entry lists.
 * @param reason - the entry's reason.
 * @returns the entry.
 */
function patch(path: string, reason = `reason for ${path}`): Patch {
  return { path, class: 'delorun-feature', feature: 'a-feature', reason }
}

/**
 * A path rule whose reason names its pattern unless a reason is given.
 * @param pattern - the rule's glob.
 * @param reason - the rule's reason.
 * @returns the rule.
 */
function rule(pattern: string, reason = `reason for ${pattern}`): PathRule {
  return { pattern, kind: 'documentation', reason }
}

/**
 * A retired entry for a path that upstream absorbed.
 * @param path - the retired path.
 * @param hunks - the hunks the entry had.
 * @returns the entry.
 */
function retired(path: string, hunks = 1): RetiredEntry {
  return { path, reason: 'absorbed', upstreamCommit: MOVED_COMMIT, hunks }
}

/**
 * A ledger's JSON text as the repository stores it.
 * @param patches - the listed patches.
 * @param options - the retired entries, the pinned upstream, the fork-owned entries and the `$schema` reference.
 * @returns the ledger text with a final newline.
 */
function ledgerText(
  patches: readonly Patch[],
  options: {
    readonly retired?: readonly RetiredEntry[]
    readonly upstream?: typeof UPSTREAM
    readonly forkOwned?: readonly string[]
    readonly schema?: string
    readonly rules?: readonly PathRule[]
  } = {},
): string {
  const document = {
    ...(options.schema === undefined ? {} : { $schema: options.schema }),
    upstream: options.upstream ?? UPSTREAM,
    forkOwned: options.forkOwned ?? ['delorun/'],
    rules: options.rules ?? [],
    patches,
    retired: options.retired ?? [],
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

const A = patch('docs/a.md')
const B = patch('docs/b.md')
const C = patch('docs/c.md')
const D = patch('docs/d.md')
const BASE = ledgerText([A, B])

/**
 * The upstream paths a ledger's patches list, in file order.
 * @param text - a valid ledger's text.
 * @returns the listed paths.
 */
function pathsOf(text: string): string[] {
  return parseManifest(text).patches.map(entry => entry.path)
}

/**
 * Write three ledger versions into a scratch repository.
 * @param repo - the scratch repository.
 * @param versions - the base, ours and theirs texts.
 * @returns the absolute paths of the three files.
 */
function writeVersions(repo: Scratch, versions: { readonly base: string; readonly ours: string; readonly theirs: string }): {
  readonly base: string
  readonly ours: string
  readonly theirs: string
} {
  repo.write({ 'base.json': versions.base, 'ours.json': versions.ours, 'theirs.json': versions.theirs })
  return { base: join(repo.root, 'base.json'), ours: join(repo.root, 'ours.json'), theirs: join(repo.root, 'theirs.json') }
}

describe('mergeLedgerTexts', () => {
  it('takes each side\'s change to an entry when the other side left that entry alone', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([{ ...A, reason: 'ours' }, B]), ledgerText([A, { ...B, reason: 'theirs' }]))
    expect(merge.errors).toEqual([])
    expect(parseManifest(merge.text).patches).toEqual([{ ...A, reason: 'ours' }, { ...B, reason: 'theirs' }])
  })

  it('keeps our order and appends the entries only their side added, in their order', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B, C]), ledgerText([A, B, D, patch('docs/e.md')]))
    expect(merge.errors).toEqual([])
    expect(pathsOf(merge.text)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md'])
  })

  it('merges an entry that both sides added identically into one entry', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B, C]), ledgerText([A, B, C, D]))
    expect(merge.errors).toEqual([])
    expect(pathsOf(merge.text)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md'])
  })

  it('conflicts when both sides add one path with different values', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B, patch('docs/c.md', 'ours')]), ledgerText([A, B, patch('docs/c.md', 'theirs')]))
    expect(merge.errors).toEqual(['patches entry docs/c.md: added with different values on both sides'])
  })

  it('removes an entry that one side removed while the other side left it unchanged', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A]), BASE)
    expect(merge.errors).toEqual([])
    expect(pathsOf(merge.text)).toEqual(['docs/a.md'])
  })

  it('conflicts when one side removes an entry that the other side changed', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A]), ledgerText([A, { ...B, reason: 'theirs' }]))
    expect(merge.errors).toEqual(['patches entry docs/b.md: removed on one side and changed on the other'])
  })

  it('takes one change that both sides made identically', () => {
    const changed = { ...A, reason: 'same' }
    const merge = mergeLedgerTexts(BASE, ledgerText([changed, B]), ledgerText([changed, B]))
    expect(merge.errors).toEqual([])
    expect(parseManifest(merge.text).patches).toEqual([changed, B])
  })

  it('wraps only the entry that both sides changed differently in conflict markers', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([{ ...A, reason: 'ours' }, B]), ledgerText([{ ...A, reason: 'theirs' }, B]))
    expect(merge.errors).toEqual(['patches entry docs/a.md: changed differently on both sides'])
    expect(merge.text).toContain([
      '  "patches": [',
      '<<<<<<< ours',
      '    {',
      '      "path": "docs/a.md",',
      '      "class": "delorun-feature",',
      '      "feature": "a-feature",',
      '      "reason": "ours"',
      '    },',
      '=======',
      '    {',
      '      "path": "docs/a.md",',
      '      "class": "delorun-feature",',
      '      "feature": "a-feature",',
      '      "reason": "theirs"',
      '    },',
      '>>>>>>> theirs',
      '    {',
      '      "path": "docs/b.md",',
    ].join('\n'))
    expect(merge.text.match(/^<<<<<<< /gmu)).toHaveLength(1)
  })

  it('unions the forkOwned entries of both sides in order', () => {
    const merge = mergeLedgerTexts(
      ledgerText([], { forkOwned: ['delorun/'] }),
      ledgerText([], { forkOwned: ['delorun/', 'ours/'] }),
      ledgerText([], { forkOwned: ['delorun/', 'theirs/'] }),
    )
    expect(merge.errors).toEqual([])
    expect(parseManifest(merge.text).forkOwned).toEqual(['delorun/', 'ours/', 'theirs/'])
  })

  it('unions the path rules of both sides by pattern', () => {
    const base = ledgerText([], { rules: [rule('docs/**/*.md')] })
    const merge = mergeLedgerTexts(
      base,
      ledgerText([], { rules: [rule('docs/**/*.md'), rule('**/README.md')] }),
      ledgerText([], { rules: [rule('docs/**/*.md'), rule('*.md')] }),
    )
    expect(merge.errors).toEqual([])
    expect(parseManifest(merge.text).rules.map(entry => entry.pattern)).toEqual(['docs/**/*.md', '**/README.md', '*.md'])
  })

  it('conflicts when both sides add one pattern with different fields', () => {
    const merge = mergeLedgerTexts(
      ledgerText([]),
      ledgerText([], { rules: [rule('**/README.md', 'ours')] }),
      ledgerText([], { rules: [{ ...rule('**/README.md', 'ours'), kind: 'tooling' }] }),
    )
    expect(merge.errors).toEqual(['rules entry **/README.md: added with different values on both sides'])
    expect(merge.text).toContain('<<<<<<< ours\n    {\n      "pattern": "**/README.md",')
  })

  it('reports a version whose rules repeat a pattern', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B], { rules: [rule('*.md'), rule('*.md', 'again')] }), BASE)
    expect(merge.errors).toContain('ours rules lists *.md more than once')
  })

  it('merges a security entry with a digest beside entries that record none', () => {
    const gate: Patch = { path: 'src/gate.ts', class: 'security', reason: 'moves a gate', sha256: 'a'.repeat(64) }
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B, gate]), ledgerText([A, B, C]))
    expect(merge.errors).toEqual([])
    expect(parseManifest(merge.text).patches).toEqual([A, B, gate, C])
  })

  it('merges retired entries by path, as it merges patches', () => {
    const merge = mergeLedgerTexts(
      ledgerText([]),
      ledgerText([], { retired: [retired('docs/x.md')] }),
      ledgerText([], { retired: [retired('docs/y.md', 2)] }),
    )
    expect(merge.errors).toEqual([])
    expect(parseManifest(merge.text).retired).toEqual([retired('docs/x.md'), retired('docs/y.md', 2)])
  })

  it('conflicts when both sides retire one path with different hunk counts', () => {
    const merge = mergeLedgerTexts(
      ledgerText([]),
      ledgerText([], { retired: [retired('docs/x.md', 1)] }),
      ledgerText([], { retired: [retired('docs/x.md', 2)] }),
    )
    expect(merge.errors).toEqual(['retired entry docs/x.md: added with different values on both sides'])
  })

  it('conflicts when the sides pin different upstream commits, even when one side kept the base pin', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B], { upstream: { ...UPSTREAM, commit: MOVED_COMMIT } }), BASE)
    expect(merge.errors).toEqual(['upstream: the sides pin different upstream commits'])
    expect(merge.text).toContain('<<<<<<< ours\n  "upstream": {')
  })

  it('accepts an upstream pin that both sides moved to the same commit', () => {
    const moved = { ...UPSTREAM, commit: MOVED_COMMIT }
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B], { upstream: moved }), ledgerText([A, B, C], { upstream: moved }))
    expect(merge.errors).toEqual([])
    expect(parseManifest(merge.text).upstream).toEqual(moved)
  })

  it('keeps a schema reference that one side added', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B], { schema: './upstream-patches.schema.json' }), BASE)
    expect(merge.errors).toEqual([])
    expect(parseManifest(merge.text).$schema).toBe('./upstream-patches.schema.json')
  })

  it('writes a clean merge as two-space JSON with one trailing newline', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B, C]), ledgerText([A, B, D]))
    expect(merge.text).toBe(`${JSON.stringify(JSON.parse(merge.text), null, 2)}\n`)
  })

  it('returns an unchanged ledger byte for byte when neither side changed it', () => {
    expect(mergeLedgerTexts(BASE, BASE, BASE)).toEqual({ text: BASE, errors: [] })
  })

  it('treats an empty base as an empty ledger when both sides added the file', () => {
    const merge = mergeLedgerTexts('', ledgerText([A]), ledgerText([B]))
    expect(merge.errors).toEqual([])
    expect(pathsOf(merge.text)).toEqual(['docs/a.md', 'docs/b.md'])
  })

  it('reports a path that is both a patch and a retired entry in the merged ledger', () => {
    const merge = mergeLedgerTexts(ledgerText([]), ledgerText([A]), ledgerText([], { retired: [retired(A.path)] }))
    expect(merge.errors).toEqual(['docs/a.md: listed more than once'])
  })

  it('reports a list in one version that names the same path twice', () => {
    const merge = mergeLedgerTexts(BASE, ledgerText([A, B, patch(A.path, 'again')]), BASE)
    expect(merge.errors).toEqual(['ours patches lists docs/a.md more than once'])
  })

  it('throws naming the version when a version is not a ledger', () => {
    expect(() => mergeLedgerTexts(BASE, '{', BASE)).toThrow(/^ours: /u)
    expect(() => mergeLedgerTexts('{', BASE, BASE)).toThrow(/^base: /u)
  })
})

describe('the driver command line', () => {
  it('writes a clean merge to the ours file and exits 0', (test) => {
    const repo = scratchRepo(test)
    const files = writeVersions(repo, { base: BASE, ours: ledgerText([A, B, C]), theirs: ledgerText([A, B, D]) })
    const result = runTsx(REPO, DRIVER, [files.base, files.ours, files.theirs])
    expect(result.status).toBe(0)
    expect(pathsOf(readFileSync(files.ours, 'utf8'))).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md'])
  }, PROCESS_TIMEOUT_MS)

  it('writes a conflict with markers to the ours file, reports it, and exits 1', (test) => {
    const repo = scratchRepo(test)
    const files = writeVersions(repo, {
      base: BASE,
      ours: ledgerText([{ ...A, reason: 'ours' }, B]),
      theirs: ledgerText([{ ...A, reason: 'theirs' }, B]),
    })
    const result = runTsx(REPO, DRIVER, [files.base, files.ours, files.theirs])
    expect(result.status).toBe(1)
    expect(result.output).toContain('ledger-merge: patches entry docs/a.md: changed differently on both sides')
    expect(readFileSync(files.ours, 'utf8')).toContain('<<<<<<< ours')
  }, PROCESS_TIMEOUT_MS)

  it('exits 2 with a usage line when it is not given three paths', (test) => {
    const repo = scratchRepo(test)
    const files = writeVersions(repo, { base: BASE, ours: BASE, theirs: BASE })
    const result = runTsx(REPO, DRIVER, [files.base, files.ours])
    expect(result.status).toBe(2)
    expect(result.output).toContain('usage: ledger-merge.ts')
  }, PROCESS_TIMEOUT_MS)

  it('runs the merge when the command names a symlink to the driver', (test) => {
    const repo = scratchRepo(test)
    const files = writeVersions(repo, { base: BASE, ours: BASE, theirs: ledgerText([A, B, D]) })
    symlinkSync(DRIVER, join(repo.root, 'driver-link.ts'))
    const result = runTsx(REPO, join(repo.root, 'driver-link.ts'), [files.base, files.ours, files.theirs])
    expect(result.status).toBe(0)
    expect(pathsOf(readFileSync(files.ours, 'utf8'))).toEqual(['docs/a.md', 'docs/b.md', 'docs/d.md'])
  }, PROCESS_TIMEOUT_MS)
})

/**
 * A repository on branch `adds-d`, which adds patch D to the base ledger, with branch `adds-c` beside it, which adds patch C.
 * @param test - the running test.
 * @param driver - whether the driver command is configured, as the setup step does.
 * @returns the repository, checked out on `adds-d`.
 */
function addingBranches(test: TestContext, driver: boolean): Scratch {
  const repo = scratchRepo(test)
  repo.commit({ '.gitattributes': `${LEDGER} merge=delorun-ledger\n`, [LEDGER]: BASE })
  if (driver) repo.run(['config', 'merge.delorun-ledger.driver', DRIVER_COMMAND])
  repo.run(['checkout', '-q', '-b', 'adds-c'])
  repo.commit({ [LEDGER]: ledgerText([A, B, C]) })
  repo.run(['checkout', '-q', '-b', 'adds-d', 'main'])
  repo.commit({ [LEDGER]: ledgerText([A, B, D]) })
  return repo
}

describe('the driver in git', () => {
  it('rebases a branch that adds an entry onto one that adds another, without a conflict', (test) => {
    const repo = addingBranches(test, true)
    repo.run(['rebase', 'adds-c'])
    expect(pathsOf(repo.run(['show', `HEAD:${LEDGER}`]))).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md'])
  }, PROCESS_TIMEOUT_MS)

  it('rebases a branch that rewords one entry onto one that adds an entry, without a conflict', (test) => {
    const repo = scratchRepo(test)
    repo.commit({ '.gitattributes': `${LEDGER} merge=delorun-ledger\n`, [LEDGER]: BASE })
    repo.run(['config', 'merge.delorun-ledger.driver', DRIVER_COMMAND])
    repo.run(['checkout', '-q', '-b', 'adds-c'])
    repo.commit({ [LEDGER]: ledgerText([A, B, C]) })
    repo.run(['checkout', '-q', '-b', 'reword-a', 'main'])
    repo.commit({ [LEDGER]: ledgerText([{ ...A, reason: 'reworded' }, B]) })
    repo.run(['rebase', 'adds-c'])
    expect(parseManifest(repo.run(['show', `HEAD:${LEDGER}`])).patches).toEqual([{ ...A, reason: 'reworded' }, B, C])
  }, PROCESS_TIMEOUT_MS)

  it('stops at a conflict with markers around only the entry that both branches changed differently', (test) => {
    const repo = scratchRepo(test)
    repo.commit({ '.gitattributes': `${LEDGER} merge=delorun-ledger\n`, [LEDGER]: BASE })
    repo.run(['config', 'merge.delorun-ledger.driver', DRIVER_COMMAND])
    repo.run(['checkout', '-q', '-b', 'reason-x'])
    repo.commit({ [LEDGER]: ledgerText([{ ...A, reason: 'x' }, B]) })
    repo.run(['checkout', '-q', '-b', 'reason-y', 'main'])
    repo.commit({ [LEDGER]: ledgerText([{ ...A, reason: 'y' }, B]) })
    expect(() => repo.run(['rebase', 'reason-x'])).toThrow()
    expect(repo.run(['status', '--porcelain'])).toContain(`UU ${LEDGER}`)
    const text = readFileSync(join(repo.root, LEDGER), 'utf8')
    expect(text.match(/^<<<<<<< /gmu)).toHaveLength(1)
    expect(text).toContain([
      '<<<<<<< ours',
      '    {',
      '      "path": "docs/a.md",',
      '      "class": "delorun-feature",',
      '      "feature": "a-feature",',
      '      "reason": "x"',
      '    },',
      '=======',
      '    {',
      '      "path": "docs/a.md",',
      '      "class": "delorun-feature",',
      '      "feature": "a-feature",',
      '      "reason": "y"',
      '    },',
      '>>>>>>> theirs',
    ].join('\n'))
    repo.run(['rebase', '--abort'])
  }, PROCESS_TIMEOUT_MS)

  it('without the driver configured, reports the same parallel additions as a conflict', (test) => {
    const repo = addingBranches(test, false)
    expect(() => repo.run(['rebase', 'adds-c'])).toThrow()
    expect(repo.run(['status', '--porcelain'])).toContain(`UU ${LEDGER}`)
    repo.run(['rebase', '--abort'])
  }, PROCESS_TIMEOUT_MS)
})
