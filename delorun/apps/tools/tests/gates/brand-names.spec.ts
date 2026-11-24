import { describe, expect, it } from 'vitest'
import { fileErrors, isRead, lineFindings, readAllowlist, type Allowlist, type Rule } from '../../src/checks/gates/brand-names.ts'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NONE: Allowlist = { entries: [] }
// The old names are assembled at run time, so this file holds none for the gate to find.
const FIRST = ['D', 'elo'].join('')
const SPACED = `${FIRST} ${['R', 'un'].join('')}`
const HYPHENATED = `${FIRST}-${['R', 'un'].join('')}`
const JOINED = `${FIRST}${['R', 'un'].join('')}`
const SCOPE = ['@d', 'elo/'].join('')
const DEEPSEEK = ['Deep', 'Seek'].join('')
const DSH = ['D', 'SH'].join('')
const PATH = 'delorun/docs/guide/x.md'
const OWN_SOURCE = 'delorun/apps/tools/src/checks/gates/brand-names.ts'

function rules(text: string, path = PATH): Rule[] {
  return lineFindings(path, text).map(finding => finding.rule)
}

describe('the brand names gate', () => {
  describe('spelling', () => {
    it('refuses each old spelling of the name', () => {
      expect(rules(`Welcome to ${SPACED}.`)).toEqual(['spelling'])
      expect(rules(`Welcome to ${HYPHENATED}.`)).toEqual(['spelling'])
      expect(rules(`Welcome to ${JOINED}.`)).toEqual(['spelling'])
      expect(rules(`Welcome to ${SPACED.toLowerCase()}.`)).toEqual(['spelling'])
      expect(rules(`Welcome to ${FIRST}.`)).toEqual(['spelling'])
      expect(rules(`${FIRST.toUpperCase()} is here`)).toEqual(['spelling'])
    })

    it('accepts the name in every right form', () => {
      expect(rules('Delorun starts the studio.')).toEqual([])
      expect(rules('`delorun` and DELORUN_HOME and the @delorun/brand scope')).toEqual([])
      expect(rules('delorun-v2 and ~/src/delorun')).toEqual([])
    })

    it('refuses the first word next to Chinese text and accepts the right name there', () => {
      expect(rules(`${FIRST} 的设置`)).toEqual(['spelling'])
      expect(rules(`${FIRST}的设置`)).toEqual(['spelling'])
      expect(rules('Delorun 的设置')).toEqual([])
      expect(rules('Delorun的设置')).toEqual([])
    })

    it('accepts a URL to the repository, a hostname, a reverse-DNS label and a path segment', () => {
      expect(rules(`https://github.com/TwickaS/delorun/releases and https://github.com/twickas/${FIRST.toLowerCase()}-other/issues/1`)).toEqual([])
      expect(rules(`the spare host releases.${FIRST.toLowerCase()}.run`)).toEqual([])
      expect(rules(`the label run.${FIRST.toLowerCase()}.home`)).toEqual([])
      expect(rules(`built in /home/maker/${FIRST.toLowerCase()}/packages/x and ${FIRST.toLowerCase()}-review/notes.md`)).toEqual([])
    })
  })

  describe('scope', () => {
    it('refuses the old npm scope and accepts the right one', () => {
      expect(rules(`import { x } from '${SCOPE}brand'`)).toEqual(['scope'])
      expect(rules("import { x } from '@delorun/brand'")).toEqual([])
    })
  })

  describe('upstream-as-name', () => {
    it('refuses the upstream name presented as the name or maker of Delorun', () => {
      expect(rules(`Delorun (${DEEPSEEK} Harness) starts`)).toEqual(['upstream-as-name'])
      expect(rules(`Delorun (${DSH}) starts`)).toEqual(['upstream-as-name'])
      expect(rules(`Delorun（${DEEPSEEK} Harness）启动`)).toEqual(['upstream-as-name'])
      expect(rules(`${DEEPSEEK} Harness Delorun starts`)).toEqual(['upstream-as-name'])
      expect(rules(`${DEEPSEEK} Delorun starts`)).toEqual(['upstream-as-name'])
      expect(rules(`Delorun by ${DEEPSEEK}`)).toEqual(['upstream-as-name'])
      expect(rules(`Delorun is made by ${DEEPSEEK}`)).toEqual(['upstream-as-name'])
      expect(rules(`Delorun is ${DEEPSEEK} Harness`)).toEqual(['upstream-as-name'])
      expect(rules(`the official ${DEEPSEEK} Harness`)).toEqual(['upstream-as-name'])
      expect(rules(`the official ${DEEPSEEK} release`)).toEqual(['upstream-as-name'])
    })

    it('accepts the truthful wording about the relationship', () => {
      const truthful = [
        `Built on ${DEEPSEEK} Harness.`,
        `Delorun is a community fork of ${DEEPSEEK} Harness (DSH).`,
        `Import from DSH, from ${DEEPSEEK} Harness, or like ${DEEPSEEK} Harness.`,
        `Stock ${DEEPSEEK} Harness does this; compared with ${DEEPSEEK} Harness, Delorun adds a studio.`,
        `Your ${DEEPSEEK} Harness folder stays as it is.`,
        `The official ${DEEPSEEK} route comes first, and the official ${DEEPSEEK} listing reports the key.`,
        'DSH_BUILD_CLIENT_PROFILE=official DSH_TELEMETRY_DISABLED=1',
        `Copyright (c) 2026 ${DEEPSEEK}`,
        "mkdtempSync(join(tmpdir(), 'delorun-dsh-import-'))",
      ]
      for (const line of truthful) expect(rules(line), line).toEqual([])
    })
  })

  describe('the guidelines', () => {
    it('pass on the quoted list of forbidden spellings and not on another line that writes one', () => {
      const quoted = `- Never write "${FIRST}", "${SPACED}", "${HYPHENATED}" or "${JOINED}".`
      expect(rules(quoted, 'BRAND_GUIDELINES.md')).toEqual([])
      expect(rules(quoted, 'BRAND_GUIDELINES.zh.md')).toEqual([])
      expect(rules(quoted)).toEqual(['spelling'])
      expect(rules(`${quoted}\nWe love ${SPACED}.`, 'BRAND_GUIDELINES.md')).toEqual(['spelling'])
      expect(lineFindings('BRAND_GUIDELINES.md', `${quoted}\nWe love ${SPACED}.`).map(finding => finding.line)).toEqual([2])
    })
  })

  describe('paths', () => {
    it('reads the files Delorun owns', () => {
      for (const path of [
        'delorun/packages/home/src/index.ts',
        'delorun/docs/guide/x.zh.md',
        '.agents/skills/delorun-dev-workflow/SKILL.md',
        '.agents/notes/implemented/process/2026-11-06-delorun-contributions.md',
        '.github/workflows/ci.yml',
        'README.md',
        'README.zh.md',
        'BRAND_GUIDELINES.md',
        'CONTRIBUTING.md',
        'GOVERNANCE.md',
        'LICENSE',
      ]) expect(isRead(path), path).toBe(true)
    })

    it('does not read upstream\'s files or the records of history', () => {
      for (const path of [
        'packages/core/agent/src/index.ts',
        'docs/architecture.md',
        'CHANGELOG.md',
        'snapshots/x/expected.txt',
        'website/index.md',
        '.agents/skills/dsh-pre-push-checks/SKILL.md',
        '.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md',
        'delorun/changelog/releases/0.1.0-preview.1.md',
        'delorun/changelog/changelog.json',
        'delorun/upstream-patches.json',
      ]) expect(isRead(path), path).toBe(false)
      const text = `${SPACED} and ${SCOPE}x`
      expect(fileErrors('CHANGELOG.md', text, NONE)).toEqual([])
      expect(fileErrors('delorun/changelog/releases/0.1.0-preview.1.md', text, NONE)).toEqual([])
      expect(fileErrors('delorun/changelog/changelog.json', text, NONE)).toEqual([])
      expect(fileErrors('delorun/upstream-patches.json', text, NONE)).toEqual([])
      expect(fileErrors('snapshots/x.txt', text, NONE)).toEqual([])
    })
  })

  describe('the allowlist', () => {
    it('reports path, line and reason, and exempts one rule of one file', () => {
      const text = `fine\n${SPACED}\nimport '${SCOPE}x'`
      expect(fileErrors(PATH, text, NONE)).toHaveLength(2)
      expect(fileErrors(PATH, text, NONE)[0]).toContain(`${PATH}:2:`)
      const exempt: Allowlist = { entries: [{ path: PATH, rule: 'spelling', reason: 'test' }] }
      expect(fileErrors(PATH, text, exempt)).toEqual([`${PATH}:3: the old npm scope; the scope is @delorun/`])
      const other: Allowlist = { entries: [{ path: 'delorun/docs/other.md', rule: 'spelling', reason: 'test' }] }
      expect(fileErrors(PATH, text, other)).toHaveLength(2)
    })

    it('rejects an entry without a reason or with an unknown rule', () => {
      const dir = mkdtempSync(join(tmpdir(), 'brand-names-'))
      const write = (entries: unknown): string => {
        const file = join(dir, `${String(Math.random())}.json`)
        writeFileSync(file, JSON.stringify({ entries }))
        return file
      }
      expect(readAllowlist(write([{ path: PATH, rule: 'scope', reason: 'a truthful quote' }])).entries).toHaveLength(1)
      expect(() => readAllowlist(write([{ path: PATH, rule: 'scope' }]))).toThrow()
      expect(() => readAllowlist(write([{ path: PATH, rule: 'scope', reason: '' }]))).toThrow()
      expect(() => readAllowlist(write([{ path: PATH, rule: 'colour', reason: 'x' }]))).toThrow()
    })

    it('lists only the gate\'s own source in the repository, for the two rules its module comment quotes', () => {
      const entries = readAllowlist(join(import.meta.dirname, '../../src/checks/gates/brand-names.allowlist.json')).entries
      expect(entries.map(entry => `${entry.path} ${entry.rule}`)).toEqual([
        `${OWN_SOURCE} spelling`,
        `${OWN_SOURCE} upstream-as-name`,
      ])
    })

    it('leaves the gate\'s own source clean once its entries are applied', () => {
      const entries = readAllowlist(join(import.meta.dirname, '../../src/checks/gates/brand-names.allowlist.json'))
      expect(fileErrors(OWN_SOURCE, readFileSync(join(import.meta.dirname, '../../src/checks/gates/brand-names.ts'), 'utf8'), entries)).toEqual([])
      expect(fileErrors(OWN_SOURCE, readFileSync(join(import.meta.dirname, '../../src/checks/gates/brand-names.ts'), 'utf8'), NONE).length).toBeGreaterThan(0)
    })
  })
})
