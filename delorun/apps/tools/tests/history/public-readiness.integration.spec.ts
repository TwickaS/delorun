/**
 * The public-readiness patterns: which text counts as one person's machine, account or planning label, which examples
 * pass, and that reports and value lists carry what the replacement map needs and nothing else.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readinessValues, scanTree } from '../../src/history/scan-history.ts'
import { identityProblem, readTerms, readinessMatches } from '../../src/history/public-readiness.ts'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

/** A scratch directory that the test removes. */
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'delorun-readiness-'))
  scratch.push(path)
  return path
}

const kinds = (text: string): string[] => readinessMatches(text).map(match => match.kind)

describe('home paths', () => {
  it('names a person in a Linux, macOS, WSL or Windows home path', () => {
    expect(kinds('cd /home/someone-real/work')).toEqual(['Linux home path'])
    expect(kinds('open /Users/jane/Desktop')).toEqual(['macOS home path'])
    expect(kinds('/mnt/c/Users/jane/bin/tool.exe')).toEqual(['WSL Windows home path'])
    expect(kinds('C:\\Users\\jane\\bin')).toEqual(['Windows home path'])
    expect(kinds('c:/Users/jane/bin')).toEqual(['Windows home path'])
  })

  it('passes an example owner, a template and a path that merely ends in home', () => {
    expect(kinds('/home/user/proj and /Users/runner/work and C:\\Users\\Public')).toEqual([])
    expect(kinds('${HOME}/x and ~/x and /var/home')).toEqual([])
    expect(kinds('/mnt/c/Users')).toEqual([])
  })
})

describe('planning labels', () => {
  it('finds a decision number, a strategy number, a wave, a plan page and the built-so-far heading', () => {
    expect(kinds('the rule (A361) and A12b')).toEqual(['planning decision number', 'planning decision number'])
    expect(kinds('ST41 and PC3')).toEqual(['planning strategy number', 'planning strategy number'])
    expect(kinds('wave 2 and Wave1')).toEqual(['planning wave', 'planning wave'])
    expect(kinds('see delorun/docs/plans/next.md')).toEqual(['planning document path'])
    expect(kinds('## What is built so far')).toEqual(['planning heading'])
    expect(kinds('the V4.5 decision')).toEqual(['planning name'])
  })

  it('passes a UUID segment, a paper size, a hash and a product word', () => {
    expect(kinds('0000-A000-000000000000')).toEqual([])
    expect(kinds('A4 paper and sha256 ABC123 and A1')).toEqual([])
    expect(kinds('a waveform and a wave of requests')).toEqual([])
  })
})

describe('terms from outside the repository', () => {
  it('reads kind and value lines, skips comments, and refuses a line without a tab', () => {
    const dir = directory()
    writeFileSync(join(dir, 'terms.txt'), '# comment\n\nmachine name\tbox-7\n')
    expect(readTerms(join(dir, 'terms.txt'))).toEqual([{ kind: 'machine name', value: 'box-7' }])
    writeFileSync(join(dir, 'bad.txt'), 'machine name box-7\n')
    expect(() => readTerms(join(dir, 'bad.txt'))).toThrow('bad.txt:1: a term is kind<TAB>value')
    writeFileSync(join(dir, 'empty.txt'), 'machine name\t\n')
    expect(() => readTerms(join(dir, 'empty.txt'))).toThrow('a term is kind<TAB>value')
  })

  it('matches a term in any case and every time it occurs', () => {
    const terms = [{ kind: 'machine name', value: 'box-7' }]
    expect(readinessMatches('Box-7 and box-7', terms)).toEqual([{ kind: 'machine name', value: 'Box-7' }, { kind: 'machine name', value: 'box-7' }])
  })
})

describe('commit identities', () => {
  it('admits the public address and the model trailer address, and names any other', () => {
    expect(identityProblem({ name: 'A', email: 'a@delorun.com' })).toBeUndefined()
    expect(identityProblem({ name: 'A', email: 'noreply@anthropic.com' })).toBeUndefined()
    expect(identityProblem({ name: 'A', email: 'a@example.org' })).toBe('non-public email address')
  })
})

describe('the tree scan and the value list', () => {
  it('reports the path and line of each match, skips binary files, symlinks and the skipped prefixes, and never prints the matched text', () => {
    const dir = directory()
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 }) }
    git('init', '-q')
    mkdirSync(join(dir, 'vendor'))
    writeFileSync(join(dir, 'a.md'), 'fine\nsee /home/someone-real/x\n')
    writeFileSync(join(dir, 'vendor/b.md'), '/home/someone-real/y\n')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 47, 104, 111, 109, 101, 47, 98, 98]))
    git('add', '-A')
    const findings = scanTree(dir, [{ kind: 'machine name', value: 'box-7' }])
    expect(findings.map(({ gate, commit, where, kind }) => ({ gate, commit, where, kind }))).toEqual([{ gate: 'public-readiness', commit: 'tree', where: 'a.md:2', kind: 'Linux home path' }])
    expect(readinessValues([...findings, ...findings])).toEqual(['Linux home path\t/home/someone-real\t2'])
  })
})
