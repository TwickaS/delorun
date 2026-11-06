import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanSecrets } from '../../src/checks/gates/secrets.ts'
import { gatePath, ledgerRepo, runTsx } from './support.ts'

// The fixtures' tokens are built at run time, so this file holds none for the gate to find.
const KEY = `sk-${'0123456789abcdef'.repeat(2)}`
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}123456`

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delo-secrets-spec-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// No path has an upstream copy.
const none = (): undefined => undefined

/**
 * Write one fixture file.
 * @param path - the path under the fixture root.
 * @param content - the file's text.
 * @returns the path, for passing to the scan.
 */
function file(path: string, content: string): string {
  writeFileSync(join(root, path), content)
  return path
}

describe('the secrets gate', () => {
  it('passes a finding on a line upstream\'s copy holds word for word, and refuses the same finding on a line the fork adds', async () => {
    const upstream = `export const key = '${KEY}'`
    const path = file('fixture.ts', `${upstream}\nexport const other = '${KEY}'\n`)
    const result = await scanSecrets(root, [path], name => name === 'fixture.ts' ? new Set([upstream]) : undefined)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/fixture\.ts\n\s+2:\d+\s+error /)
    expect(result.output).not.toMatch(/\s1:\d+\s+error /)
    expect((await scanSecrets(root, [file('only.ts', `${upstream}\n`)], () => new Set([upstream]))).ok).toBe(true)
  })

  it('refuses a DeepSeek-shaped key and masks it in the report', async () => {
    const result = await scanSecrets(root, [file('config.ts', `export const key = '${KEY}'\n`)], none)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/config\.ts\n\s+1:20\s+error .*@secretlint\/secretlint-rule-pattern/)
    expect(result.output).not.toContain(KEY)
  })

  it('refuses a token from the recommended preset, such as a GitHub token', async () => {
    expect((await scanSecrets(root, [file('notes.md', `token: ${GITHUB_TOKEN}\n`)], none)).ok).toBe(false)
  })

  it('refuses files named like secrets files, whatever they hold', async () => {
    const result = await scanSecrets(root, [file('.env', 'A=1\n'), file('.dev.vars', 'B=2\n')], none)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('.env')
    expect(result.output).toContain('.dev.vars')
  })

  it('skips a symbolic link, such as one to a directory of skills, and scans its target at its own path', async () => {
    mkdirSync(join(root, 'skills'))
    symlinkSync('skills', join(root, 'linked'))
    expect(await scanSecrets(root, ['linked'], none)).toEqual({ ok: true, output: '' })
    symlinkSync('index.ts', join(root, 'alias.ts'))
    expect((await scanSecrets(root, [file('index.ts', 'export const answer = 42\n'), 'alias.ts'], none)).ok).toBe(true)
  })

  it('passes ordinary files and an empty list', async () => {
    expect((await scanSecrets(root, [file('index.ts', 'export const answer = 42\n')], none)).ok).toBe(true)
    expect(await scanSecrets(root, [], none)).toEqual({ ok: true, output: '' })
  })

  it('refuses a staged file from the command line, and passes it once the secret is removed', (test) => {
    const { repo } = ledgerRepo(test)
    repo.write({ 'staged.ts': `export const key = '${KEY}'\n` })
    const refused = runTsx(repo.root, gatePath('secrets'), ['staged.ts'])
    expect(refused.status).toBe(1)
    expect(refused.output).not.toContain(KEY)
    repo.write({ 'staged.ts': 'export const key = process.env.KEY\n' })
    expect(runTsx(repo.root, gatePath('secrets'), ['staged.ts']).status).toBe(0)
  }, 60_000)
})
