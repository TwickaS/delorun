import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prependBlock } from '../../src/changelog/assemble.ts'
import { ASSEMBLE, runTsx, scratchRepo, type Scratch } from './support.ts'

const FRAGMENTS = 'delo/changelog/unreleased/'
const SIGNED = 'Signed-off-by: Fixture Author <fixture@example.test>'

/**
 * A fragment file's text.
 * @param section - the section the front matter names.
 * @param bullets - the bullet lines of the body.
 * @returns the file text.
 */
function fragment(section: string, ...bullets: string[]): string {
  return `---\nsection: ${section}\n---\n\n${bullets.map(bullet => `- ${bullet}`).join('\n')}\n`
}

/**
 * A repository with the upstream ledger and three fragments: Security, Added and From upstream.
 * @param test - the running test.
 * @returns the repository.
 */
function releaseRepo(test: Parameters<typeof scratchRepo>[0]): Scratch {
  const repo = scratchRepo(test)
  repo.commit({
    'delo/upstream-patches.json': JSON.stringify({
      upstream: { repository: 'https://example.invalid/upstream.git', ref: 'dsh-v0.2.2-rc.1', commit: 'a'.repeat(40) },
      forkOwned: ['delo/'],
      patches: [],
      retired: [],
    }),
    [`${FRAGMENTS}lane-options.md`]: fragment('Added', 'The lane has two new options.'),
    [`${FRAGMENTS}replay-fix.md`]: fragment('Security', 'The replay no longer trusts a stale token.', 'Second security line.'),
    [`${FRAGMENTS}upstream-lane.md`]: fragment('From upstream', 'The upstream lane now streams progress.'),
  }, `chore(release): fixture\n\n${SIGNED}`)
  return repo
}

describe('the release-notes assembly', () => {
  it('dry-run prints a CHANGELOG.md block and notes with a From upstream section naming dsh-v0.2.2-rc.1, and writes nothing', (test) => {
    const repo = releaseRepo(test)
    const before = repo.run(['status', '--porcelain'])
    const result = runTsx(repo.root, ASSEMBLE, ['--version', '0.1.0-alpha.1', '--dry-run'])
    expect(result.status).toBe(0)
    expect(result.output).toContain('## 0.1.0-alpha.1')
    expect(result.output).toContain('# Delo 0.1.0-alpha.1')
    expect(result.output).toContain('### From upstream\n- Based on DeepSeek Harness `dsh-v0.2.2-rc.1`.\n- The upstream lane now streams progress.')
    expect(result.output.indexOf('### Security')).toBeLessThan(result.output.indexOf('### Added'))
    expect(result.output.indexOf('### Added')).toBeLessThan(result.output.indexOf('### From upstream'))
    expect(existsSync(join(repo.root, 'CHANGELOG.md'))).toBe(false)
    expect(existsSync(join(repo.root, 'delo/changelog/releases'))).toBe(false)
    expect(repo.run(['status', '--porcelain'])).toBe(before)
  })

  it('moves the consumed fragments, writes the notes, and prepends the block to CHANGELOG.md', (test) => {
    const repo = releaseRepo(test)
    expect(runTsx(repo.root, ASSEMBLE, ['--version', '0.1.0-alpha.1']).status).toBe(0)
    expect(existsSync(join(repo.root, FRAGMENTS, 'lane-options.md'))).toBe(false)
    expect(existsSync(join(repo.root, 'delo/changelog/releases/0.1.0-alpha.1/lane-options.md'))).toBe(true)
    expect(readFileSync(join(repo.root, 'delo/changelog/releases/0.1.0-alpha.1.md'), 'utf8')).toContain('## From upstream')
    expect(readFileSync(join(repo.root, 'CHANGELOG.md'), 'utf8')).toMatch(/^# Changelog\n\n## 0\.1\.0-alpha\.1\n/)

    repo.commit({ [`${FRAGMENTS}later.md`]: fragment('Fixed', 'A later fix.') }, `fix(release): later\n\n${SIGNED}`)
    expect(runTsx(repo.root, ASSEMBLE, ['--version', '0.1.0-alpha.2']).status).toBe(0)
    const changelog = readFileSync(join(repo.root, 'CHANGELOG.md'), 'utf8')
    expect(changelog.indexOf('## 0.1.0-alpha.2')).toBeLessThan(changelog.indexOf('## 0.1.0-alpha.1'))
  })

  it('refuses 1.0.0 without --first-public-release and admits it with the flag', (test) => {
    const repo = releaseRepo(test)
    const refused = runTsx(repo.root, ASSEMBLE, ['--version', '1.0.0', '--dry-run'])
    expect(refused.status).toBe(1)
    expect(refused.output).toContain('pass --first-public-release')
    expect(runTsx(repo.root, ASSEMBLE, ['--version', '1.0.0', '--dry-run', '--first-public-release']).status).toBe(0)
  })

  it('refuses a version that is not strict semver and a fragment that does not parse', (test) => {
    const repo = releaseRepo(test)
    expect(runTsx(repo.root, ASSEMBLE, ['--version', 'v0.1.0-alpha.1', '--dry-run']).status).toBe(1)
    repo.commit({ [`${FRAGMENTS}bad.md`]: fragment('Bogus', 'Nothing.') }, `docs(changelog): bad\n\n${SIGNED}`)
    const result = runTsx(repo.root, ASSEMBLE, ['--version', '0.1.0-alpha.1', '--dry-run'])
    expect(result.status).toBe(1)
    expect(result.output).toContain('section "Bogus" is not one of')
  })
})

describe('the changelog file', () => {
  it('creates the file with its title when absent, and prepends each block after the title', () => {
    expect(prependBlock('', '## 0.1.0-alpha.1\n')).toBe('# Changelog\n\n## 0.1.0-alpha.1\n')
    expect(prependBlock('# Changelog\n\n## 0.1.0-alpha.1\n\n- Old.\n', '## 0.1.0-alpha.2\n'))
      .toBe('# Changelog\n\n## 0.1.0-alpha.2\n\n## 0.1.0-alpha.1\n\n- Old.\n')
  })
})
