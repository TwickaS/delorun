import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEntry, CHANGELOG_SCHEMA, renderChangelog, type ChangelogData } from '../../release/src/changelog/data.ts'
import type { Fragment } from '../../release/src/changelog/fragment.ts'
import { buildView, firstSentence, loadView, PREVIEW_ENV, RECORD_PATH } from '@design/changelog.ts'
import { prerenderPaths } from '../src/site/pages.ts'

const REPOSITORY = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * A fragment with one bullet per text.
 * @param area - the area.
 * @param section - the section.
 * @param bullets - the bullet texts.
 * @returns the fragment.
 */
function fragment(area: Fragment['area'], section: Fragment['section'], ...bullets: string[]): Fragment {
  return { path: `delorun/changelog/unreleased/${area}-${section}.md`, area, section, bullets: bullets.map(text => `- ${text}`), replaces: undefined, waits: undefined }
}

const OLDER = buildEntry('0.1.0', '2026-11-01', 'dsh-v0.2.2', [fragment('Setup', 'Added', '`delorun setup` asks one question at a time.')])
const NEWER = buildEntry('0.2.0', '2026-12-01', 'dsh-v0.2.2', [
  fragment('Install and update', 'Added', '`delorun update` applies a release once you confirm. It checks the signature first.'),
  fragment('Studio', 'Added', 'The sidebar shows your chats.'),
  fragment('Studio', 'Fixed', 'A long title no longer overflows.'),
  fragment('Commands', 'Security', 'Commands refuse a path outside your home.'),
])
const RECORD: ChangelogData = {
  schema: CHANGELOG_SCHEMA,
  upstream: { ref: 'dsh-v0.2.2', commit: 'abc' },
  compared: [{ area: 'Setup', section: 'Added', text: 'Setup differs.' }],
  versions: [NEWER, OLDER],
}

const roots: string[] = []

/**
 * A scratch repository root, removed after the test.
 * @param record - the record text to write at the record's path; no record when undefined.
 * @returns the root.
 */
function scratchRoot(record: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-changelog-'))
  roots.push(root)
  if (record !== undefined) {
    mkdirSync(join(root, 'delorun/changelog'), { recursive: true })
    writeFileSync(join(root, RECORD_PATH), record)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the changelog view', () => {
  it('lists the versions newest first with their dates and areas in plain wording', () => {
    const view = buildView(RECORD)
    expect(view.versions.map(version => [version.version, version.date])).toEqual([['0.2.0', '2026-12-01'], ['0.1.0', '2026-11-01']])
    expect(view.versions[0]?.areas.map(area => area.area)).toEqual(['Install and update', 'Studio', 'Commands'])
    expect(view.versions[0]?.areas[1]?.items).toEqual([{ prefix: undefined, text: 'The sidebar shows your chats.' }, { prefix: 'Fixed', text: 'A long title no longer overflows.' }])
    expect(view.versions[0]?.fromUpstream[0]).toBe('Based on DeepSeek Harness `dsh-v0.2.2`.')
  })

  it('carries the standing comparison with the upstream release', () => {
    const { compared } = buildView(RECORD)
    expect(compared.heading).toBe('Delorun compared with DeepSeek Harness dsh-v0.2.2')
    expect(compared.areas).toEqual([{ area: 'Setup', items: [{ prefix: undefined, text: 'Setup differs.' }] }])
  })

  it('states every bullet that CHANGELOG.md renders, and no other', () => {
    const rendered = renderChangelog(RECORD)
    for (const version of buildView(RECORD).versions) {
      for (const item of version.areas.flatMap(area => area.items)) expect(rendered).toContain(item.prefix === undefined ? `- ${item.text}` : `- **${item.prefix}:** ${item.text}`)
    }
  })

  it('takes three to five first sentences as the headlines of a version', () => {
    const [latest, earliest] = buildView(RECORD).versions
    expect(latest?.headlines).toEqual(['`delorun update` applies a release once you confirm.', 'The sidebar shows your chats.', 'A long title no longer overflows.'])
    expect(earliest?.headlines).toEqual(['`delorun setup` asks one question at a time.'])
    const many = buildEntry('0.3.0', '2027-01-01', 'dsh-v0.2.2', ['Setup', 'Studio', 'Reach', 'Plugins', 'Commands', 'Compatibility', 'Install and update'].map(area => fragment(area as Fragment['area'], 'Added', `${area} changed.`)))
    expect(buildView({ ...RECORD, versions: [many] }).versions[0]?.headlines).toHaveLength(5)
  })

  it('fills the headlines from the other sections when few Added bullets exist', () => {
    const entry = buildEntry('0.3.0', '2027-01-01', 'dsh-v0.2.2', [fragment('Studio', 'Added', 'A.'), fragment('Studio', 'Fixed', 'B.'), fragment('Commands', 'Security', 'C.'), fragment('Setup', 'Changed', 'D.')])
    expect(buildView({ ...RECORD, versions: [entry] }).versions[0]?.headlines).toEqual(['A.', 'D.', 'B.'])
  })

  it('cuts a long sentence at a word and never inside a code span', () => {
    const long = `${'word '.repeat(30)}\`code span with spaces ${'x '.repeat(20)}\` tail.`
    const cut = firstSentence(long)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(161)
    expect((cut.match(/`/g) ?? []).length % 2).toBe(0)
    expect(firstSentence('Short one. Second one.')).toBe('Short one.')
  })
})

describe('loading the record', () => {
  it('yields no view when no version is assembled, so the page and the home section are omitted', () => {
    expect(loadView(scratchRoot(undefined), {})).toBeUndefined()
    expect(loadView(scratchRoot(JSON.stringify({ ...RECORD, versions: [] })), {})).toBeUndefined()
    expect(prerenderPaths(REPOSITORY, false)).not.toContain('/changelog')
    expect(prerenderPaths(REPOSITORY, false)).not.toContain('/zh/changelog')
  })

  it('reads the repository record and adds the page in both locales', () => {
    expect(loadView(scratchRoot(JSON.stringify(RECORD)), {})?.versions.map(version => version.version)).toEqual(['0.2.0', '0.1.0'])
    expect(prerenderPaths(REPOSITORY, true)).toEqual(expect.arrayContaining(['/changelog', '/zh/changelog']))
  })

  it('reads the preview record instead of the repository record, and fails when the preview file is missing', () => {
    const preview = join(scratchRoot(JSON.stringify(RECORD)), RECORD_PATH)
    expect(loadView(scratchRoot(undefined), { [PREVIEW_ENV]: preview })?.versions).toHaveLength(2)
    expect(() => loadView(scratchRoot(undefined), { [PREVIEW_ENV]: join(tmpdir(), 'no-such-docs-preview.json') })).toThrow('does not exist')
  })

  it('refuses a file that is not a changelog record', () => {
    expect(() => loadView(scratchRoot('{"schema":"other"}'), {})).toThrow('not a delorun.changelog/1 document')
  })
})
