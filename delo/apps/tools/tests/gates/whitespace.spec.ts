import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { endProblem, fixText, main, parseDiffCheck } from '../../src/checks/gates/whitespace.ts'
import { scratchRepo } from './support.ts'

afterEach(() => { vi.restoreAllMocks() })

/**
 * Run the gate in-process and collect what it prints.
 * @param root - the repository.
 * @param args - the gate's arguments.
 * @returns the exit status and the printed lines.
 */
function gate(root: string, args: readonly string[]): { status: number; lines: string[] } {
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(line) })
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
  const status = main(args, root)
  vi.restoreAllMocks()
  return { status, lines }
}

describe('the whitespace gate', () => {
  it('reads git\'s check output', () => {
    expect(parseDiffCheck('a.ts:3: trailing whitespace.\n+x  \nb b.md:1: new blank line at EOF.\n')).toEqual([
      { path: 'a.ts', line: 3, problem: 'trailing whitespace' },
      { path: 'b b.md', line: 1, problem: 'new blank line at EOF' },
    ])
  })

  it('wants exactly one final newline in a text file, and ignores empty and binary files', () => {
    expect(endProblem(Buffer.from('a\n'))).toBeUndefined()
    expect(endProblem(Buffer.from('a'))).toBe('no newline at the end of the file')
    expect(endProblem(Buffer.from('a\n\n'))).toBe('more than one newline at the end of the file')
    expect(endProblem(Buffer.from('\n'))).toBeUndefined()
    expect(endProblem(Buffer.alloc(0))).toBeUndefined()
    expect(endProblem(Buffer.from([1, 0, 2]))).toBeUndefined()
  })

  it('fixes the reported lines and the end of the file only', () => {
    expect(fixText('a  \nb  \nc', new Set([1]))).toBe('a\nb  \nc\n')
    expect(fixText('a\n\n\n', new Set())).toBe('a\n')
  })

  it('refuses a change with trailing whitespace or a missing final newline, committed or not, and passes a clean one', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'old.md': 'kept  \n', 'b.ts': 'export {}\n' })
    repo.commit({ 'a.ts': 'const a = 1  \nexport { a }\n' })
    repo.write({ 'b.ts': 'export {}', 'new.md': 'untracked\n\n' })
    const failed = gate(repo.root, ['--base', base])
    expect(failed.status).toBe(1)
    expect(failed.lines.slice(0, -1).sort()).toEqual(['a.ts:1: trailing whitespace', 'b.ts: no newline at the end of the file', 'new.md: more than one newline at the end of the file'])
    expect(failed.lines.at(-1)).toContain(`whitespace.ts --base ${base} --fix\` repairs`)

    const clean = scratchRepo(test)
    const cleanBase = clean.commit({ 'a.ts': 'export {}\n' })
    clean.commit({ 'b.ts': 'export {}\n' })
    expect(gate(clean.root, ['--base', cleanBase])).toEqual({ status: 0, lines: ['gates:whitespace: no whitespace error in the changed files'] })
  }, 30_000)

  it('repairs trailing whitespace and final newlines with --fix, leaves what needs a person, and leaves untouched files alone', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'old.md': 'kept  \n' })
    repo.write({ 'old.md': 'kept  \nadded  \n\n', 'tab.ts': 'x\n' })
    repo.commit({ 'tab.ts': ' \tindented\n' })
    const fixed = gate(repo.root, ['--base', base, '--fix'])
    expect(readFileSync(join(repo.root, 'old.md'), 'utf8')).toBe('kept  \nadded\n')
    expect(fixed.status).toBe(1)
    expect(fixed.lines[0]).toBe('tab.ts:1: space before tab in indent')

    const simple = scratchRepo(test)
    const simpleBase = simple.commit({ 'a.md': 'a\n' })
    simple.write({ 'a.md': 'a\nb' })
    expect(gate(simple.root, ['--base', simpleBase, '--fix'])).toEqual({ status: 0, lines: ['gates:whitespace: fixed; review and commit the changes'] })
    expect(readFileSync(join(simple.root, 'a.md'), 'utf8')).toBe('a\nb\n')
  }, 30_000)

  it('needs --base', () => {
    expect(gate(process.cwd(), [])).toEqual({ status: 2, lines: ['gates:whitespace: pass --base <rev>'] })
  })
})
