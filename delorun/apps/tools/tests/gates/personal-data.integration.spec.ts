import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addedRuns,
  canonicalPattern,
  HASHES_PATH,
  hashPatterns,
  personalDataErrors,
  readHashes,
  rehash,
  type HashesFile,
  type Source,
} from '../../src/checks/gates/personal-data.ts'
import { gatePath, ledgerRepo, runTsx, scratchRepo } from './support.ts'

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
const RD = 'Rd'
const ZIP = ['12', '345'].join('')
const UK_LINE = `Flat 1, 1 Example ${ROAD}, Testington ${POSTCODE}`
const US_LINE = `100 Fictional ${STREET}, Nowhere, XX ${ZIP}`

// Upstream CSS text that an earlier shape check flagged: the `pl` abbreviation sits near a five-digit figure, with no address.
const UPSTREAM_LINE = '   and scrolls it). figma .InputText 34:10434 drew pl 16 / pr 12 / pt 4; the'

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
 * The throwaway hashes file as a repository stores it.
 * @returns the hashes file as JSON, with a final newline.
 */
function hashesJson(): string {
  return `${JSON.stringify(fixtureHashes(), null, 2)}\n`
}

/**
 * Consecutive lines of one file, notes.md, numbered from line 1.
 * @param texts - the lines.
 * @returns one source per line, each with its location.
 */
function fileRun(...texts: string[]): Source[] {
  return texts.map((text, index) => ({ where: `notes.md:${String(index + 1)}`, text, patterns: true }))
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
      const errors = personalDataErrors(hashes, [fileRun(text)])
      expect(errors).toEqual(['notes.md:1: matches a personal-data pattern (the pattern is not printed)'])
      expect(errors.join('\n')).not.toContain(NAME)
    }
  })

  it('passes a clean line, and a name that is only part of a longer pattern', () => {
    expect(personalDataErrors(fixtureHashes(), [fileRun('Contact the release team about the build.')])).toEqual([])
    expect(personalDataErrors(fixtureHashes(), [fileRun('Ivo wrote the note.')])).toEqual([])
  })

  it('does not match a commit message line, which the address check alone reads', () => {
    const source: Source = { where: 'commit abcdef1234 message:1', text: `Thanks to ${NAME}.`, patterns: false }
    expect(personalDataErrors(fixtureHashes(), [[source]])).toEqual([])
  })
})

describe('the postal-address shape', () => {
  it('refuses an invented full UK address and a full US address, and passes a number with no address', () => {
    expect(personalDataErrors(fixtureHashes(), [fileRun(UK_LINE)])).toEqual(['notes.md:1: carries a postal address'])
    expect(personalDataErrors(fixtureHashes(), [fileRun(US_LINE)])).toEqual(['notes.md:1: carries a postal address'])
    expect(personalDataErrors(fixtureHashes(), [fileRun('Version 12345 shipped on Monday.')])).toEqual([])
  })

  it('passes the upstream line that an earlier shape check flagged on its street abbreviation', () => {
    expect(personalDataErrors(fixtureHashes(), [fileRun(UPSTREAM_LINE)])).toEqual([])
  })

  it('refuses a UK address whose postcode is on the line after the street', () => {
    expect(personalDataErrors(fixtureHashes(), [fileRun(`Flat 1, 1 Example ${ROAD},`, `Testington ${POSTCODE}`)]))
      .toEqual(['notes.md:1: carries a postal address'])
  })

  it('passes a postcode two lines after the street, and a postcode before the street on the same line', () => {
    expect(personalDataErrors(fixtureHashes(), [fileRun(`Flat 1, 1 Example ${ROAD},`, 'Testington', POSTCODE)])).toEqual([])
    expect(personalDataErrors(fixtureHashes(), [fileRun(`${POSTCODE} 1 Example ${ROAD}`)])).toEqual([])
  })

  it('counts a two-letter street abbreviation only between a house number and a postcode', () => {
    expect(personalDataErrors(fixtureHashes(), [fileRun(`1 Example ${RD}, Testington ${POSTCODE}`)])).toEqual(['notes.md:1: carries a postal address'])
    expect(personalDataErrors(fixtureHashes(), [fileRun(`Version 2 of the ${RD} tool`)])).toEqual([])
  })

  it('needs a US state abbreviation and ZIP code after the street, on that line or the line after', () => {
    expect(personalDataErrors(fixtureHashes(), [fileRun(`100 Fictional ${STREET}, Nowhere, XX`)])).toEqual([])
    expect(personalDataErrors(fixtureHashes(), [fileRun(`100 Fictional ${STREET},`, `Nowhere, XX ${ZIP}`)])).toEqual(['notes.md:1: carries a postal address'])
    expect(personalDataErrors(fixtureHashes(), [fileRun(`XX ${ZIP} 100 Fictional ${STREET}`)])).toEqual([])
  })

  it('passes a full UK postcode that has no street address before it', () => {
    expect(personalDataErrors(fixtureHashes(), [fileRun(`Office postcode ${POSTCODE}`)])).toEqual([])
  })
})

describe('the added lines of a diff', () => {
  it('reads the added lines of each hunk with their new-file numbers, and a line that begins with ++ as added', () => {
    const diff = [
      'diff --git notes.md notes.md',
      'index 1111111..2222222 100644',
      '--- notes.md',
      '+++ notes.md',
      '@@ -2 +2,2 @@',
      '-old line',
      '+new line',
      '+++ a line that begins with two pluses',
      '@@ -10,0 +12 @@ context',
      '+a later line',
      'diff --git gone.md gone.md',
      'deleted file mode 100644',
      'index 3333333..0000000',
      '--- gone.md',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-first',
      '-second',
      '',
    ].join('\n')
    expect(addedRuns(diff)).toEqual([
      [
        { where: 'notes.md:2', text: 'new line', patterns: true },
        { where: 'notes.md:3', text: '++ a line that begins with two pluses', patterns: true },
      ],
      [{ where: 'notes.md:12', text: 'a later line', patterns: true }],
    ])
  })
})

describe('rehashing the local patterns', () => {
  it('writes the salt and one salted hash per pattern, and reads back the same hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delorun-rehash-'))
    dirs.push(dir)
    const patterns = join(dir, 'personal-data.txt')
    const hashes = join(dir, 'personal-data.hashes.json')
    writeFileSync(patterns, PATTERNS)
    expect(rehash(patterns, hashes, SALT)).toBe(3)
    expect(readHashes(hashes)).toEqual({ $comment: expect.any(String), algorithm: 'sha256', salt: SALT, hashes: hashPatterns(PATTERNS, SALT) })
    expect(readFileSync(hashes, 'utf8')).not.toContain(NAME)
  })

  it('reports a missing patterns file and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delorun-rehash-'))
    dirs.push(dir)
    const hashes = join(dir, 'personal-data.hashes.json')
    expect(() => rehash(join(dir, 'absent.txt'), hashes, SALT)).toThrow('no local patterns file')
    expect(existsSync(hashes)).toBe(false)
  })

  it('exits 1 from the command line when the local file is absent, and creates no file', (test) => {
    const home = mkdtempSync(join(tmpdir(), 'delorun-home-'))
    dirs.push(home)
    const { repo } = ledgerRepo(test)
    const result = runTsx(repo.root, gatePath('personal-data'), ['--rehash'], { HOME: home })
    expect(result.status).toBe(1)
    expect(result.output).toContain('no local patterns file')
    expect(existsSync(join(home, '.config', 'delorun', 'personal-data.txt'))).toBe(false)
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

  it('range mode ignores an upstream line that matches, because the range does not add it', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ [HASHES_PATH]: hashesJson(), 'notes.md': `${UK_LINE}\n` })
    repo.commit({ 'notes.md': `${UK_LINE}\nA clean note the range adds.\n` })
    const result = runTsx(repo.root, gatePath('personal-data'), ['--base', base])
    expect(result.status).toBe(0)
    expect(result.output).toContain('no personal data in the')
  }, 60_000)

  it('range mode refuses an invented full UK address and a full US address on an added line', (test) => {
    for (const address of [UK_LINE, US_LINE]) {
      const repo = scratchRepo(test)
      const base = repo.commit({ [HASHES_PATH]: hashesJson(), 'notes.md': 'A clean note.\n' })
      repo.commit({ 'notes.md': `A clean note.\n${address}\n` })
      const result = runTsx(repo.root, gatePath('personal-data'), ['--base', base])
      expect(result.status).toBe(1)
      expect(result.output).toContain('notes.md:2: carries a postal address')
    }
  }, 60_000)

  it('range mode refuses an added line that carries a hashed name, and prints no pattern', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ [HASHES_PATH]: hashesJson(), 'notes.md': 'A clean note.\n' })
    repo.commit({ 'notes.md': `A clean note.\nContact ${NAME} about the release.\n` })
    const result = runTsx(repo.root, gatePath('personal-data'), ['--base', base])
    expect(result.status).toBe(1)
    expect(result.output).toContain('notes.md:2: matches a personal-data pattern')
    expect(result.output).not.toContain(NAME)
  }, 60_000)

  it('staged mode reads only the lines the staged change adds to the given paths', (test) => {
    const repo = scratchRepo(test)
    const file = 'packages/client/InputBar.module.css'
    const upstream = ['/* draft */', UPSTREAM_LINE, UK_LINE]
    repo.commit({ [HASHES_PATH]: hashesJson(), [file]: `${upstream.join('\n')}\n` })
    repo.write({ [file]: `${upstream.join('\n')}\n.input { color: inherit; }\n` })
    repo.run(['add', file])
    expect(runTsx(repo.root, gatePath('personal-data'), [file]).status).toBe(0)
    repo.write({ [file]: `${upstream.join('\n')}\n.input { color: inherit; }\n${UK_LINE}\n` })
    repo.run(['add', file])
    const refused = runTsx(repo.root, gatePath('personal-data'), [file])
    expect(refused.status).toBe(1)
    expect(refused.output).toContain(`${file}:5: carries a postal address`)
  }, 60_000)

  it('with neither a base nor paths, reads each whole file that differs from the pinned upstream commit', (test) => {
    const { repo } = ledgerRepo(test)
    repo.commit({ [HASHES_PATH]: hashesJson(), 'notes.md': `${UK_LINE}\n` })
    const result = runTsx(repo.root, gatePath('personal-data'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('notes.md:1: carries a postal address')
  }, 60_000)
})
