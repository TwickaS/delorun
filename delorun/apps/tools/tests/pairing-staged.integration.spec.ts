import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareViolations, headBase, main, stagedRenames, violationKey } from '../src/pairing-staged.ts'
import { REPO, scratchRepo, type Scratch } from './gates/support.ts'

afterEach(() => { vi.restoreAllMocks() })

const TSX = join(REPO, 'node_modules/.bin/tsx')

/** A paired document: English source with a section, and its Chinese translation with the language switcher. */
const EN = '# Guide\n\nEnglish | [中文](guide.zh.md)\n\n## Setup\n\nInstall it.\n'
const ZH = '# 指南\n\n[English](guide.md) | 中文\n\n## 安装\n\n安装它。\n'

/**
 * A scratch repository holding the upstream checker and one recorded, consistent pair.
 * @param test - the running test.
 * @returns the repository.
 */
function pairingRepo(test: Parameters<typeof scratchRepo>[0]): Scratch {
  const repo = scratchRepo(test)
  cpSync(join(REPO, 'scripts'), join(repo.root, 'scripts'), { recursive: true })
  symlinkSync(join(REPO, 'node_modules'), join(repo.root, 'node_modules'))
  writeFileSync(join(repo.root, '.gitignore'), 'node_modules\n')
  repo.write({ 'docs/guide.md': EN, 'docs/guide.zh.md': ZH })
  execFileSync(TSX, ['scripts/verify-translation-pairing.ts', '--write', 'docs/guide.md'], { cwd: repo.root, timeout: 30_000 })
  repo.commit({})
  return repo
}

/**
 * Run the wrapper on the staged records and collect what it prints.
 * @param repo - the repository.
 * @param records - the staged record paths.
 * @returns the exit status and the printed lines.
 */
function hook(repo: Scratch, records: readonly string[]): { status: number; lines: string[] } {
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(line) })
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => { lines.push(String(text)); return true })
  const status = main(records, repo.root)
  vi.restoreAllMocks()
  return { status, lines }
}

/** The Chinese side with a table the English side lacks: structural drift that recording a pair accepts. */
const TABLE_ZH = `${ZH}\n| 列 |\n| --- |\n| 值 |\n`

/** Drift the Chinese side from the record by adding a section only there. */
const DRIFTED_ZH = `${ZH}\n## 多余\n\n只在这里。\n`

describe('pairing keys', () => {
  it('maps a renamed pair to its old base and ignores line numbers', () => {
    expect(headBase('delorun/a', new Map([['delorun/a.md', 'delorun/a.md']]))).toBe('delorun/a')
    expect(headBase('x/a', new Map())).toBe('x/a')
    expect(violationKey('delorun/a.zh.md:12: link', new Map([['delorun/a', 'delorun/a']]))).toBe('delorun/a.zh.md: link')
  })

  it('matches a violation whose quoted value the checker now cuts where it was whole before', () => {
    const value = 'dsh-translation-target:delorun/docs/contracts/c04-admission.md#sessions'
    const before = `delorun/a.md ↔ delorun/a.zh.md: link target #3 diverges between the pair: "${value}" vs "#requirements"`
    const after = `delorun/a.md ↔ delorun/a.zh.md: link target #3 diverges between the pair: "${value.slice(0, 70)}… vs "#requirements"`
    expect(compareViolations([after], [before], new Map([['delorun/a', 'delorun/a']])).added).toEqual([])
  })

  it('counts a repeated violation once per occurrence', () => {
    const verdict = compareViolations(['v', 'v'], ['v'], new Map())
    expect(verdict.existing).toEqual(['v'])
    expect(verdict.added).toEqual(['v'])
  })
})

describe('staged renames', () => {
  it('finds renames when the rename limit is lower than the number of changed files', (test) => {
    const repo = scratchRepo(test)
    repo.run(['config', 'diff.renameLimit', '1'])
    const files = Object.fromEntries(['a', 'b', 'c', 'd'].map(name => [`old/${name}.md`, `# ${name}\n\n${name.repeat(40)}\n`]))
    repo.commit(files)
    repo.run(['mv', 'old', 'new'])
    expect(stagedRenames(repo.root).get('new/a.md')).toBe('old/a.md')
  })
})

describe('the staged pairing hook', () => {
  it('passes a consistent pair silently', (test) => {
    const repo = pairingRepo(test)
    repo.write({ 'docs/guide.md': EN })
    repo.run(['add', '-A'])
    expect(hook(repo, ['docs/guide.i18n.yaml'])).toEqual({ status: 0, lines: [] })
  })

  it('passes an existing violation that the commit leaves unchanged, and reports it', (test) => {
    const repo = pairingRepo(test)
    repo.commit({ 'docs/guide.zh.md': DRIFTED_ZH })
    repo.write({ 'docs/guide.md': `${EN}\n`, 'docs/other.txt': 'x' })
    repo.run(['add', '-A'])
    const { status, lines } = hook(repo, ['docs/guide.i18n.yaml'])
    expect(lines.join('\n')).toContain('existing drift, not blocking')
    expect(status).toBe(0)
  })

  it('refuses a new violation on a changed record', (test) => {
    const repo = pairingRepo(test)
    repo.write({ 'docs/guide.zh.md': DRIFTED_ZH })
    repo.run(['add', '-A'])
    const { status, lines } = hook(repo, ['docs/guide.i18n.yaml'])
    expect(lines.join('\n')).toContain('new bilingual-pairing violation')
    expect(status).toBe(1)
  })

  it('passes a renamed record that carries the same existing violation', (test) => {
    const repo = pairingRepo(test)
    repo.commit({ 'docs/guide.zh.md': DRIFTED_ZH })
    mkdirSync(join(repo.root, 'docs/moved'))
    repo.run(['mv', 'docs/guide.md', 'docs/moved/guide.md'])
    repo.run(['mv', 'docs/guide.zh.md', 'docs/moved/guide.zh.md'])
    repo.run(['mv', 'docs/guide.i18n.yaml', 'docs/moved/guide.i18n.yaml'])
    const { status, lines } = hook(repo, ['docs/moved/guide.i18n.yaml'])
    expect(lines.join('\n')).toContain('existing drift, not blocking')
    expect(status).toBe(0)
  })

  describe('a pair whose record is stale at HEAD', () => {
    /**
     * A repository whose Chinese side drifted at HEAD with the record left stale, so the checker stops at "out of
     * sync" and never lists the structural drift; the staged side re-records it, which exposes that drift.
     * @param test - the running test.
     * @param zh - the staged Chinese text.
     * @returns the repository with the re-recorded pair staged.
     */
    function staleThenRerecorded(test: Parameters<typeof scratchRepo>[0], zh: string): Scratch {
      const repo = pairingRepo(test)
      repo.commit({ 'docs/guide.zh.md': TABLE_ZH })
      repo.write({ 'docs/guide.zh.md': zh })
      execFileSync(TSX, ['scripts/verify-translation-pairing.ts', '--write', 'docs/guide.md'], { cwd: repo.root, timeout: 30_000 })
      repo.run(['add', '-A'])
      return repo
    }

    it('passes when re-recording exposes only the structural drift HEAD already hid', (test) => {
      const repo = staleThenRerecorded(test, TABLE_ZH)
      const { status, lines } = hook(repo, ['docs/guide.i18n.yaml'])
      expect(lines.join('\n')).toContain('existing drift, not blocking')
      expect(status).toBe(0)
    })

    it('refuses a structural difference the commit adds on top of the hidden drift', (test) => {
      const repo = staleThenRerecorded(test, `${TABLE_ZH}\n- 只在这里的项目\n`)
      const { status, lines } = hook(repo, ['docs/guide.i18n.yaml'])
      expect(lines.join('\n')).toContain('new bilingual-pairing violation')
      expect(status).toBe(1)
    })
  })

  it('refuses a new record that has a violation', (test) => {
    const repo = pairingRepo(test)
    repo.write({ 'docs/fresh.md': '# Fresh\n\n## One\n\nText.\n', 'docs/fresh.zh.md': '# 新\n\n[English](fresh.md) | 中文\n', 'docs/fresh.i18n.yaml': '/:\n  en: 0000000000000000\n  zh: 0000000000000000\n' })
    repo.run(['add', '-A'])
    expect(hook(repo, ['docs/fresh.i18n.yaml']).status).toBe(1)
  })

  it('fails on a usage error', (test) => {
    const repo = pairingRepo(test)
    expect(hook(repo, ['docs/i18n/terminology.i18n.yaml']).status).toBe(2)
  })
})
