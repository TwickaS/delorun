import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRIEF_FIELDS, briefErrors, parseBriefs, renderBody, type BriefContext } from '../../src/issues/brief.ts'
import { referenceContext } from '../../src/issues/references.ts'

/** The paths the fixture names, all tracked in this test's tree. */
const TRACKED = [
  'AGENTS.md',
  'delorun/docs/contracts/README.md',
  'delorun/apps/tools/README.md',
  'delorun/apps/tools/src/issues/brief.ts',
  'delorun/apps/tools/src/issues/issues.ts',
  'delorun/apps/tools/src/checks/gates/doc-times.ts',
  'delorun/apps/tools/tests/issues/fixtures/briefs.valid.json',
  'delorun/docs/plans/private-plan.md',
  '.github/labels.yml',
]

/** The directories that exist in the working tree without tracked files. */
const UNTRACKED_DIRECTORIES: ReadonlySet<string> = new Set(['scratch'])

const CONTEXT: BriefContext = {
  ...referenceContext(TRACKED, directory => UNTRACKED_DIRECTORIES.has(directory)),
  labels: new Set(['brief', 'area/tools', 'area/cli', 'wave/0', 'kind/feature']),
}

const FIXTURE_TEXT = readFileSync(new URL('./fixtures/briefs.valid.json', import.meta.url), 'utf8')
const FIXTURE: Record<string, unknown> = JSON.parse(FIXTURE_TEXT)[0]

/**
 * The briefs file text for a brief built from the fixture, with some fields changed, and further briefs after it.
 * @param changes - fields to set; an `undefined` value removes the field.
 * @param others - briefs appended after the changed one.
 * @returns the JSON text of the briefs file.
 */
function briefsWith(changes: Record<string, unknown>, others: Record<string, unknown>[] = []): string {
  const brief: Record<string, unknown> = { ...FIXTURE }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete brief[key]
    else brief[key] = value
  }
  return JSON.stringify([brief, ...others])
}

/**
 * The problems of a briefs file text: its parse problems, or else its brief problems.
 * @param text - the briefs file text.
 * @returns the messages.
 */
function problemsOf(text: string): string[] {
  const parsed = parseBriefs(text)
  return parsed.errors.length > 0 ? parsed.errors : briefErrors(parsed.briefs, CONTEXT)
}

describe('a briefs file', () => {
  it('passes for the fixture brief', () => {
    const parsed = parseBriefs(FIXTURE_TEXT)
    expect(parsed.errors).toEqual([])
    expect(parsed.briefs).toHaveLength(1)
    expect(briefErrors(parsed.briefs, CONTEXT)).toEqual([])
  })

  it('names a missing field and a blank field by position', () => {
    expect(problemsOf(briefsWith({ Goal: undefined }))).toEqual(['briefs[0].Goal is missing'])
    expect(problemsOf(briefsWith({ Steps: '   ' }))).toEqual(['briefs[0].Steps is empty'])
    expect(problemsOf(briefsWith({ milestone: undefined }))).toEqual(['briefs[0].milestone is missing'])
  })

  it('refuses a misspelt field name as an unknown key, so it is not taken for a missing field', () => {
    expect(problemsOf(briefsWith({ Acceptance: undefined, Acceptence: 'typo' }))).toEqual([
      'briefs[0].Acceptance is missing',
      'briefs[0]: unknown key(s) Acceptence',
    ])
  })

  it('refuses text that is not JSON, an empty array and a value that is not an array', () => {
    expect(parseBriefs('{').errors[0]).toMatch(/^the briefs file is not JSON/u)
    expect(parseBriefs('[]').errors).toEqual(['the briefs file holds no briefs'])
    expect(parseBriefs('{}').errors[0]).toMatch(/^briefs /u)
  })

  it('refuses a model outside the template values, and Opus at max effort in particular', () => {
    expect(problemsOf(briefsWith({ Model: 'Opus at max effort' }))).toEqual([
      'briefs[0]: Model "Opus at max effort" is not allowed; use one of: Haiku at medium effort, Haiku at high effort, Haiku at max effort, Opus at medium effort, Opus at high effort',
    ])
  })

  it('refuses a private plan path in any field', () => {
    expect(problemsOf(briefsWith({ Steps: 'Read `delorun/docs/plans/private-plan.md` first.' }))).toEqual([
      'briefs[0]: Steps: names delorun/docs/plans, a private plan page that no brief links',
      'briefs[0]: Steps: "delorun/docs/plans/private-plan.md" names delorun/docs/plans, a private plan page',
    ])
  })

  it('refuses a backticked path or a link that the tree does not track', () => {
    expect(problemsOf(briefsWith({ Interfaces: 'The new `delorun/apps/tools/src/issues/new.ts`.' }))).toEqual([
      'briefs[0]: Interfaces: "delorun/apps/tools/src/issues/new.ts" is not a tracked file or directory',
    ])
    expect(problemsOf(briefsWith({ 'Read first': 'See [the plan](delorun/docs/contracts/missing.md).' }))).toEqual([
      'briefs[0]: Read first: link "delorun/docs/contracts/missing.md" is not a tracked file or directory',
    ])
  })

  it('accepts a new file under a tracked directory in You own, and refuses the same file in Interfaces', () => {
    expect(problemsOf(briefsWith({ 'You own': 'Create `delorun/apps/tools/src/issues/new-module.ts`; change nothing else.' }))).toEqual([])
    expect(problemsOf(briefsWith({ Interfaces: 'The new `delorun/apps/tools/src/issues/new-module.ts`.' }))).toEqual([
      'briefs[0]: Interfaces: "delorun/apps/tools/src/issues/new-module.ts" is not a tracked file or directory',
    ])
  })

  it('refuses a new file under a directory that exists in the working tree without tracked files, in You own', () => {
    expect(problemsOf(briefsWith({ 'You own': 'Create `scratch/notes/a.ts`.' }))).toEqual([
      'briefs[0]: You own: "scratch/notes/a.ts" is new, and no tracked directory is its nearest existing parent',
    ])
  })

  it('refuses an http link, a link into another repository and a machine path', () => {
    expect(problemsOf(briefsWith({ Report: 'See http://github.com/Delo-Run/delo/issues/1.' }))).toEqual([
      'briefs[0]: Report: link "http://github.com/Delo-Run/delo/issues/1" must be an https URL without credentials or a port',
    ])
    expect(problemsOf(briefsWith({ Report: 'See https://github.com/deepseek-ai/deepseek-harness.' }))).toEqual([
      'briefs[0]: Report: link "https://github.com/deepseek-ai/deepseek-harness" must point into github.com/Delo-Run/delo',
    ])
    expect(problemsOf(briefsWith({ 'Repository and branch': 'In /home/owner/worktree/issues here.' }))).toEqual([
      'briefs[0]: Repository and branch: "/home/owner/worktree/issues" is a machine or home path; a brief names repository paths only',
    ])
  })

  it('refuses a label that the label file does not define, and a brief without the brief label', () => {
    expect(problemsOf(briefsWith({ labels: ['brief', 'area/nope'] }))).toEqual([
      'briefs[0]: label "area/nope" is not defined in .github/labels.yml',
    ])
    expect(problemsOf(briefsWith({ labels: ['area/tools'] }))).toEqual(['briefs[0]: labels must include "brief"'])
  })

  it('refuses a kind label on a brief, because an issue carries its native Issue Type instead', () => {
    expect(problemsOf(briefsWith({ labels: ['brief', 'kind/feature'] }))).toEqual([
      'briefs[0]: label "kind/feature" marks a pull request; an issue carries its native Issue Type instead',
    ])
  })

  it('refuses two briefs with the same title, and names the first', () => {
    expect(problemsOf(briefsWith({}, [{ ...FIXTURE, Goal: 'Another goal.' }]))).toEqual([
      'briefs[1]: title "Fixture: a brief that passes the generator" repeats briefs[0]',
    ])
  })

  it('refuses a field that would add a heading to the issue body', () => {
    expect(problemsOf(briefsWith({ Steps: '1. Read it.\n### Never\nPush.' }))).toEqual([
      'briefs[0]: Steps: a line is a Markdown heading; a field cannot add a heading to the issue body',
    ])
  })

  it('refuses a title on more than one line, and a title longer than GitHub allows', () => {
    expect(problemsOf(briefsWith({ title: 'First line\nSecond line' }))).toEqual(['briefs[0]: title is not one line'])
    expect(parseBriefs(briefsWith({ title: 'x'.repeat(257) })).errors).toEqual([
      'briefs[0].title is longer than 256 characters',
    ])
  })
})

describe('the rendered issue body', () => {
  it('has every field heading in the template order, with its value under it', () => {
    const [brief] = parseBriefs(FIXTURE_TEXT).briefs
    expect(brief).toBeDefined()
    if (brief === undefined) return
    const body = renderBody(brief, CONTEXT)
    const headings = body.split('\n').filter(line => line.startsWith('### ')).map(line => line.slice(4))
    expect(headings).toEqual([...BRIEF_FIELDS])
    expect(body).toContain('### Model\n\nHaiku at max effort\n')
    expect(body.endsWith('\n')).toBe(true)
  })

  it('links each tracked path of a field to its place on the v5 branch', () => {
    const [brief] = parseBriefs(FIXTURE_TEXT).briefs
    expect(brief).toBeDefined()
    if (brief === undefined) return
    const body = renderBody(brief, CONTEXT)
    expect(body).toContain('The root [`AGENTS.md`](https://github.com/Delo-Run/delo/blob/v5/AGENTS.md)')
    expect(body).toContain('[`delorun/apps/tools/tests/issues/fixtures/`](https://github.com/Delo-Run/delo/tree/v5/delorun/apps/tools/tests/issues/fixtures)')
    expect(body).toContain('`node_modules/.bin/tsx delorun/apps/tools/src/issues/issues.ts --input')
  })
})
