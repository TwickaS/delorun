import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Patch, PatchManifest } from '../../src/fork-boundary.ts'
import { MANIFEST_PATH, parseManifest } from '../../src/fork-boundary.ts'
import { digestErrors, patchDigest } from '../../src/ledger-digests.ts'
import { carriedLedger, verifyApplied } from '../../src/upstream-update.ts'
import { scratchRepo, type Scratch } from '../gates/support.ts'
import { checkoutState, lines } from '../rehearse/fixtures.ts'
import {
  checkBoundary,
  ledgerOf,
  leftoverScratch,
  PROCESS_TIMEOUT_MS,
  runUpdate,
  updateFixture,
  type UpdateFiles,
  type UpdateFixture,
  type UpdateOptions,
} from './fixtures.ts'

const A = 'docs/a.md'
const B = 'docs/b.md'
const GATE = 'src/gate.ts'

/**
 * A ledger patch.
 * @param path - the listed path.
 * @param kind - the patch's class.
 * @returns the patch.
 */
function patch(path: string, kind: Patch['class'] = 'delo-feature'): Patch {
  return kind === 'security' ? { path, class: kind, reason: `reason for ${path}` } : { path, class: kind, feature: 'a-feature', reason: `reason for ${path}` }
}

/**
 * Rewrite the fork's ledger in the fork and commit it, as the history before the release merge.
 * @param fork - the fork.
 * @param edit - what to change in the parsed ledger.
 */
function rewriteLedger(fork: Scratch, edit: (ledger: PatchManifest) => void): void {
  const ledger = JSON.parse(readFileSync(join(fork.root, MANIFEST_PATH), 'utf8')) as PatchManifest
  edit(ledger)
  fork.commit({ [MANIFEST_PATH]: `${JSON.stringify(ledger, null, 2)}\n` })
}

/**
 * Build a fixture and run the command in it, checking that the run left no scratch directory behind.
 * @param test - the running test.
 * @param files - the fixture's files.
 * @param args - the command-line arguments.
 * @param options - how the fixture departs from a coherent, recorded, unmerged patch set.
 * @returns the exit status and the combined output.
 */
function runIn(
  test: Parameters<typeof updateFixture>[0], files: UpdateFiles, args: readonly string[], options: UpdateOptions = {},
): { status: number; output: string } {
  const fixture = updateFixture(test, files, options)
  const result = runUpdate(fixture, args)
  expect(leftoverScratch(fixture)).toEqual([])
  return result
}

/** A patch set that carries onto `v2` unchanged: the tag moves another line of the same file. */
const CARRIES: UpdateFiles = {
  base: { [A]: lines(30), [B]: lines(30) },
  tag: { [A]: lines(30, { 20: 'upstream 20' }), 'docs/new.md': 'new\n' },
  fork: { [A]: lines(30, { 5: 'delo 5' }) },
  patches: [patch(A)],
}

/** The same patch set with its one patch in the security class, whose digest the ledger records. */
const CARRIES_SECURITY: UpdateFiles = { ...CARRIES, patches: [patch(A, 'security')] }

/** A patch set whose one patch conflicts with the tag: both sides rewrite the same line. */
const CONFLICTS: UpdateFiles = {
  base: { [GATE]: lines(30) },
  tag: { [GATE]: lines(30, { 5: 'upstream 5' }) },
  fork: { [GATE]: lines(30, { 5: 'delo 5' }) },
  patches: [patch(GATE)],
}

describe('carrying the patch set onto a later tag', () => {
  it('reports the entries it would carry and leaves the checkout unchanged', (test) => {
    const fixture = updateFixture(test, CARRIES)
    const before = checkoutState(fixture.fork)
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain(`carry-forward onto v2 (${fixture.target}) from pin v1 (${fixture.pin})`)
    expect(result.output).toContain('carried: 1 entry, 1 hunk')
    expect(result.output).toContain(`  ${A} (delo-feature, 1 hunk)\n`)
    expect(result.output).toContain(`verified: every listed patch applies to v2`)
    expect(result.output).toContain('dry run; pass --write once the release merge is in HEAD to record it')
    expect(checkoutState(fixture.fork)).toEqual(before)
    expect(leftoverScratch(fixture)).toEqual([])
  }, PROCESS_TIMEOUT_MS)

  it('writes the carried ledger once the release merge is in HEAD, and the ledger gate accepts it', (test) => {
    const rules = [{ pattern: 'docs/notes/**', kind: 'documentation' as const, reason: 'notes that document Delo changes' }]
    const fixture = updateFixture(test, {
      ...CARRIES,
      fork: { ...CARRIES.fork, [GATE]: 'delo gate\n', 'docs/notes/delo.md': 'delo\n' },
      patches: [patch(A), patch(GATE, 'security')],
      rules,
    }, { merge: true })
    const result = runUpdate(fixture, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('upstream-patches.json now pins v2')
    const ledger = ledgerOf(fixture)
    expect(ledger.upstream).toEqual({ repository: fixture.upstream.root, ref: 'v2', commit: fixture.target })
    expect(ledger.rules).toEqual(rules)
    expect(ledger.patches).toEqual([
      { path: A, class: 'delo-feature', feature: 'a-feature', reason: `reason for ${A}` },
      { path: GATE, class: 'security', reason: `reason for ${GATE}`, sha256: patchDigest('delo gate\n') },
    ])
    expect(ledger.retired).toEqual([])
    const gate = checkBoundary(fixture)
    expect(gate.status, gate.output).toBe(0)
    expect(gate.output).toContain('fork boundary: rule docs/notes/** (documentation): covers 1 differing path')
    expect(gate.output).toContain('fork boundary: holds against v2 with 2 listed patch(es) and 1 path rule(s)')
  }, PROCESS_TIMEOUT_MS)

  it('retires an entry the target absorbed and records the absorbing commit', (test) => {
    const fixture = updateFixture(test, {
      base: { [B]: lines(30) },
      tag: { [B]: lines(30, { 3: 'delo 3' }) },
      fork: { [B]: lines(30, { 3: 'delo 3' }) },
      patches: [patch(B)],
    }, { merge: true })
    const result = runUpdate(fixture, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('absorbed by v2 (retired): 1 entry, 1 hunk at the pin')
    const ledger = ledgerOf(fixture)
    expect(ledger.patches).toEqual([])
    expect(ledger.retired).toEqual([{ path: B, reason: 'absorbed', upstreamCommit: fixture.target, hunks: 1 }])
  }, PROCESS_TIMEOUT_MS)
})

describe('the state the ledger describes', () => {
  it('refuses a ledger entry dropped before the release merge, instead of writing the ledger that would lose it', (test) => {
    const fixture = updateFixture(test, {
      base: { [A]: lines(30), [B]: lines(30) },
      tag: { [A]: lines(30, { 20: 'upstream 20' }), [B]: lines(30, { 10: 'upstream 10' }) },
      fork: { [A]: lines(30, { 5: 'delo 5' }), [B]: lines(30, { 3: 'delo 3' }) },
      patches: [patch(A), patch(B)],
    }, {
      merge: true,
      between: fork => rewriteLedger(fork, ledger => {
        ledger.patches = ledger.patches.filter(entry => entry.path !== B)
      }),
    })
    const before = ledgerOf(fixture)
    expect(before.patches.map(entry => entry.path)).toEqual([A])
    const result = runUpdate(fixture, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: ledger-inconsistent: ${B}: modified upstream file is not listed in ${MANIFEST_PATH}`)
    expect(ledgerOf(fixture)).toEqual(before)
    expect(leftoverScratch(fixture)).toEqual([])
  }, PROCESS_TIMEOUT_MS)

  it('refuses a security digest that drifted before the release merge, instead of recording the drifted file', (test) => {
    const fixture = updateFixture(test, CARRIES_SECURITY, {
      merge: true,
      between: fork => { fork.commit({ [A]: lines(30, { 5: 'delo 5, edited after the record' }) }) },
    })
    const before = ledgerOf(fixture)
    const result = runUpdate(fixture, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: checksum-drift: ${A}: recorded sha256 `)
    expect(result.output).toContain('the lead reviews the change, then `ledger-record.ts` re-records the digest')
    expect(ledgerOf(fixture)).toEqual(before)
    expect(before.upstream.ref).toBe('v1')
  }, PROCESS_TIMEOUT_MS)

  it('refuses a security entry the ledger never recorded once the release merge is in HEAD', (test) => {
    const fixture = updateFixture(test, CARRIES_SECURITY, { record: false, merge: true })
    const result = runUpdate(fixture, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: ledger-inconsistent: ${A}: a security entry records the sha256 of its file`)
    expect(ledgerOf(fixture).upstream.ref).toBe('v1')
    expect(ledgerOf(fixture).patches[0]?.sha256).toBeUndefined()
  }, PROCESS_TIMEOUT_MS)

  it('carries a security patch a merge resolved in the release\'s favour instead of retiring it as absorbed', (test) => {
    const fixture = updateFixture(test, {
      base: { [GATE]: lines(30) },
      tag: { [GATE]: lines(30, { 20: 'upstream 20' }) },
      fork: { [GATE]: lines(30, { 5: 'delo 5' }) },
      patches: [patch(GATE, 'security')],
    }, {
      merge: true,
      between: fork => {
        // The release merge is resolved in upstream's favour, so the fork's own change to the file is dropped from HEAD.
        fork.run(['merge', '-q', '--no-ff', '--no-commit', 'v2'])
        fork.run(['checkout', 'v2', '--', GATE])
        fork.run(['commit', '-q', '-m', 'release v2, resolved in upstream\'s favour'])
      },
    })
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('carried: 1 entry, 1 hunk')
    expect(result.output).toContain(`  ${GATE} (security, 1 hunk, sha256 `)
    expect(result.output).toContain(', measured at the pre-merge state')
    expect(result.output).not.toContain('absorbed by v2')
  }, PROCESS_TIMEOUT_MS)

  it('credits an absorbed entry with the hunks it had at the pin, not the hunks the release added beside them', (test) => {
    const fixture = updateFixture(test, {
      base: { [B]: lines(30) },
      tag: { [B]: lines(30, { 3: 'delo 3', 25: 'upstream 25' }) },
      fork: { [B]: lines(30, { 3: 'delo 3' }) },
      patches: [patch(B)],
    }, { merge: true })
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('absorbed by v2 (retired): 1 entry, 1 hunk at the pin')
  }, PROCESS_TIMEOUT_MS)
})

describe('measuring the state the ledger describes', () => {
  // The ledger's pin is always an ancestor of HEAD, and a tag at or below the pin is in HEAD's history already, so
  // reading "the release is in HEAD" as a landed merge measured the pin: the patch set vanished, 0 paths differed, and
  // every entry looked absorbed.
  it('measures HEAD when the tag is the ledger’s own pin and HEAD merely descends from it', (test) => {
    const fixture = updateFixture(test, CARRIES)
    const result = runUpdate(fixture, ['--tag', 'v1'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain(`carry-forward onto v1 (${fixture.pin}) from pin v1 (${fixture.pin}) at HEAD `)
    expect(result.output).toContain('carried: 1 entry, 1 hunk')
    expect(result.output).not.toContain('measured at the pre-merge state')
    expect(result.output).not.toContain('absorbed by v1')
  }, PROCESS_TIMEOUT_MS)

  it('catches a patch the ledger dropped when HEAD merely descends from the pin, instead of seeing no difference', (test) => {
    const fixture = updateFixture(test, {
      base: { [A]: lines(30), [B]: lines(30) },
      tag: { [A]: lines(30, { 20: 'upstream 20' }) },
      fork: { [A]: lines(30, { 5: 'delo 5' }), [B]: lines(30, { 3: 'delo 3' }) },
      patches: [patch(A), patch(B)],
    }, {
      between: fork => rewriteLedger(fork, ledger => {
        ledger.patches = ledger.patches.filter(entry => entry.path !== B)
      }),
    })
    const result = runUpdate(fixture, ['--tag', 'v1', '--write'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: ledger-inconsistent: ${B}: modified upstream file is not listed in ${MANIFEST_PATH}`)
    expect(result.output).not.toContain('listed patch no longer differs')
    expect(ledgerOf(fixture).patches.map(entry => entry.path)).toEqual([A])
  }, PROCESS_TIMEOUT_MS)

  it('measures the fork’s own side once a real release merge is in HEAD', (test) => {
    const fixture = updateFixture(test, CARRIES, { merge: true })
    const side = fixture.fork.run(['rev-parse', 'HEAD^1'])
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain(`measured at the pre-merge state ${side.slice(0, 12)}`)
    expect(result.output).toContain('carried: 1 entry, 1 hunk')
  }, PROCESS_TIMEOUT_MS)

  it('refuses when the walk from HEAD reaches the pin, instead of measuring the pin as the fork’s side', (test) => {
    const fixture = updateFixture(test, CARRIES, {
      between: fork => {
        const ledger = readFileSync(join(fork.root, MANIFEST_PATH), 'utf8')
        // The release is merged into the pin itself, so no commit of the fork's sits above the pin to measure.
        fork.run(['reset', '-q', '--hard', 'v1'])
        fork.run(['merge', '-q', '--no-ff', '-m', 'release v2', 'v2'])
        fork.commit({ [MANIFEST_PATH]: ledger })
      },
    })
    const result = runUpdate(fixture, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('upstream-update: merge-side-missing: the walk from HEAD reaches the pin ')
    expect(result.output).toContain('measuring the pin would show every listed patch as absorbed')
    expect(ledgerOf(fixture).upstream.ref).toBe('v1')
    expect(leftoverScratch(fixture)).toEqual([])
  }, PROCESS_TIMEOUT_MS)
})

describe('a listed patch that would delete its file', () => {
  /** A patch set whose listed entry for `A` is left behind when the fork deletes the file. */
  const DELETED: { readonly files: UpdateFiles; readonly between: (fork: Scratch) => void } = {
    files: {
      base: { [A]: lines(30), [B]: lines(30) },
      tag: { [B]: lines(30, { 10: 'upstream 10' }) },
      fork: { [B]: lines(30, { 3: 'delo 3' }) },
      patches: [patch(A), patch(B)],
    },
    between: fork => {
      fork.run(['rm', '-q', A])
      fork.commit({})
    },
  }

  it('refuses it with its own code instead of a checksum the file cannot answer for', (test) => {
    const fixture = updateFixture(test, DELETED.files, { between: DELETED.between })
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: patch-deletes-file: ${A} is listed in ${MANIFEST_PATH}, but HEAD holds no file there`)
    expect(result.output).not.toContain('checksum-drift')
  }, PROCESS_TIMEOUT_MS)

  it('refuses it the same way once the release merge is in HEAD, instead of failing on the missing file', (test) => {
    const fixture = updateFixture(test, DELETED.files, { between: DELETED.between, merge: true })
    const result = runUpdate(fixture, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: patch-deletes-file: ${A} is listed in ${MANIFEST_PATH}, but the pre-merge state `)
    expect(result.output).not.toContain('ENOENT')
    expect(ledgerOf(fixture).upstream.ref).toBe('v1')
  }, PROCESS_TIMEOUT_MS)
})

describe('the ledger path rule', () => {
  /**
   * A ledger whose one listed entry names a path.
   * @param path - the path.
   * @returns the ledger's JSON text.
   */
  function ledgerWith(path: string): string {
    return JSON.stringify({
      upstream: { repository: 'https://example.invalid/upstream.git', ref: 'v1', commit: '0'.repeat(40) },
      forkOwned: ['delo/'],
      patches: [{ path, class: 'delo-feature', reason: 'a reason' }],
      retired: [],
    })
  }

  it('refuses a listed path that is absolute, climbs out of the repository, or carries a control character', () => {
    for (const path of ['/etc/passwd', '../outside.md', 'docs/../a.md', 'docs/a.md\n', 'docs/\ta.md', '..']) {
      expect(() => parseManifest(ledgerWith(path)), path).toThrow(/repository-relative path/)
    }
    expect(parseManifest(ledgerWith(A)).patches[0]?.path).toBe(A)
    const retired = { path: '../outside.md', reason: 'absorbed', upstreamCommit: '0'.repeat(40), hunks: 1 }
    expect(() => parseManifest(JSON.stringify({ ...JSON.parse(ledgerWith(A)), patches: [], retired: [retired] })))
      .toThrow(/repository-relative path/)
  })

  it('refuses a ledger naming such a path before any check reads the object store', (test) => {
    const fixture = updateFixture(test, {
      base: { [A]: lines(30) },
      tag: { [A]: lines(30, { 20: 'upstream 20' }) },
      fork: { [A]: lines(30, { 5: 'delo 5' }) },
      patches: [patch(A)],
    }, {
      between: fork => rewriteLedger(fork, ledger => {
        ledger.patches = [{ ...patch('../outside.md'), sha256: 'a'.repeat(64) }]
      }),
    })
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(2)
    expect(result.output).toContain('upstream-update: ledger-invalid:')
    expect(result.output).toContain('repository-relative path')
  }, PROCESS_TIMEOUT_MS)
})

describe('the refusals of the update path', () => {
  it('refuses a patch the target no longer takes, and leaves the ledger alone', (test) => {
    const fixture = updateFixture(test, CONFLICTS)
    const before = ledgerOf(fixture)
    const result = runUpdate(fixture, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: patch-does-not-apply: ${GATE} no longer applies to v2`)
    expect(result.output).not.toContain('lead\'s verdict')
    expect(ledgerOf(fixture)).toEqual(before)
    expect(leftoverScratch(fixture)).toEqual([])
  }, PROCESS_TIMEOUT_MS)

  it('names a security-class patch that no longer applies as needing a lead decision', (test) => {
    const result = runIn(test, { ...CONFLICTS, patches: [patch(GATE, 'security')] }, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('a security-class change that needs a lead\'s verdict')
  }, PROCESS_TIMEOUT_MS)

  it('refuses a security digest that drifted from the file at HEAD', (test) => {
    const fixture = updateFixture(test, CARRIES_SECURITY)
    fixture.fork.commit({ [A]: lines(30, { 5: 'delo 5, edited after the record' }) })
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: checksum-drift: ${A}: recorded sha256 `)
    expect(ledgerOf(fixture).upstream.ref).toBe('v1')
  }, PROCESS_TIMEOUT_MS)

  it('carries a feature entry whose file changed after it was listed, because only security entries record a digest', (test) => {
    const fixture = updateFixture(test, CARRIES)
    fixture.fork.commit({ [A]: lines(30, { 5: 'delo 5, edited after it was listed' }) })
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('carried: 1 entry, 1 hunk')
  }, PROCESS_TIMEOUT_MS)

  it('refuses a security entry whose checksum is not recorded', (test) => {
    const result = runIn(test, CARRIES_SECURITY, ['--tag', 'v2'], { record: false })
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: ledger-inconsistent: ${A}: a security entry records the sha256 of its file; run \`ledger-record.ts\``)
  }, PROCESS_TIMEOUT_MS)

  it('refuses when the pinned tag is not in the clone', (test) => {
    const result = runIn(test, CARRIES, ['--tag', 'v2'], { ref: 'v9' })
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('upstream-update: baseline-tag-missing: the ledger pins v9, which is not in this clone')
  }, PROCESS_TIMEOUT_MS)

  it('refuses when the pinned tag names another commit than the ledger records', (test) => {
    const result = runIn(test, CARRIES, ['--tag', 'v2'], { commit: '0'.repeat(40) })
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('upstream-update: baseline-commit-mismatch: the ledger pins v1 at ' + '0'.repeat(40))
    expect(result.output).toContain('but the tag in this clone names')
  }, PROCESS_TIMEOUT_MS)

  it('refuses a ledger that does not describe the checkout', (test) => {
    const result = runIn(test, {
      base: { [A]: lines(30) },
      tag: { [A]: lines(30, { 20: 'upstream 20' }) },
      fork: { [A]: lines(30) },
      patches: [patch(A)],
    }, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`upstream-update: ledger-inconsistent: ${A}: listed patch no longer differs from upstream; remove the entry`)
  }, PROCESS_TIMEOUT_MS)

  it('refuses to write before the release merge is in HEAD', (test) => {
    const result = runIn(test, CARRIES, ['--tag', 'v2', '--write'])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('upstream-update: merge-not-landed: v2 (')
    expect(result.output).toContain('is not in HEAD\'s history; merge the release, then run the same command with --write')
  }, PROCESS_TIMEOUT_MS)

  it('refuses a carried ledger whose recorded digest the applied tree does not have', (test) => {
    const repo = scratchRepo(test)
    const target = repo.commit({ [A]: lines(30) })
    const applied = lines(30, { 5: 'delo 5' })
    repo.write({ [A]: applied })
    const manifest: PatchManifest = {
      upstream: { repository: 'https://example.invalid/upstream.git', ref: 'v2', commit: target },
      forkOwned: ['delo/'],
      rules: [],
      patches: [{ path: A, class: 'security', reason: 'a reason', sha256: patchDigest('another file\n') }],
      retired: [],
    }
    expect(verifyApplied(manifest, repo.root, target, [A], [])).toEqual([{
      code: 'verification-failed',
      message: `the applied tree and the carried ledger disagree: ${A}: recorded sha256 ${patchDigest('another file\n')}, but the file is ${patchDigest(applied)}`,
    }])
  })

  it('refuses an applied tree with a change the carried ledger does not list', (test) => {
    const repo = scratchRepo(test)
    const target = repo.commit({ [A]: lines(30) })
    repo.write({ [A]: lines(30, { 5: 'delo 5' }) })
    const manifest: PatchManifest = {
      upstream: { repository: 'https://example.invalid/upstream.git', ref: 'v2', commit: target },
      forkOwned: ['delo/'],
      rules: [],
      patches: [],
      retired: [],
    }
    expect(verifyApplied(manifest, repo.root, target, [], [])).toEqual([{
      code: 'verification-failed',
      message: `the applied tree and the carried ledger disagree: ${A}: modified upstream file is not listed in ${MANIFEST_PATH} and no path rule covers it`,
    }])
  })

  it('refuses a carried ledger the entry rules would reject', () => {
    const listed = 'delo/notes.ts'
    const manifest: PatchManifest = {
      upstream: { repository: 'https://example.invalid/upstream.git', ref: 'v1', commit: '0'.repeat(40) },
      forkOwned: ['delo/'],
      rules: [],
      patches: [{ path: listed, class: 'delo-feature', feature: 'a-feature', reason: 'a reason' }],
      retired: [],
    }
    const { refusals } = carriedLedger(manifest, 'v2', '1'.repeat(40), [
      { path: listed, class: 'delo-feature', hunks: 1 },
    ], [])
    expect(refusals).toEqual([{
      code: 'verification-failed',
      message: `the carried ledger would not hold: ${listed}: fork-owned paths are not ledger entries; remove the entry`,
    }])
  })

  it('refuses a patch the carried ledger neither carries nor retires', (test) => {
    const repo = scratchRepo(test)
    const target = repo.commit({ [A]: lines(30) })
    const manifest: PatchManifest = {
      upstream: { repository: 'https://example.invalid/upstream.git', ref: 'v2', commit: target },
      forkOwned: ['delo/'],
      rules: [],
      patches: [],
      retired: [],
    }
    expect(verifyApplied(manifest, repo.root, target, [A], [])).toEqual([{
      code: 'verification-failed',
      message: `the applied tree and the carried ledger disagree: ${A}: listed in the ledger, but the applied tree neither carries it nor absorbed it`,
    }])
  })
})

describe('the checksum record', () => {
  it('reports the digest of text, so a changed byte changes the record', () => {
    expect(patchDigest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(patchDigest('abc\n')).not.toBe(patchDigest('abc'))
  })

  it('reports a recorded security digest that no file answers for, and one that differs', () => {
    const manifest = {
      upstream: { repository: 'https://example.invalid/upstream.git', ref: 'v1', commit: '0'.repeat(40) },
      forkOwned: ['delo/'],
      rules: [],
      patches: [
        { path: A, class: 'security' as const, reason: 'a', sha256: 'a'.repeat(64) },
        { path: B, class: 'security' as const, reason: 'b', sha256: 'b'.repeat(64) },
        { path: 'docs/c.md', class: 'delo-feature' as const, feature: 'c', reason: 'c' },
      ],
      retired: [],
    } satisfies PatchManifest
    const errors = digestErrors(manifest, new Map([[A, 'c'.repeat(64)], ['docs/c.md', patchDigest('c')]]))
    expect(errors).toEqual([
      `${A}: recorded sha256 ${'a'.repeat(64)}, but the file is ${'c'.repeat(64)}`,
      `${B}: recorded sha256 ${'b'.repeat(64)} cannot be checked, because the path holds no file to read`,
    ])
    expect(parseManifest(JSON.stringify(manifest)).patches[2]?.sha256).toBeUndefined()
  })
})

describe('the command line', () => {
  it('prints the usage line without a tag, and for an unknown option', (test) => {
    const fixture: UpdateFixture = updateFixture(test, CARRIES)
    expect(runUpdate(fixture, []).status).toBe(2)
    expect(runUpdate(fixture, []).output).toContain('usage: upstream-update.ts --tag <tag> [--write]')
    expect(runUpdate(fixture, ['--record']).status).toBe(2)
  }, PROCESS_TIMEOUT_MS)

  it('exits 2 when the tag is not in the clone', (test) => {
    const result = runIn(test, CARRIES, ['--tag', 'v9'])
    expect(result.status, result.output).toBe(2)
    expect(result.output).toContain('upstream-update: target-tag-missing: tag v9 is not in this clone')
  }, PROCESS_TIMEOUT_MS)

  it('leaves an edited working tree untouched when it refuses', (test) => {
    const fixture = updateFixture(test, CONFLICTS)
    fixture.fork.write({ [GATE]: lines(30, { 5: 'delo 5', 6: 'unstaged 6' }), 'notes/dirty.txt': 'dirty\n' })
    fixture.fork.run(['add', GATE])
    fixture.fork.write({ [GATE]: lines(30, { 5: 'delo 5', 6: 'staged 6', 7: 'unstaged 7' }) })
    const before = checkoutState(fixture.fork)
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(1)
    expect(checkoutState(fixture.fork)).toEqual(before)
  }, PROCESS_TIMEOUT_MS)

  it('sweeps a worktree a killed run left registered in the clone', (test) => {
    const fixture = updateFixture(test, CARRIES)
    const leaked = join(fixture.temp, 'delo-update-killed', 'tree')
    mkdirSync(dirname(leaked), { recursive: true })
    fixture.fork.run(['worktree', 'add', '--detach', '--quiet', leaked, 'v2'])
    expect(fixture.fork.run(['worktree', 'list', '--porcelain'])).toContain(leaked)
    const result = runUpdate(fixture, ['--tag', 'v2'])
    expect(result.status, result.output).toBe(0)
    expect(fixture.fork.run(['worktree', 'list', '--porcelain'])).not.toContain('delo-update-killed')
    expect(existsSync(leaked)).toBe(false)
    expect(leftoverScratch(fixture)).toEqual([])
  }, PROCESS_TIMEOUT_MS)
})
