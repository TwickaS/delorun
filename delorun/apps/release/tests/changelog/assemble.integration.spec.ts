import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assembleRelease, readData, run, writeAssembly } from '../../src/changelog/assemble.ts'
import { messageOf } from '../../src/changelog/output.ts'
import { parseData, renderChangelog } from '../../src/changelog/data.ts'
import { ASSEMBLE, capture, fragmentText, LEDGER, PENDING_DIR, runTsx, scratchRepo, SIGNED, UNRELEASED, type Scratch } from './support.ts'

const RELEASES = 'delorun/changelog/releases'

/**
 * A repository with the upstream ledger, three unreleased fragments and one pending fragment.
 * @param test - the running test.
 * @returns the repository.
 */
function releaseRepo(test: Parameters<typeof scratchRepo>[0]): Scratch {
  const repo = scratchRepo(test)
  repo.commit({
    'delorun/upstream-patches.json': LEDGER,
    [`${UNRELEASED}lane-options.md`]: fragmentText('Commands', 'Added', ['The lane has two new options.']),
    [`${UNRELEASED}replay-fix.md`]: fragmentText('Safety and privacy', 'Security', ['The replay no longer trusts a stale token.', 'Second security line.']),
    [`${UNRELEASED}upstream-lane.md`]: fragmentText('Compatibility', 'From upstream', ['The upstream lane now streams progress.']),
    [`${PENDING_DIR}trash.md`]: fragmentText('Chats and workspaces', 'Added', ['Trash keeps a deleted chat for thirty days.'], ['waits: the trash wired into the studio']),
  }, `chore(release): fixture\n\n${SIGNED}`)
  return repo
}

/**
 * Run the command on a repository and return what it printed.
 * @param repo - the repository.
 * @param args - the command-line arguments.
 * @returns the exit code and the captured output.
 */
function assemble(repo: Scratch, ...args: string[]): { code: number, out: string, err: string } {
  const output = capture()
  const code = run(args, repo.root, output.sink)
  return { code, out: output.out.join('\n'), err: output.err.join('\n') }
}

/**
 * Read a repository file.
 * @param repo - the repository.
 * @param path - the repository-relative path.
 * @returns the text.
 */
function read(repo: Scratch, path: string): string {
  return readFileSync(join(repo.root, path), 'utf8')
}

describe('the assembly of a preview sub-version', () => {
  it('dry-run prints the entry and the notes, names the upstream release, and writes nothing', (test) => {
    const repo = releaseRepo(test)
    const before = repo.run(['status', '--porcelain'])
    const result = assemble(repo, '--version', '0.1.0-preview.1', '--dry-run', '--date', '2026-11-10')
    expect(result.code).toBe(0)
    expect(result.out).toContain('## 0.1.0-preview.1 (2026-11-10)')
    expect(result.out).toContain('# Delorun 0.1.0-preview.1')
    expect(result.out).toContain('### From upstream\n- Based on DeepSeek Harness `dsh-v0.2.2-rc.1`.\n- The upstream lane now streams progress.')
    expect(result.out.indexOf('### Safety and privacy')).toBeLessThan(result.out.indexOf('### Commands'))
    expect(result.out).toContain('standing comparison: 4 bullets; fragments to move: 3')
    expect(existsSync(join(repo.root, 'CHANGELOG.md'))).toBe(false)
    expect(existsSync(join(repo.root, RELEASES))).toBe(false)
    expect(repo.run(['status', '--porcelain'])).toBe(before)
  })

  it('moves the consumed fragments, leaves the pending one, and writes the data, the changelog and the notes', (test) => {
    const repo = releaseRepo(test)
    const result = assemble(repo, '--version', '0.1.0-preview.1', '--date', '2026-11-10')
    expect(result.code).toBe(0)
    expect(result.out.split('\n')).toEqual([
      `assemble: wrote ${RELEASES}/0.1.0-preview.1.md`,
      'assemble: wrote delorun/changelog/changelog.json',
      'assemble: wrote CHANGELOG.md',
      `assemble: wrote ${RELEASES}/0.1.0-preview.1/lane-options.md`,
      `assemble: wrote ${RELEASES}/0.1.0-preview.1/replay-fix.md`,
      `assemble: wrote ${RELEASES}/0.1.0-preview.1/upstream-lane.md`,
    ])
    expect(existsSync(join(repo.root, UNRELEASED, 'lane-options.md'))).toBe(false)
    expect(existsSync(join(repo.root, RELEASES, '0.1.0-preview.1/lane-options.md'))).toBe(true)
    expect(existsSync(join(repo.root, PENDING_DIR, 'trash.md'))).toBe(true)
    expect(read(repo, `${RELEASES}/0.1.0-preview.1.md`)).toContain('## From upstream')
    expect(read(repo, 'CHANGELOG.md')).not.toContain('Trash keeps')
    expect(read(repo, 'delorun/changelog/changelog.json')).not.toContain('Trash keeps')
  })

  it('keeps publicFrom and the private-preview line through every assembly, and lists only the public versions', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--date', '2026-11-10').code).toBe(0)
    const data = parseData(read(repo, 'delorun/changelog/changelog.json'))
    repo.commit({ 'delorun/changelog/changelog.json': `${JSON.stringify({ ...data, publicFrom: '0.1.0-preview.2' }, undefined, 2)}\n` }, `chore(release): mark the first public version\n\n${SIGNED}`)
    repo.commit({ [`${UNRELEASED}later.md`]: fragmentText('Commands', 'Fixed', ['A later fix.']) }, `fix(release): later\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.2', '--date', '2026-11-11').code).toBe(0)
    const changelog = read(repo, 'CHANGELOG.md')
    expect(changelog.startsWith('# Changelog\n\nVersions before 0.1.0-preview.2 were private previews and are not listed.\n\n## Delorun compared with')).toBe(true)
    expect(changelog).toContain('## 0.1.0-preview.2 (2026-11-11)')
    expect(changelog).not.toContain('## 0.1.0-preview.1 ')
    expect(parseData(read(repo, 'delorun/changelog/changelog.json')).publicFrom).toBe('0.1.0-preview.2')
    expect(changelog).toBe(renderChangelog(parseData(read(repo, 'delorun/changelog/changelog.json'))))
  })

  it('writes a CHANGELOG.md that is exactly the Markdown rendered from the data file', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--date', '2026-11-10').code).toBe(0)
    repo.commit({ [`${UNRELEASED}later.md`]: fragmentText('Commands', 'Fixed', ['A later fix.']) }, `fix(release): later\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.2', '--date', '2026-11-11').code).toBe(0)
    const data = parseData(read(repo, 'delorun/changelog/changelog.json'))
    expect(read(repo, 'CHANGELOG.md')).toBe(renderChangelog(data))
    expect(data.schema).toBe('delorun.changelog/1')
    expect(data.upstream).toEqual({ ref: 'dsh-v0.2.2-rc.1', commit: 'a'.repeat(40) })
    expect(data.versions.map(entry => [entry.version, entry.date, entry.preview])).toEqual([['0.1.0-preview.2', '2026-11-11', true], ['0.1.0-preview.1', '2026-11-10', true]])
    expect(data.compared.map(item => item.text)).toContain('A later fix.')
    expect(read(repo, 'CHANGELOG.md').indexOf('## 0.1.0-preview.2')).toBeLessThan(read(repo, 'CHANGELOG.md').indexOf('## 0.1.0-preview.1'))
    expect(readData(repo.root)).toEqual(data)
  })

  it('folds the previews into the final version it leads to, and keeps the standing comparison', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--date', '2026-11-10').code).toBe(0)
    repo.commit({ [`${UNRELEASED}later.md`]: fragmentText('Commands', 'Fixed', ['A later fix.']) }, `fix(release): later\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0', '--date', '2026-11-12').code).toBe(0)
    const data = parseData(read(repo, 'delorun/changelog/changelog.json'))
    expect(data.versions.map(entry => entry.version)).toEqual(['0.1.0'])
    expect(data.versions[0]?.previews.map(preview => preview.version)).toEqual(['0.1.0-preview.1'])
    expect(data.compared).toHaveLength(5)
    const changelog = read(repo, 'CHANGELOG.md')
    expect(changelog).toContain('## 0.1.0 (2026-11-12)')
    expect(changelog).toContain('### 0.1.0-preview.1 (2026-11-10)')
    expect(changelog).not.toMatch(/^## 0\.1\.0-preview\.1/m)
    expect(changelog).toBe(renderChangelog(data))
  })

  it('assembles a final version that only folds previews', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--date', '2026-11-10').code).toBe(0)
    expect(assemble(repo, '--version', '0.1.0', '--date', '2026-11-12').code).toBe(0)
    expect(parseData(read(repo, 'delorun/changelog/changelog.json')).versions[0]?.areas).toEqual([])
  })

  it('removes a superseded bullet from the standing comparison once a later fragment replaces it', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--date', '2026-11-10').code).toBe(0)
    repo.commit({ [`${UNRELEASED}lane-three-options.md`]: fragmentText('Commands', 'Changed', ['The lane has three options.'], ['replaces: lane-options.md']) }, `feat(release): three\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.2', '--date', '2026-11-11').code).toBe(0)
    const data = parseData(read(repo, 'delorun/changelog/changelog.json'))
    const standing = data.compared.map(item => item.text)
    expect(standing).not.toContain('The lane has two new options.')
    expect(standing).toContain('The lane has three options.')
    expect(JSON.stringify(data.versions)).toContain('The lane has two new options.')
  })
})

describe('the headlines of a version', () => {
  it('records up to three headline sentences and prints them at the top of the notes and the changelog entry', (test) => {
    const repo = releaseRepo(test)
    const result = assemble(repo, '--version', '0.1.0-preview.1', '--date', '2026-11-10', '--headline', 'You can change the look.', '--headline', 'You can undo it.')
    expect(result.code).toBe(0)
    expect(parseData(read(repo, 'delorun/changelog/changelog.json')).versions[0]?.headlines).toEqual(['You can change the look.', 'You can undo it.'])
    expect(read(repo, `${RELEASES}/0.1.0-preview.1.md`)).toMatch(/^# Delorun 0\.1\.0-preview\.1\n\nYou can change the look\. You can undo it\.\n\n## /u)
    expect(read(repo, 'CHANGELOG.md')).toContain('## 0.1.0-preview.1 (2026-11-10)\n\nYou can change the look. You can undo it.\n\n### ')
  })

  it('records no headlines field when none is given', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1').code).toBe(0)
    expect(read(repo, 'delorun/changelog/changelog.json')).not.toContain('headlines')
  })

  it('refuses more than three headlines and a headline that is empty or too long', (test) => {
    const repo = releaseRepo(test)
    const four = assemble(repo, '--version', '0.1.0-preview.1', '--dry-run', '--headline', 'A.', '--headline', 'B.', '--headline', 'C.', '--headline', 'D.')
    expect(four.code).toBe(1)
    expect(four.err).toContain('at most 3 headlines')
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--dry-run', '--headline', ' ').err).toContain('one non-empty line')
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--dry-run', '--headline', 'x'.repeat(241)).err).toContain('at most 240 characters')
  })
})

describe('the refusals of the assembly', () => {
  it('refuses 1.0.0 without --first-public-release and admits it with the flag', (test) => {
    const repo = releaseRepo(test)
    const refused = assemble(repo, '--version', '1.0.0', '--dry-run')
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('pass --first-public-release')
    expect(assemble(repo, '--version', '1.0.0', '--dry-run', '--first-public-release').code).toBe(0)
  })

  it('refuses a version that is not strict semver, a fragment that does not parse, and a fragment without an area', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', 'v0.1.0-preview.1', '--dry-run').code).toBe(1)
    repo.commit({ [`${UNRELEASED}bad.md`]: fragmentText('Setup', 'Bogus', ['Nothing.']), [`${UNRELEASED}no-area.md`]: '---\nsection: Added\n---\n\n- Nothing.\n' }, `docs(changelog): bad\n\n${SIGNED}`)
    const result = assemble(repo, '--version', '0.1.0-preview.1', '--dry-run')
    expect(result.code).toBe(1)
    expect(result.err).toContain('section "Bogus" is not one of')
    expect(result.err).toContain(`${UNRELEASED}no-area.md: the front matter has no \`area:\` line`)
  })

  it('refuses a version that already has notes', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1').code).toBe(0)
    repo.commit({ [`${UNRELEASED}later.md`]: fragmentText('Commands', 'Fixed', ['A later fix.']) }, `fix(release): later\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.1').err).toContain('release 0.1.0-preview.1 already has notes')
  })

  it('refuses a version the data file already lists, even when its notes are gone', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1').code).toBe(0)
    rmSync(join(repo.root, RELEASES), { recursive: true })
    repo.commit({ [`${UNRELEASED}later.md`]: fragmentText('Commands', 'Fixed', ['A later fix.']) }, `fix(release): later\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.1').err).toContain('changelog.json already has version 0.1.0-preview.1')
  })

  it('refuses a preview that would follow its final version', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0').code).toBe(0)
    repo.commit({ [`${UNRELEASED}later.md`]: fragmentText('Commands', 'Fixed', ['A later fix.']) }, `fix(release): later\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.1').err).toContain('0.1.0 is already assembled; a preview of it would follow its release')
  })

  it('refuses a replaces that names no fragment and a fragment name used twice', (test) => {
    const repo = releaseRepo(test)
    repo.commit({ [`${UNRELEASED}broken.md`]: fragmentText('Commands', 'Changed', ['Changed.'], ['replaces: nothing-like-it.md']) }, `docs(changelog): broken\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.1').err).toContain('replaces nothing-like-it.md, which no released or unreleased fragment has')
    repo.commit({ [`${UNRELEASED}broken.md`]: fragmentText('Commands', 'Changed', ['Changed.']) }, `docs(changelog): fixed\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--date', '2026-11-10').code).toBe(0)
    repo.commit({ [`${UNRELEASED}broken.md`]: fragmentText('Commands', 'Changed', ['Changed again.']) }, `docs(changelog): again\n\n${SIGNED}`)
    expect(assemble(repo, '--version', '0.1.0-preview.2').err).toContain('the file name broken.md is also used by')
  })

  it('refuses to assemble when nothing is unreleased and no preview folds', (test) => {
    const repo = scratchRepo(test)
    repo.commit({ 'delorun/upstream-patches.json': LEDGER })
    expect(assemble(repo, '--version', '0.1.0-preview.1').err).toContain('nothing to assemble: no unreleased fragment and no preview to fold')
    repo.commit({ [`${UNRELEASED}bad.md`]: 'not a fragment' })
    expect(assemble(repo, '--version', '0.1.0-preview.1').err).toContain('does not open with')
  })

  it('refuses a data file that is damaged', (test) => {
    const repo = releaseRepo(test)
    repo.commit({ 'delorun/changelog/changelog.json': '{ nope' })
    const result = assemble(repo, '--version', '0.1.0-preview.1')
    expect(result.code).toBe(1)
    expect(result.err).toContain('changelog.json is not JSON')
  })

  it('refuses a wrong command line', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--bogus').code).toBe(2)
    expect(assemble(repo).err).toContain('pass --version <version>, or --list-unreleased')
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--date', 'yesterday').err).toContain('--date must be YYYY-MM-DD')
    expect(assemble(repo, '--version', '0.1.0-preview.1', '--advisories', 'report.json').err).toContain('pass --advisories and --manifest together')
  })

  it('records today in UTC when no date is given', (test) => {
    const repo = releaseRepo(test)
    expect(assemble(repo, '--version', '0.1.0-preview.1').code).toBe(0)
    expect(readData(repo.root)?.versions[0]?.date).toBe(new Date().toISOString().slice(0, 10))
  })

  it('describes a caught value with its causes', () => {
    expect(messageOf('plain')).toBe('plain')
    expect(messageOf(new Error('outer', { cause: new Error('inner') }))).toBe('outer: inner')
    expect(messageOf(new Error('alone'))).toBe('alone')
  })

  it('writes an assembly the caller builds', (test) => {
    const repo = releaseRepo(test)
    const assembly = assembleRelease(repo.root, '0.1.0-preview.1', { firstPublicRelease: false, date: '2026-11-10' })
    expect(writeAssembly(repo.root, assembly)).toHaveLength(6)
  })
})

describe('--list-unreleased', () => {
  it('prints the unreleased fragments by area and the pending ones with what they wait for', (test) => {
    const repo = releaseRepo(test)
    const result = assemble(repo, '--list-unreleased')
    expect(result.code).toBe(0)
    expect(result.out).toBe([
      'Unreleased: 3 fragments, by area (the next sub-version would contain these).',
      '',
      'Safety and privacy',
      '  replay-fix.md (Security, 2 bullets): The replay no longer trusts a stale token. - Second security line.',
      '',
      'Commands',
      '  lane-options.md (Added, 1 bullet): The lane has two new options.',
      '',
      'Compatibility',
      '  upstream-lane.md (From upstream, 1 bullet): The upstream lane now streams progress.',
      '',
      'Pending: 1 fragment, never assembled; each waits for the wiring named.',
      '  trash.md (Chats and workspaces): waits the trash wired into the studio',
    ].join('\n'))
  })

  it('shortens a long bullet, says when nothing is unreleased or pending, and reports a fragment that does not parse', (test) => {
    const repo = scratchRepo(test)
    expect(assemble(repo, '--list-unreleased').out).toBe('Unreleased: none.\n\nPending: none.')
    repo.write({ [`${UNRELEASED}long.md`]: fragmentText('Setup', 'Added', [`${'word '.repeat(40)}end`]), [`${PENDING_DIR}broken.md`]: fragmentText('Setup', 'Added', ['No waits.']) })
    const result = assemble(repo, '--list-unreleased')
    expect(result.code).toBe(1)
    expect(result.out).toContain('long.md (Added, 1 bullet): word word word')
    expect(result.out).toMatch(/\.\.\.\n/)
    expect(result.err).toContain(`${PENDING_DIR}broken.md: a pending fragment needs a \`waits:\` line`)
  })
})

describe('the command as a process', () => {
  it('runs from a repository root, prints to the console and sets the exit code', (test) => {
    const repo = releaseRepo(test)
    const listed = runTsx(repo.root, ASSEMBLE, ['--list-unreleased'])
    expect(listed.status, listed.output).toBe(0)
    expect(listed.output).toContain('Pending: 1 fragment')
    const dry = runTsx(repo.root, ASSEMBLE, ['--version', '0.1.0-preview.1', '--dry-run', '--date', '2026-11-10'])
    expect(dry.status, dry.output).toBe(0)
    expect(dry.output).toContain('## 0.1.0-preview.1 (2026-11-10)')
    expect(runTsx(repo.root, ASSEMBLE, ['--version', 'nope']).status).toBe(1)
  })
})
