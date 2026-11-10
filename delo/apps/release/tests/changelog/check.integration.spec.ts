import { describe, expect, it } from 'vitest'
import { run } from '../../src/changelog/check.ts'
import { capture, CHECK, runTsx, scratchRepo, type Scratch } from './support.ts'

const SIGNED = 'Signed-off-by: Fixture Author <fixture@example.test>'
const FRAGMENTS = 'delo/changelog/unreleased/'

/**
 * A fragment file's text.
 * @param section - the section the front matter names.
 * @param bullet - the bullet line of the body.
 * @returns the file text.
 */
function fragment(section: string, bullet: string): string {
  return `---\narea: Commands\nsection: ${section}\n---\n\n- ${bullet}\n`
}

/**
 * Run the changelog gate over the commits after a base revision.
 * @param repo - the fixture repository.
 * @param base - the revision the range starts after.
 * @returns the exit status and the combined output.
 */
function gate(repo: Scratch, base: string): { status: number; output: string } {
  const output = capture()
  const status = run(['--base', base], repo.root, output.sink)
  return { status, output: output.all() }
}

describe('the changelog gate', () => {
  it('fails a product change that has neither a fragment nor a Changelog: none trailer', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'packages/app/index.ts': 'export const a = 0\n' })
    const bad = repo.commit({ 'packages/app/index.ts': 'export const a = 1\n' }, `feat(app): change a\n\n${SIGNED}`)
    const result = gate(repo, base)
    expect(result.status).toBe(1)
    expect(result.output).toContain(`${bad.slice(0, 10)}: changes product files (packages/app/index.ts) and neither adds a fragment`)
  })

  it('names the first three product paths and counts the rest', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'packages/app/a.ts': '0\n' })
    repo.commit({ 'packages/app/a.ts': '1\n', 'packages/app/b.ts': '1\n', 'packages/app/c.ts': '1\n', 'packages/app/d.ts': '1\n', 'packages/app/e.ts': '1\n' }, `feat(app): many\n\n${SIGNED}`)
    expect(gate(repo, base).output).toContain('(packages/app/a.ts, packages/app/b.ts, packages/app/c.ts and 2 more)')
  })

  it('fails a Changelog: none trailer that gives no reason', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'packages/app/index.ts': 'export const a = 0\n' })
    repo.commit({ 'packages/app/index.ts': 'export const a = 1\n' }, `test(app): change a\n\nChangelog: none\n${SIGNED}`)
    const result = gate(repo, base)
    expect(result.status).toBe(1)
    expect(result.output).toContain('`Changelog: none` needs its reason')
  })

  it('passes a docs-only change without a fragment or a trailer, because no path in it is product', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'README.md': '# Root\n' })
    repo.commit({
      'delo/docs/guide/page.md': '# Page\n',
      'docs/page.md': '# Page\n',
      '.agents/notes/note.md': '# Note\n',
      'packages/app/README.md': '# App\n',
      'delo/apps/tools/src/extra.ts': 'export {}\n',
      'delo/apps/release/src/extra.ts': 'export {}\n',
      '.github/workflows/extra.yml': 'name: extra\n',
      'delo/changelog/releases/0.1.0-alpha.1.md': '# Delo 0.1.0-alpha.1\n',
    }, `docs(guide): a page\n\n${SIGNED}`)
    expect(gate(repo, base)).toMatchObject({ status: 0 })
  })

  it('passes a commit that changes only a bilingual pairing record', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'packages/app/README.md': '# App\n', 'packages/app/README.i18n.yaml': 'old: 1\n' })
    repo.commit({ 'packages/app/README.i18n.yaml': 'new: 2\n' }, `docs(app): re-record\n\n${SIGNED}`)
    expect(gate(repo, base)).toMatchObject({ status: 0 })
  })

  it('passes a product change that adds a valid fragment in the same commit', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'packages/app/index.ts': 'export const a = 0\n' })
    repo.commit({
      'packages/app/index.ts': 'export const a = 1\n',
      [`${FRAGMENTS}app-a.md`]: fragment('Changed', 'The app now uses the new value.'),
    }, `feat(app): change a\n\n${SIGNED}`)
    expect(gate(repo, base)).toMatchObject({ status: 0 })
  })

  it('does not count a fragment added by an earlier commit for a later product commit', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'packages/app/index.ts': 'export const a = 0\n' })
    repo.commit({ [`${FRAGMENTS}app-a.md`]: fragment('Added', 'A new option.') }, `docs(changelog): a fragment\n\n${SIGNED}`)
    repo.commit({ 'packages/app/index.ts': 'export const a = 1\n' }, `fix(app): change a\n\n${SIGNED}`)
    const result = gate(repo, base)
    expect(result.status).toBe(1)
    expect(result.output).toContain('neither adds a fragment')
  })

  it('fails a fragment whose section is not one of the six sections, even in a docs-only commit', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'README.md': '# Root\n' })
    repo.commit({ [`${FRAGMENTS}app-a.md`]: fragment('Bogus', 'A new option.') }, `docs(changelog): a fragment\n\n${SIGNED}`)
    const result = gate(repo, base)
    expect(result.status).toBe(1)
    expect(result.output).toContain(`${FRAGMENTS}app-a.md: section "Bogus" is not one of`)
  })

  it('fails a fragment without an area or with an unknown one, and a pending fragment without waits', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'README.md': '# Root\n' })
    repo.commit({
      [`${FRAGMENTS}no-area.md`]: '---\nsection: Added\n---\n\n- A new option.\n',
      [`${FRAGMENTS}odd-area.md`]: '---\narea: Elsewhere\nsection: Added\n---\n\n- A new option.\n',
      'delo/changelog/pending/trash.md': fragment('Added', 'Trash keeps a chat for thirty days.'),
    }, `docs(changelog): fragments\n\n${SIGNED}`)
    const result = gate(repo, base)
    expect(result.status).toBe(1)
    expect(result.output).toContain(`${FRAGMENTS}no-area.md: the front matter has no \`area:\` line`)
    expect(result.output).toContain(`${FRAGMENTS}odd-area.md: area "Elsewhere" is not one of`)
    expect(result.output).toContain('delo/changelog/pending/trash.md: a pending fragment needs a `waits:` line')
  })

  it('passes a valid pending fragment, and a commit that only moves fragments under the changelog folder', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'README.md': '# Root\n' })
    repo.commit({
      'delo/changelog/pending/trash.md': '---\narea: Chats and workspaces\nsection: Added\nwaits: the trash wired into the studio\n---\n\n- Trash keeps a chat for thirty days.\n',
      'delo/changelog/changelog.json': '{}\n',
    }, `docs(changelog): pending\n\n${SIGNED}`)
    expect(gate(repo, base)).toMatchObject({ status: 0 })
  })

  it('rejects a wrong command line', (test) => {
    const repo = scratchRepo(test)
    const noBase = capture()
    expect(run([], repo.root, noBase.sink)).toBe(2)
    expect(noBase.all()).toContain('pass --base <rev>')
    const unknown = capture()
    expect(run(['--bogus'], repo.root, unknown.sink)).toBe(2)
    expect(unknown.all()).toContain('gates:changelog:')
  })

  it('runs as a process from the repository root, as the check runner does', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'packages/app/index.ts': 'export const a = 0\n' })
    repo.commit({ 'packages/app/index.ts': 'export const a = 1\n' }, `feat(app): change a\n\n${SIGNED}`)
    const result = runTsx(repo.root, CHECK, ['--base', base])
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('neither adds a fragment')
  })
})
