import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalPattern,
  HASHES_PATH,
  hashPatterns,
  personalDataErrors,
  readHashes,
  rehash,
  type HashesFile,
  type Source,
} from '../../src/checks/gates/personal-data.ts'
import { gatePath, ledgerRepo, runTsx } from './support.ts'

// Throwaway salt and invented names: the patterns never reach a committed file in this spec.
const SALT = 'a1'.repeat(16)
const NAME = 'Ivo Quillfeather'
const EMAIL = 'ivo.quill@example.test'
const PHONE = '+1 555 0100'
const PATTERNS = `# comment\n${NAME}\n${EMAIL}\n${PHONE}\n`

// Address fixtures are assembled at run time, so this file holds no address shape for the gate to find.
const POSTCODE = ['Z9', '9ZZ'].join(' ')
const ROAD = ['Road'].join('')
const STREET = ['Street'].join('')
const ZIP = ['12', '345'].join('')
const UK_LINE = `Flat 1, 1 Example ${ROAD}, Testington ${POSTCODE}`
const US_LINE = `100 Fictional ${STREET}, Nowhere, XX ${ZIP}`

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The hashes file of the throwaway patterns.
 * @returns the salt and the hashed patterns.
 */
function fixtureHashes(): HashesFile {
  return { algorithm: 'sha256', salt: SALT, hashes: hashPatterns(PATTERNS, SALT) }
}

/**
 * One line of text as a source that the pattern check reads.
 * @param text - the line.
 * @returns the source, with its location.
 */
function line(text: string): Source {
  return { where: 'notes.md:1', text, patterns: true }
}

describe('canonical forms of the local patterns', () => {
  it('normalises names to lowercased words, emails to lowercase, and phone numbers to digits', () => {
    expect(canonicalPattern(NAME)).toBe('words:ivo quillfeather')
    expect(canonicalPattern(`  ${EMAIL.toUpperCase()}  `)).toBe(`email:${EMAIL}`)
    expect(canonicalPattern(PHONE)).toBe('phone:15550100')
    expect(canonicalPattern('# a comment')).toBeUndefined()
    expect(canonicalPattern('   ')).toBeUndefined()
  })

  it('refuses a pattern of more than eight words without repeating it', () => {
    const long = 'one two three four five six seven eight nine'
    expect(() => canonicalPattern(long)).toThrow('a pattern has more than 8 words')
    expect(() => hashPatterns(`ok\n${long}\n`, SALT)).toThrow('line 2: a pattern has more than 8 words')
  })
})

describe('the personal-data check of a line', () => {
  it('fails a line that carries a hashed name, email or phone number, and does not print the pattern', () => {
    const hashes = fixtureHashes()
    for (const text of [`Contact ${NAME} about the release.`, `Write to ${EMAIL} today.`, `Call ${PHONE} after noon.`]) {
      const errors = personalDataErrors(hashes, [line(text)])
      expect(errors).toEqual(['notes.md:1: matches a personal-data pattern (the pattern is not printed)'])
      expect(errors.join('\n')).not.toContain(NAME)
    }
  })

  it('passes a clean line, and a name that is only part of a longer pattern', () => {
    expect(personalDataErrors(fixtureHashes(), [line('Contact the release team about the build.')])).toEqual([])
    expect(personalDataErrors(fixtureHashes(), [line('Ivo wrote the note.')])).toEqual([])
  })

  it('does not match a commit message line, which the address check alone reads', () => {
    const source: Source = { where: 'commit abcdef1234 message:1', text: `Thanks to ${NAME}.`, patterns: false }
    expect(personalDataErrors(fixtureHashes(), [source])).toEqual([])
  })

  it('refuses a postal address by shape, and passes a line with a number and no address', () => {
    expect(personalDataErrors(fixtureHashes(), [line(UK_LINE)])).toEqual(['notes.md:1: carries a postal address'])
    expect(personalDataErrors(fixtureHashes(), [line(US_LINE)])).toEqual(['notes.md:1: carries a postal address'])
    expect(personalDataErrors(fixtureHashes(), [line('Version 12345 shipped on Monday.')])).toEqual([])
  })
})

describe('rehashing the local patterns', () => {
  it('writes the salt and one salted hash per pattern, and reads back the same hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delo-rehash-'))
    dirs.push(dir)
    const patterns = join(dir, 'personal-data.txt')
    const hashes = join(dir, 'personal-data.hashes.json')
    writeFileSync(patterns, PATTERNS)
    expect(rehash(patterns, hashes, SALT)).toBe(3)
    expect(readHashes(hashes)).toEqual({ $comment: expect.any(String), algorithm: 'sha256', salt: SALT, hashes: hashPatterns(PATTERNS, SALT) })
    expect(readFileSync(hashes, 'utf8')).not.toContain(NAME)
  })

  it('reports a missing patterns file and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delo-rehash-'))
    dirs.push(dir)
    const hashes = join(dir, 'personal-data.hashes.json')
    expect(() => rehash(join(dir, 'absent.txt'), hashes, SALT)).toThrow('no local patterns file')
    expect(existsSync(hashes)).toBe(false)
  })

  it('exits 1 from the command line when the local file is absent, and creates no file', (test) => {
    const home = mkdtempSync(join(tmpdir(), 'delo-home-'))
    dirs.push(home)
    const { repo } = ledgerRepo(test)
    const result = runTsx(repo.root, gatePath('personal-data'), ['--rehash'], { HOME: home })
    expect(result.status).toBe(1)
    expect(result.output).toContain('no local patterns file')
    expect(existsSync(join(home, '.config', 'delo', 'personal-data.txt'))).toBe(false)
  }, 60_000)
})

describe('gates:personal-data from the command line', () => {
  it('fails a commit whose author matches a hashed name, and passes a range of clean commits', (test) => {
    const { repo, base } = ledgerRepo(test)
    repo.write({ [HASHES_PATH]: `${JSON.stringify(fixtureHashes(), null, 2)}\n` })
    repo.run(['add', HASHES_PATH])
    repo.run(['commit', '-q', '-m', 'chore: add the hashes'])
    repo.run(['commit', '-q', '--allow-empty', '--author', `${NAME} <${EMAIL}>`, '-m', 'docs: a clean subject\n\nSigned-off-by: Fixture Author <fixture@example.test>'])
    const refused = runTsx(repo.root, gatePath('personal-data'), ['--base', base])
    expect(refused.status).toBe(1)
    expect(refused.output).toContain('author: matches a personal-data pattern')
    expect(refused.output).not.toContain(NAME)
  }, 60_000)

  it('passes when the range holds no pattern and no address', (test) => {
    const { repo, base } = ledgerRepo(test)
    repo.write({ [HASHES_PATH]: `${JSON.stringify(fixtureHashes(), null, 2)}\n` })
    repo.run(['add', HASHES_PATH])
    repo.run(['commit', '-q', '-m', 'chore: add the hashes'])
    expect(runTsx(repo.root, gatePath('personal-data'), ['--base', base]).status).toBe(0)
  }, 60_000)
})
