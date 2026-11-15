import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { TestContext } from 'vitest'
import { describe, expect, it } from 'vitest'
import { BRIEF_FIELDS, parseBriefs, renderBody } from '../../src/issues/brief.ts'
import { LABELS_PATH, parseLabels } from '../../src/issues/labels.ts'
import { referenceContext } from '../../src/issues/references.ts'
import { REPO, runTsx, scratchRepo, type Scratch } from '../gates/support.ts'

const ISSUES = join(REPO, 'delorun/apps/tools/src/issues/issues.ts')
const FIXTURE_PATH = 'delorun/apps/tools/tests/issues/fixtures/briefs.valid.json'
const REPOSITORY = 'Delo-Run/delorun'
const FIXTURE_TEXT = readFileSync(join(REPO, FIXTURE_PATH), 'utf8')
const LABELS_TEXT = readFileSync(join(REPO, LABELS_PATH), 'utf8')

/** The fixture brief as a plain object, from the fixture file. */
const FIXTURE: Record<string, unknown> = JSON.parse(FIXTURE_TEXT)[0]

/** The files a scratch repository tracks, which the brief references resolve against. */
const PLANTED: Record<string, string> = {
  'AGENTS.md': '# AGENTS\n',
  'delorun/docs/contracts/README.md': '# Contracts\n',
  'delorun/apps/tools/README.md': '# Tools\n',
  'delorun/apps/tools/src/issues/brief.ts': '// placeholder\n',
  'delorun/apps/tools/src/issues/issues.ts': '// placeholder\n',
  'delorun/apps/tools/src/checks/gates/doc-times.ts': '// placeholder\n',
  [FIXTURE_PATH]: FIXTURE_TEXT,
  [LABELS_PATH]: LABELS_TEXT,
}

/** The reference context that a run in a scratch repository with the planted files builds. */
const PLANTED_CONTEXT = referenceContext(Object.keys(PLANTED), () => false)

/**
 * A scratch repository that tracks the planted files, so the brief references resolve as they do in a working tree.
 * @param test - the running test.
 * @returns the repository.
 */
function briefRepo(test: TestContext): Scratch {
  const repo = scratchRepo(test)
  repo.commit(PLANTED)
  return repo
}

/**
 * Write a briefs file into a repository, untracked, and return its path.
 * @param repo - the repository.
 * @param briefs - the briefs to write, as plain objects.
 * @returns the file's absolute path.
 */
function writeBriefs(repo: Scratch, briefs: readonly Record<string, unknown>[]): string {
  const path = join(repo.root, 'briefs.json')
  writeFileSync(path, JSON.stringify(briefs))
  return path
}

/** One issue as the fake `gh` reports it. */
interface IssueFixture {
  /** The issue number. */
  readonly number: number
  /** The issue title. */
  readonly title: string
  /** Whether the issue's conversation is locked. */
  readonly locked: boolean
}

interface FakeOptions {
  /** The permissions that `gh api repos/...` reports for the signed-in user. */
  readonly permissions?: Record<string, boolean>
  /** The issues that `gh issue list` and `gh api repos/.../issues/<n>` report. */
  readonly issues?: readonly IssueFixture[]
  /** Makes `gh api user` fail, as an unauthenticated gh does. */
  readonly signedOut?: boolean
}

interface FakeGh {
  /** The variables to add to the environment of a run, which put the fake first on PATH. */
  readonly env: Record<string, string>
  /** Each `gh` call so far, as its arguments. */
  readonly calls: () => string[][]
  /** The body file that `gh issue create` read, by issue number. */
  readonly body: (number: number) => string
  /** Replace the issues that the fake reports from now on. */
  readonly setIssues: (issues: readonly IssueFixture[]) => void
  /** Make `gh issue lock` refuse from now on, or accept again. */
  readonly failLocks: (on: boolean) => void
}

/** The fake `gh`: a POSIX shell script that logs its arguments and replies from files in its state directory. */
const FAKE_GH = `#!/bin/sh
STATE='__STATE__'
{ for arg in "$@"; do printf '%s\\037' "$arg"; done; printf '\\n'; } >> "$STATE/calls.log"
case "$1 $2" in
  "api user") cat "$STATE/user.json" ;;
  "api repos/__REPO__") cat "$STATE/repo.json" ;;
  "api repos/__REPO__/issues/"*) number="\${2##*/}"; cat "$STATE/issue-$number.json" ;;
  "issue list") cat "$STATE/titles.json" ;;
  "issue create")
    number=$(cat "$STATE/counter")
    number=$((number + 1))
    echo "$number" > "$STATE/counter"
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "--body-file" ]; then cp "$arg" "$STATE/body-$number.md"; fi
      previous="$arg"
    done
    echo "https://github.com/__REPO__/issues/$number" ;;
  "issue lock")
    if [ -f "$STATE/fail-lock" ]; then echo "fake gh: lock refused" >&2; exit 4; fi ;;
  "label create") ;;
  *) echo "fake gh: no reply for: $*" >&2; exit 3 ;;
esac
`

/**
 * Install a fake `gh` on a temporary PATH directory, with the replies that the options set.
 * @param test - the running test, whose teardown removes the directories.
 * @param options - the replies to give.
 * @returns the environment for a run, and accessors for the calls, the bodies and the replies.
 */
function fakeGh(test: TestContext, options: FakeOptions = {}): FakeGh {
  const state = mkdtempSync(join(tmpdir(), 'delorun-gh-state-'))
  const bin = mkdtempSync(join(tmpdir(), 'delorun-gh-bin-'))
  test.onTestFinished(() => {
    rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    rmSync(bin, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  if (options.signedOut !== true) writeFileSync(join(state, 'user.json'), JSON.stringify({ login: 'maintainer' }))
  writeFileSync(join(state, 'repo.json'), JSON.stringify({
    full_name: REPOSITORY,
    permissions: options.permissions ?? { admin: false, maintain: true, push: true, triage: true, pull: true },
  }))
  writeFileSync(join(state, 'counter'), '100\n')
  writeFileSync(join(bin, 'gh'), FAKE_GH.split('__STATE__').join(state).split('__REPO__').join(REPOSITORY), { mode: 0o755 })
  const gh: FakeGh = {
    // A real gh that somehow ran would address a host that does not resolve, with a token that is not a credential.
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      GH_HOST: 'guard.invalid',
      GH_TOKEN: 'guard-not-a-credential',
    },
    calls: () => callsOf(join(state, 'calls.log')),
    body: number => readFileSync(join(state, `body-${String(number)}.md`), 'utf8'),
    setIssues: issues => {
      writeFileSync(join(state, 'titles.json'), JSON.stringify(issues.map(({ number, title }) => ({ number, title }))))
      for (const issue of issues) {
        writeFileSync(join(state, `issue-${String(issue.number)}.json`), JSON.stringify({ number: issue.number, locked: issue.locked }))
      }
    },
    failLocks: on => {
      if (on) writeFileSync(join(state, 'fail-lock'), '')
      else rmSync(join(state, 'fail-lock'), { force: true })
    },
  }
  gh.setIssues(options.issues ?? [])
  return gh
}

/**
 * The calls a fake `gh` logged, one array of arguments per call.
 * @param log - the log file.
 * @returns the arguments of each call, in order; empty when no call was logged.
 */
function callsOf(log: string): string[][] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => line.split('\x1f').slice(0, -1))
}

/**
 * Run the issue tool in a repository, with the fake `gh` first on PATH so that no run reaches GitHub.
 * @param repo - the repository the run starts in.
 * @param args - the command-line arguments.
 * @param gh - the fake whose environment the run uses.
 * @returns the exit status and the combined output.
 */
function issues(repo: Scratch, args: readonly string[], gh: FakeGh): { status: number; output: string } {
  return runTsx(repo.root, ISSUES, [...args], gh.env)
}

describe('issues.ts --dry-run', () => {
  it('prints each body with its fields under headings in the template order, linked to main, and exits 0', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test)
    const result = issues(repo, ['--input', join(repo.root, FIXTURE_PATH), '--dry-run'], gh)
    expect(result.status).toBe(0)
    const headings = result.output.split('\n').filter(line => line.startsWith('### ')).map(line => line.slice(4))
    expect(headings).toEqual([...BRIEF_FIELDS])
    expect(result.output).toContain('== Fixture: a brief that passes the generator ==')
    expect(result.output).toContain('[`AGENTS.md`](https://github.com/Delo-Run/delorun/blob/main/AGENTS.md)')
  })

  it('exits 1 and prints no body when a brief has a problem', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test)
    const bad = writeBriefs(repo, [{ ...FIXTURE, Steps: 'Read `delorun/docs/plans/x.md`.' }])
    const result = issues(repo, ['--input', bad, '--dry-run'], gh)
    expect(result.status).toBe(1)
    expect(result.output).toContain('names delorun/docs/plans, a private plan page')
    expect(result.output).toContain('no body was printed')
    expect(result.output).not.toContain('### Package')
  })

  it('exits 1 for an unreadable briefs file, and for a command line that combines modes', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test)
    expect(issues(repo, ['--input', join(repo.root, 'missing.json'), '--dry-run'], gh).status).toBe(1)
    const combined = issues(repo, ['--input', join(repo.root, FIXTURE_PATH), '--dry-run', '--create', '--repo', REPOSITORY], gh)
    expect(combined.status).toBe(1)
    expect(combined.output).toContain('choose exactly one mode')
    expect(combined.output).toContain('usage: issues.ts')
  })

  it('refuses options that a mode does not take, and a malformed repository', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test)
    expect(issues(repo, ['--input', join(repo.root, FIXTURE_PATH), '--dry-run', '--repo', REPOSITORY], gh).output).toContain('--dry-run takes no --repo')
    expect(issues(repo, ['--sync-labels', '--input', FIXTURE_PATH, '--repo', REPOSITORY], gh).output).toContain('--sync-labels takes no --input')
    expect(issues(repo, ['--sync-labels', '--repo', 'not-a-repository'], gh).output).toContain('--repo expects owner/name')
    expect(issues(repo, ['--sync-labels'], gh).output).toContain('this mode needs --repo <owner/name>')
    expect(gh.calls()).toEqual([])
  })
})

describe('issues.ts --create', () => {
  it('skips a brief whose issue is locked, creates the others, locks each new one, and sends the linked body', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test, { issues: [{ number: 7, title: 'Existing brief', locked: true }] })
    const existing = { ...FIXTURE, title: 'Existing brief' }
    const fresh = { ...FIXTURE, title: 'New brief' }
    const result = issues(repo, ['--input', writeBriefs(repo, [existing, fresh]), '--create', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(0)
    expect(result.output).toContain('skipped: "Existing brief" already exists as #7 and is locked')
    expect(result.output).toContain('created: #101 "New brief"')
    expect(result.output).toContain('locked: #101')

    const calls = gh.calls()
    expect(calls.slice(0, 3)).toEqual([
      ['api', 'user'],
      ['api', `repos/${REPOSITORY}`],
      ['issue', 'list', '--repo', REPOSITORY, '--state', 'all', '--limit', '1000', '--json', 'number,title'],
    ])
    const create = calls.find(call => call[0] === 'issue' && call[1] === 'create')
    expect(create).toEqual([
      'issue', 'create', '--repo', REPOSITORY, '--title', 'New brief', '--body-file', expect.any(String),
      '--label', 'brief', '--label', 'area/tools', '--label', 'wave/0', '--milestone', 'Wave 0',
    ])
    expect(calls.filter(call => call[1] === 'create')).toHaveLength(1)
    expect(calls.at(-1)).toEqual(['issue', 'lock', '101', '--repo', REPOSITORY])
    const [freshBrief] = parseBriefs(JSON.stringify([fresh])).briefs
    expect(freshBrief).toBeDefined()
    if (freshBrief !== undefined) expect(gh.body(101)).toBe(renderBody(freshBrief, PLANTED_CONTEXT))
  })

  it('locks an existing unlocked issue that carries a brief title, and creates nothing for it', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test, { issues: [{ number: 7, title: 'Existing brief', locked: false }] })
    const result = issues(repo, ['--input', writeBriefs(repo, [{ ...FIXTURE, title: 'Existing brief' }]), '--create', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(0)
    expect(result.output).toContain('locked: #7 "Existing brief" already existed')
    expect(gh.calls()).toContainEqual(['issue', 'lock', '7', '--repo', REPOSITORY])
    expect(gh.calls().filter(call => call[1] === 'create')).toEqual([])
  })

  it('finishes an interrupted run: the issue created before a lock failed is locked by the rerun, with no second issue', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test)
    const input = writeBriefs(repo, [FIXTURE])
    gh.failLocks(true)
    const first = issues(repo, ['--input', input, '--create', '--repo', REPOSITORY], gh)
    expect(first.status).toBe(1)
    expect(first.output).toContain('created: #101')
    expect(first.output).toContain('exited 4')

    // GitHub now lists the created issue, and it is unlocked.
    gh.setIssues([{ number: 101, title: String(FIXTURE.title), locked: false }])
    gh.failLocks(false)
    const second = issues(repo, ['--input', input, '--create', '--repo', REPOSITORY], gh)
    expect(second.status).toBe(0)
    expect(second.output).toContain('locked: #101 "Fixture: a brief that passes the generator" already existed')
    expect(gh.calls().filter(call => call[1] === 'create')).toHaveLength(1)
    expect(gh.calls().at(-1)).toEqual(['issue', 'lock', '101', '--repo', REPOSITORY])
  })

  it('refuses a title that two issues share, before any write', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test, {
      issues: [
        { number: 7, title: 'Duplicated brief', locked: true },
        { number: 8, title: 'Duplicated brief', locked: false },
      ],
    })
    const result = issues(repo, ['--input', writeBriefs(repo, [{ ...FIXTURE, title: 'Duplicated brief' }]), '--create', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(1)
    expect(result.output).toContain('"Duplicated brief" is the title of issues #7 and #8')
    expect(gh.calls().map(call => call[1])).not.toContain('create')
    expect(gh.calls().map(call => call[1])).not.toContain('lock')
  })

  it('refuses when the signed-in user holds only read permission, and creates nothing', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test, { permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } })
    const result = issues(repo, ['--input', writeBriefs(repo, [FIXTURE]), '--create', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(1)
    expect(result.output).toContain('neither maintain nor admin permission')
    expect(gh.calls().map(call => call[1])).not.toContain('create')
    expect(gh.calls().map(call => call[1])).not.toContain('lock')
  })

  it('checks the briefs before any gh call, so an invalid file makes no call', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test)
    const duplicate = writeBriefs(repo, [FIXTURE, FIXTURE])
    const result = issues(repo, ['--input', duplicate, '--create', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(1)
    expect(result.output).toContain('repeats briefs[0]')
    expect(gh.calls()).toEqual([])
  })

  it('stops with gh\'s error when gh cannot read the signed-in user', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test, { signedOut: true })
    const result = issues(repo, ['--input', writeBriefs(repo, [FIXTURE]), '--create', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(1)
    expect(result.output).toContain('gh api user exited')
    expect(gh.calls().map(call => call[1])).not.toContain('create')
  })

  it('refuses to check the titles when the listing reaches the limit, because it could hide a brief\'s issue', (test) => {
    const repo = briefRepo(test)
    const issuesAtLimit = Array.from({ length: 1000 }, (_, index) => ({ number: index + 1, title: `Issue ${String(index)}`, locked: false }))
    const gh = fakeGh(test, { issues: issuesAtLimit })
    const result = issues(repo, ['--input', writeBriefs(repo, [FIXTURE]), '--create', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(1)
    expect(result.output).toContain('the title check reads only that many')
    expect(gh.calls().map(call => call[1])).not.toContain('create')
  })

  it('needs --repo', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test)
    const result = issues(repo, ['--input', writeBriefs(repo, [FIXTURE]), '--create'], gh)
    expect(result.status).toBe(1)
    expect(result.output).toContain('this mode needs --repo <owner/name>')
    expect(gh.calls()).toEqual([])
  })
})

describe('issues.ts --sync-labels', () => {
  it('creates or updates every label of the label file with --force, after the maintainer check', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test)
    const result = issues(repo, ['--sync-labels', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(0)
    const labels = parseLabels(LABELS_TEXT).labels
    expect(result.output.split('\n').filter(line => line.startsWith('synced: '))).toHaveLength(labels.length)
    const labelCalls = gh.calls().filter(call => call[0] === 'label')
    expect(labelCalls).toHaveLength(labels.length)
    expect(labelCalls[0]).toEqual([
      'label', 'create', labels[0]?.name ?? '', '--repo', REPOSITORY, '--color', labels[0]?.color ?? '',
      '--description', labels[0]?.description ?? '', '--force',
    ])
  })

  it('refuses for a signed-in user without maintain or admin permission, and changes no label', (test) => {
    const repo = briefRepo(test)
    const gh = fakeGh(test, { permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } })
    const result = issues(repo, ['--sync-labels', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(1)
    expect(gh.calls().filter(call => call[0] === 'label')).toEqual([])
  })

  it('refuses a label file that the label rules reject, before any gh call', (test) => {
    const repo = scratchRepo(test)
    repo.commit({ '.github/labels.yml': '- name: kind/bug\n  color: "d73a4a"\n  description: "Retired alias."\n' })
    const gh = fakeGh(test)
    const result = issues(repo, ['--sync-labels', '--repo', REPOSITORY], gh)
    expect(result.status).toBe(1)
    expect(result.output).toContain('is a retired alias')
    expect(gh.calls()).toEqual([])
  })
})
