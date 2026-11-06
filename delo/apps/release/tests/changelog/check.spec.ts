import { describe, expect, it } from 'vitest'
import { CHECK, runTsx, scratchRepo, type Scratch } from './support.ts'

const SIGNED = 'Signed-off-by: Fixture Author <fixture@example.test>'
const FRAGMENTS = 'delo/changelog/unreleased/'

/**
 * A fragment file's text.
 * @param section - the section the front matter names.
 * @param bullet - the bullet line of the body.
 * @returns the file text.
 */
function fragment(section: string, bullet: string): string {
  return `---\nsection: ${section}\n---\n\n- ${bullet}\n`
}

/**
 * Run the changelog gate over the commits after a base revision.
 * @param repo - the fixture repository.
 * @param base - the revision the range starts after.
 * @returns the exit status and the combined output.
 */
function gate(repo: Scratch, base: string): { status: number; output: string } {
  return runTsx(repo.root, CHECK, ['--base', base])
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
})
