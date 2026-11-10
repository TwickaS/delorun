import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AREAS, fragmentPaths, parseFragment, pendingPaths, readFragments, releasedPaths, SECTIONS } from '../../src/changelog/fragment.ts'
import { isFragmentPath, isPendingPath } from '../../src/changelog/paths.ts'
import { fragmentText, PENDING_DIR, scratchRepo, UNRELEASED } from './support.ts'

const PATH = 'delo/changelog/unreleased/upstream-lane.md'
const BODY = '- A change.\n'

describe('a changelog fragment', () => {
  it('parses an area, a section and its bullet lines in the fixed lists', () => {
    expect(SECTIONS).toEqual(['Security', 'Added', 'Changed', 'Fixed', 'Removed', 'From upstream'])
    expect(AREAS).toEqual(['Install and update', 'Setup', 'Studio', 'Chats and workspaces', 'Safety and privacy', 'Reach', 'Plugins', 'Commands', 'Compatibility'])
    const result = parseFragment(PATH, '---\narea: Commands\nsection: Fixed\n---\n\n- The replay no longer fails when the build is missing.\n- A second bullet.\n')
    expect(result).toEqual({
      ok: true,
      fragment: { path: PATH, area: 'Commands', section: 'Fixed', bullets: ['- The replay no longer fails when the build is missing.', '- A second bullet.'], replaces: undefined, waits: undefined },
    })
  })

  it('accepts quoted values and a replaces line', () => {
    expect(parseFragment(PATH, `---\narea: "Install and update"\nsection: "From upstream"\nreplaces: older-lane.md\n---\n\n${BODY}`))
      .toMatchObject({ ok: true, fragment: { area: 'Install and update', section: 'From upstream', replaces: 'older-lane.md' } })
  })

  it('requires an area and refuses an unknown one', () => {
    expect(parseFragment(PATH, `---\nsection: Fixed\n---\n\n${BODY}`)).toEqual({ ok: false, errors: ['the front matter has no `area:` line'] })
    expect(parseFragment(PATH, `---\narea: Everything\nsection: Fixed\n---\n\n${BODY}`)).toEqual({
      ok: false,
      errors: [`area "Everything" is not one of ${AREAS.join(', ')}`],
    })
  })

  it('names each violation of the front matter, the section, the body and the file name', () => {
    expect(parseFragment(PATH, `---\narea: Setup\nsection: Bogus\n---\n\n${BODY}`)).toEqual({
      ok: false,
      errors: ['section "Bogus" is not one of Security, Added, Changed, Fixed, Removed, From upstream'],
    })
    expect(parseFragment(PATH, `---\narea: Setup\n---\n\n${BODY}`)).toMatchObject({ ok: false, errors: ['the front matter has no `section:` line'] })
    expect(parseFragment(PATH, '# No front matter\n\n- A change.\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('does not open with `---`')] })
    expect(parseFragment(PATH, '---\narea: Setup\nsection: Fixed\n\n- A change.\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('does not close with `---`')] })
    expect(parseFragment(PATH, `---\narea: Setup\nsection: Fixed\ntype: Fixed\n---\n\n${BODY}`)).toMatchObject({ ok: false, errors: [expect.stringContaining('field "type" is not one of')] })
    expect(parseFragment(PATH, `---\narea: Setup\narea: Setup\nsection: Fixed\n---\n\n${BODY}`)).toMatchObject({ ok: false, errors: [expect.stringContaining('"area" appears twice')] })
    expect(parseFragment(PATH, `---\narea: Setup\nsection\nOther: x\nsection: Fixed\n---\n\n${BODY}`)).toMatchObject({ ok: false, errors: [expect.stringContaining('"section" is not'), expect.stringContaining('"Other: x" is not')] })
    expect(parseFragment(PATH, `---\narea:\nsection: Fixed\n---\n\n${BODY}`)).toMatchObject({ ok: false, errors: [expect.stringContaining('"area:" is not'), expect.stringContaining('no `area:`')] })
    expect(parseFragment(PATH, '---\narea: Setup\nsection: Fixed\n---\n\nA sentence without a bullet.\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('is not a bullet')] })
    expect(parseFragment(PATH, '---\narea: Setup\nsection: Fixed\n---\n\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('no bullet line')] })
    expect(parseFragment('delo/changelog/unreleased/Upstream_Lane.md', `---\narea: Setup\nsection: Fixed\n---\n\n${BODY}`)).toMatchObject({ ok: false, errors: [expect.stringContaining('lowercase')] })
    expect(parseFragment(PATH, `---\narea: Setup\nsection: Fixed\nreplaces: Not A Name\n---\n\n${BODY}`)).toMatchObject({ ok: false, errors: [expect.stringContaining('replaces "Not A Name" is not a fragment file name')] })
  })

  it('refuses internal identifiers in the body', () => {
    for (const bullet of ['- Fixed in #412.', '- Done in WP1.11.', '- Per decision D12.']) {
      expect(parseFragment(PATH, `---\narea: Setup\nsection: Fixed\n---\n\n${bullet}\n`)).toMatchObject({ ok: false, errors: [expect.stringContaining('names')] })
    }
  })

  it('needs waits on a pending fragment and refuses it elsewhere', () => {
    const pending = 'delo/changelog/pending/trash.md'
    expect(parseFragment(pending, fragmentText('Chats and workspaces', 'Added', ['A bullet.'], ['waits: the trash wired into the studio']), 'pending'))
      .toMatchObject({ ok: true, fragment: { waits: 'the trash wired into the studio' } })
    expect(parseFragment(pending, fragmentText('Chats and workspaces', 'Added', ['A bullet.']), 'pending')).toMatchObject({ ok: false, errors: [expect.stringContaining('needs a `waits:` line')] })
    expect(parseFragment(pending, fragmentText('Chats and workspaces', 'Added', ['A bullet.'], ['waits: x', 'replaces: other.md']), 'pending')).toMatchObject({ ok: false, errors: [expect.stringContaining('cannot carry `replaces:`')] })
    expect(parseFragment(PATH, fragmentText('Setup', 'Added', ['A bullet.'], ['waits: x']))).toMatchObject({ ok: false, errors: [expect.stringContaining('belongs to a fragment in the pending folder')] })
  })
})

describe('the fragment folders', () => {
  it('lists the fragments of each folder in name order and leaves the READMEs out', (test) => {
    const repo = scratchRepo(test)
    repo.write({
      [`${UNRELEASED}b-second.md`]: fragmentText('Setup', 'Added', ['Two.']),
      [`${UNRELEASED}a-first.md`]: fragmentText('Setup', 'Added', ['One.']),
      [`${UNRELEASED}README.md`]: '# Readme\n',
      [`${UNRELEASED}README.zh.md`]: '# Readme\n',
      [`${UNRELEASED}notes.txt`]: 'x',
      [`${PENDING_DIR}trash.md`]: fragmentText('Setup', 'Added', ['Three.'], ['waits: wiring']),
      [`${PENDING_DIR}README.md`]: '# Readme\n',
      'delo/changelog/releases/0.1.0-preview.2/late.md': fragmentText('Setup', 'Added', ['Late.']),
      'delo/changelog/releases/0.1.0-preview.10/later.md': fragmentText('Setup', 'Added', ['Later.']),
      'delo/changelog/releases/0.1.0-preview.2/ignored.txt': 'x',
      'delo/changelog/releases/0.1.0-preview.2.md': '# Delo 0.1.0-preview.2\n',
    })
    expect(fragmentPaths(repo.root)).toEqual([`${UNRELEASED}a-first.md`, `${UNRELEASED}b-second.md`])
    expect(pendingPaths(repo.root)).toEqual([`${PENDING_DIR}trash.md`])
    expect(releasedPaths(repo.root)).toEqual(['delo/changelog/releases/0.1.0-preview.2/late.md', 'delo/changelog/releases/0.1.0-preview.10/later.md'])
    expect(isFragmentPath(`${UNRELEASED}sub/x.md`)).toBe(false)
    expect(isPendingPath(`${PENDING_DIR}sub/x.md`)).toBe(false)
    expect(isPendingPath(`${PENDING_DIR}x.txt`)).toBe(false)
    expect(isPendingPath(`${UNRELEASED}x.md`)).toBe(false)
  })

  it('returns nothing for absent folders and fails loudly when a folder cannot be read', (test) => {
    const repo = scratchRepo(test)
    expect(fragmentPaths(repo.root)).toEqual([])
    expect(pendingPaths(repo.root)).toEqual([])
    expect(releasedPaths(repo.root)).toEqual([])
    mkdirSync(join(repo.root, 'delo/changelog'), { recursive: true })
    writeFileSync(join(repo.root, 'delo/changelog/unreleased'), 'a file where a folder belongs')
    expect(() => fragmentPaths(repo.root)).toThrow(/ENOTDIR/)
  })

  it('reads fragments and prefixes each violation with its path', (test) => {
    const repo = scratchRepo(test)
    repo.write({ [`${UNRELEASED}good.md`]: fragmentText('Setup', 'Added', ['One.']), [`${UNRELEASED}bad.md`]: fragmentText('Nowhere', 'Added', ['One.']) })
    const read = readFragments(repo.root, [`${UNRELEASED}bad.md`, `${UNRELEASED}good.md`])
    expect(read.fragments.map(fragment => fragment.path)).toEqual([`${UNRELEASED}good.md`])
    expect(read.errors).toEqual([expect.stringContaining(`${UNRELEASED}bad.md: area "Nowhere"`)])
  })
})
