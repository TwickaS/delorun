import { describe, expect, it } from 'vitest'
import { addVersion, buildCompared, buildEntry, CHANGELOG_SCHEMA, foldedPreviews, parseData, privatePreviewNote, publicVersions, renderChangelog, renderEntry, renderHighlights, renderNotes, replacesErrors, type ChangelogData } from '../../src/changelog/data.ts'
import type { Area, Fragment, Section } from '../../src/changelog/fragment.ts'

const UPSTREAM = { ref: 'dsh-v0.2.2-rc.1', commit: 'a'.repeat(40) }

/**
 * A parsed fragment.
 * @param name - the file name.
 * @param area - the area.
 * @param section - the section.
 * @param bullets - the bullet texts.
 * @param replaces - the file name it supersedes.
 * @returns the fragment.
 */
function fragment(name: string, area: Area, section: Section, bullets: readonly string[], replaces?: string): Fragment {
  return { path: `delorun/changelog/unreleased/${name}`, area, section, bullets: bullets.map(text => `- ${text}`), replaces, waits: undefined }
}

const FRAGMENTS = [
  fragment('b-commands.md', 'Commands', 'Fixed', ['Logs open again.']),
  fragment('a-setup.md', 'Setup', 'Added', ['Setup asks four questions.', 'Setup resumes.']),
  fragment('c-safety.md', 'Safety and privacy', 'Security', ['Fetches refuse private addresses.']),
  fragment('d-setup-gone.md', 'Setup', 'Removed', ['The old prompt is gone.']),
  fragment('e-upstream.md', 'Compatibility', 'From upstream', ['The lane streams progress.']),
  fragment('f-setup-changed.md', 'Setup', 'Changed', ['Setup is shorter.']),
]

describe('an entry', () => {
  it('groups bullets by area in the fixed order and by section inside an area, and sets From upstream apart', () => {
    const entry = buildEntry('0.1.0-preview.1', '2026-11-10', UPSTREAM.ref, FRAGMENTS)
    expect(entry.preview).toBe(true)
    expect(entry.previews).toEqual([])
    expect(entry.areas.map(area => area.area)).toEqual(['Setup', 'Safety and privacy', 'Commands'])
    expect(entry.areas[0]?.items).toEqual([
      { section: 'Added', text: 'Setup asks four questions.' },
      { section: 'Added', text: 'Setup resumes.' },
      { section: 'Changed', text: 'Setup is shorter.' },
      { section: 'Removed', text: 'The old prompt is gone.' },
    ])
    expect(entry.fromUpstream).toEqual({ ref: UPSTREAM.ref, items: [{ area: 'Compatibility', text: 'The lane streams progress.' }] })
  })

  it('prints the section as a bold prefix only for Security, Removed and Fixed', () => {
    const text = renderEntry(buildEntry('0.1.0-preview.1', '2026-11-10', UPSTREAM.ref, FRAGMENTS))
    expect(text).toBe([
      '## 0.1.0-preview.1 (2026-11-10)',
      '',
      '### Setup',
      '- Setup asks four questions.',
      '- Setup resumes.',
      '- Setup is shorter.',
      '- **Removed:** The old prompt is gone.',
      '',
      '### Safety and privacy',
      '- **Security:** Fetches refuse private addresses.',
      '',
      '### Commands',
      '- **Fixed:** Logs open again.',
      '',
      '### From upstream',
      '- Based on DeepSeek Harness `dsh-v0.2.2-rc.1`.',
      '- The lane streams progress.',
      '',
    ].join('\n'))
  })

  it('renders the release notes with area headings one level up', () => {
    const notes = renderNotes(buildEntry('0.1.0-preview.1', '2026-11-10', UPSTREAM.ref, FRAGMENTS.slice(0, 1)))
    expect(notes).toBe('# Delorun 0.1.0-preview.1\n\n## Commands\n- **Fixed:** Logs open again.\n\n## From upstream\n- Based on DeepSeek Harness `dsh-v0.2.2-rc.1`.\n')
  })
})

describe('the highlights', () => {
  const entry = buildEntry('0.1.0', '2026-11-10', UPSTREAM.ref, FRAGMENTS)

  it('prints the bullets as plain text under their area, without Markdown marks or the upstream line', () => {
    const text = renderHighlights(buildEntry('0.1.0', '2026-11-10', UPSTREAM.ref, [fragment('a.md', 'Commands', 'Fixed', ['**Logs** open again, see [the guide](https://example.com/x) and `delorun logs`.'])]), 65_536)
    expect(text).toBe('Delorun 0.1.0\n\nCommands\n- Logs open again, see the guide and delorun logs.\n')
    expect(text).not.toMatch(/[*`\]]/u)
  })

  it('fits the byte limit by replacing the bullets that do not fit with one counting line', () => {
    const text = renderHighlights(entry, 120)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120)
    expect(text).toMatch(/\n\d+ more changes are in the full changelog\.\n$/u)
    expect(renderHighlights(entry, 65_536)).not.toContain('more changes')
  })
})

describe('the order inside an area', () => {
  it('prints Added, Changed, Fixed, Security, Removed, so a description comes before its hardening notes', () => {
    const mixed = [
      fragment('a.md', 'Setup', 'Removed', ['Removed.']),
      fragment('b.md', 'Setup', 'Security', ['Secured.']),
      fragment('c.md', 'Setup', 'Fixed', ['Fixed.']),
      fragment('d.md', 'Setup', 'Changed', ['Changed.']),
      fragment('e.md', 'Setup', 'Added', ['Added.']),
    ]
    expect(buildEntry('0.1.0-preview.1', '2026-11-10', UPSTREAM.ref, mixed).areas[0]?.items.map(item => item.section)).toEqual(['Added', 'Changed', 'Fixed', 'Security', 'Removed'])
    expect(buildCompared(mixed).map(item => item.section)).toEqual(['Added', 'Changed', 'Fixed', 'Security', 'Removed'])
  })
})

describe('the standing comparison', () => {
  it('keeps every bullet, ordered by area and section', () => {
    expect(buildCompared(FRAGMENTS).map(item => `${item.area}/${item.section}`)).toEqual([
      'Setup/Added', 'Setup/Added', 'Setup/Changed', 'Setup/Removed', 'Safety and privacy/Security', 'Commands/Fixed', 'Compatibility/From upstream',
    ])
  })

  it('drops the bullets of a fragment that a later one replaces', () => {
    const later = fragment('g-setup-two.md', 'Setup', 'Added', ['Setup now asks five questions.'], 'a-setup.md')
    const compared = buildCompared([...FRAGMENTS, later])
    expect(compared.map(item => item.text)).not.toContain('Setup asks four questions.')
    expect(compared.map(item => item.text)).toContain('Setup now asks five questions.')
    expect(compared).toHaveLength(6)
  })

  it('refuses a repeated file name and a replaces that names nothing or itself', () => {
    const twice = [fragment('same.md', 'Setup', 'Added', ['One.']), { ...fragment('same.md', 'Setup', 'Added', ['Two.']), path: 'delorun/changelog/releases/0.1.0-preview.1/same.md' }]
    expect(replacesErrors(twice)).toEqual([expect.stringContaining('the file name same.md is also used by delorun/changelog/unreleased/same.md')])
    expect(replacesErrors([fragment('x.md', 'Setup', 'Added', ['One.'], 'missing.md')])).toEqual([expect.stringContaining('replaces missing.md, which no released or unreleased fragment has')])
    expect(replacesErrors([fragment('x.md', 'Setup', 'Added', ['One.'], 'x.md')])).toEqual([expect.stringContaining('replaces itself')])
    expect(replacesErrors(FRAGMENTS)).toEqual([])
  })
})

/**
 * The data file after a version.
 * @param existing - the data before.
 * @param version - the version.
 * @param fragments - its fragments.
 * @returns the data after.
 */
function assemble(existing: ChangelogData | undefined, version: string, fragments: readonly Fragment[]): ChangelogData {
  const entry = buildEntry(version, '2026-11-10', UPSTREAM.ref, fragments, foldedPreviews(existing, version))
  return addVersion(existing, UPSTREAM, entry, buildCompared(fragments))
}

describe('the data file', () => {
  it('lists versions newest first and folds the previews into their final version', () => {
    const one = assemble(undefined, '0.1.0-preview.1', FRAGMENTS.slice(0, 2))
    const two = assemble(one, '0.1.0-preview.2', FRAGMENTS.slice(2, 5))
    expect(two.versions.map(entry => entry.version)).toEqual(['0.1.0-preview.2', '0.1.0-preview.1'])
    expect(foldedPreviews(two, '0.1.0-preview.3')).toEqual([])
    const final = assemble(two, '0.1.0', FRAGMENTS.slice(5))
    expect(final.versions.map(entry => entry.version)).toEqual(['0.1.0'])
    expect(final.versions[0]?.preview).toBe(false)
    expect(final.versions[0]?.previews.map(preview => preview.version)).toEqual(['0.1.0-preview.2', '0.1.0-preview.1'])
    expect(final.versions[0]?.previews[0]?.fromUpstream).toEqual([{ area: 'Compatibility', text: 'The lane streams progress.' }])
  })

  it('leaves the previews of another release alone', () => {
    const one = assemble(undefined, '0.2.0-preview.1', FRAGMENTS.slice(0, 1))
    expect(assemble(one, '0.1.0', FRAGMENTS.slice(1, 2)).versions.map(entry => entry.version)).toEqual(['0.2.0-preview.1', '0.1.0'])
  })

  it('renders a folded final version with its previews as sub-headings', () => {
    const one = assemble(undefined, '0.1.0-preview.1', FRAGMENTS.slice(0, 1))
    const two = assemble(one, '0.1.0-preview.2', FRAGMENTS.slice(4, 5))
    const text = renderEntry(assemble(two, '0.1.0', FRAGMENTS.slice(1, 2)).versions[0]!)
    expect(text).toBe([
      '## 0.1.0 (2026-11-10)',
      '',
      '### Setup',
      '- Setup asks four questions.',
      '- Setup resumes.',
      '',
      '### From upstream',
      '- Based on DeepSeek Harness `dsh-v0.2.2-rc.1`.',
      '',
      '### 0.1.0-preview.2 (2026-11-10)',
      '',
      '#### From upstream',
      '- The lane streams progress.',
      '',
      '### 0.1.0-preview.1 (2026-11-10)',
      '',
      '#### Commands',
      '- **Fixed:** Logs open again.',
      '',
    ].join('\n'))
  })

  it('renders the document from the data: title, standing comparison, then versions', () => {
    const data = assemble(assemble(undefined, '0.1.0-preview.1', FRAGMENTS.slice(0, 2)), '0.1.0-preview.2', FRAGMENTS.slice(2, 3))
    const text = renderChangelog(data)
    expect(text.startsWith('# Changelog\n\n## Delorun compared with DeepSeek Harness dsh-v0.2.2-rc.1\n\nThis is everything that differs')).toBe(true)
    expect(text.indexOf('## 0.1.0-preview.2')).toBeLessThan(text.indexOf('## 0.1.0-preview.1'))
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
    expect(renderChangelog({ schema: CHANGELOG_SCHEMA, upstream: UPSTREAM, compared: [], versions: [] })).toBe('# Changelog\n\n## Delorun compared with DeepSeek Harness dsh-v0.2.2-rc.1\n\nNo difference is recorded yet.\n')
  })

  it('reads a data file and refuses text that is not one', () => {
    const data = assemble(undefined, '0.1.0-preview.1', FRAGMENTS.slice(0, 1))
    expect(parseData(JSON.stringify(data))).toEqual(data)
    expect(() => parseData('{ nope')).toThrow('is not JSON')
    expect(() => parseData('null')).toThrow('not a delorun.changelog/1 document')
    expect(() => parseData(JSON.stringify({ schema: 'other/1', versions: [], compared: [] }))).toThrow('not a delorun.changelog/1 document')
    expect(() => parseData(JSON.stringify({ schema: CHANGELOG_SCHEMA, versions: {}, compared: [] }))).toThrow('not a delorun.changelog/1 document')
  })
})

describe('the public view of the data file', () => {
  const two = assemble(assemble(undefined, '0.1.0-preview.1', FRAGMENTS.slice(0, 1)), '0.1.0-preview.2', FRAGMENTS.slice(1, 2))
  const data: ChangelogData = { ...two, publicFrom: '0.1.0-preview.2' }

  it('leaves out the versions before publicFrom and keeps publicFrom itself', () => {
    expect(publicVersions(data).map(entry => entry.version)).toEqual(['0.1.0-preview.2'])
    const text = renderChangelog(data)
    expect(text).toContain('## 0.1.0-preview.2 ')
    expect(text).not.toContain('## 0.1.0-preview.1 ')
    expect(data.versions.map(entry => entry.version)).toEqual(['0.1.0-preview.2', '0.1.0-preview.1'])
  })

  it('shows every version when publicFrom is absent', () => {
    expect(publicVersions(two).map(entry => entry.version)).toEqual(['0.1.0-preview.2', '0.1.0-preview.1'])
  })

  it('says under the title that earlier versions were private previews, naming publicFrom, and only when it is set', () => {
    const note = 'Versions before 0.1.0-preview.2 were private previews and are not listed.'
    expect(privatePreviewNote(data)).toBe(note)
    expect(renderChangelog(data).startsWith(`# Changelog\n\n${note}\n\n## Delorun compared with DeepSeek Harness`)).toBe(true)
    expect(privatePreviewNote(two)).toBeUndefined()
    expect(renderChangelog(two)).not.toContain('private previews')
  })

  it('leaves out the folded previews before publicFrom', () => {
    const final = addVersion({ ...two, publicFrom: '0.1.0-preview.2' }, UPSTREAM, buildEntry('0.1.0', '2026-11-12', UPSTREAM.ref, FRAGMENTS.slice(2, 3), foldedPreviews(two, '0.1.0')), [])
    expect(final.publicFrom).toBe('0.1.0-preview.2')
    expect(publicVersions(final)[0]?.previews.map(preview => preview.version)).toEqual(['0.1.0-preview.2'])
    expect(final.versions[0]?.previews.map(preview => preview.version)).toEqual(['0.1.0-preview.2', '0.1.0-preview.1'])
  })

  it('refuses a publicFrom that is not an accepted version', () => {
    expect(parseData(JSON.stringify(data)).publicFrom).toBe('0.1.0-preview.2')
    for (const publicFrom of ['nope', 7, '0.1.0-preview.0']) {
      expect(() => parseData(JSON.stringify({ ...data, publicFrom }))).toThrow('publicFrom is not an accepted version')
    }
  })
})
