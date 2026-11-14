import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { formatReport, main, POST_STEPS, type PostStep, runPostSteps, runRename } from '../../src/rename/rename.ts'

function repo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'rename-spec-'))
  const run = (...args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'ignore' }) }
  run('init', '-q')
  run('config', 'user.email', 'spec@example.invalid')
  run('config', 'user.name', 'spec')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  symlinkSync('delo/a.md', join(root, 'link.md'))
  run('add', '-A')
  run('commit', '-q', '-m', 'init')
  return root
}

const FILES = {
  'delo/a.md': 'Delo keeps ~/.delo; Delo Run maintains it; see delo.run.\n',
  'delo/delo-b.ts': "export const deloHome = process.env['DELO_HOME']\n",
  'pnpm-lock.yaml': "'@delo/cli':\n",
  'snapshots/x/system-prompt.expected.md': 'Delo\n',
  'logo.bin': Buffer.from([0, 68, 101, 108, 111]),
  'latin1.txt': Buffer.from([0xff, 0xfe, 68, 101, 108, 111]),
}

describe('runRename', () => {
  it('reports without writing in a dry run, even on a dirty tree', () => {
    const root = repo(FILES)
    writeFileSync(join(root, 'dirty.txt'), 'x')
    const report = runRename(root, { dryRun: true, allowDirty: false })
    expect(report.changedFiles).toBe(2)
    expect(report.snapshotFilesWithName).toBe(1)
    expect([...report.skippedBinary].sort()).toEqual(['latin1.txt', 'logo.bin'])
    expect(report.renames.map(rename => rename.to)).toEqual(['delo/delorun-b.ts', 'delorun'])
    expect(readFileSync(join(root, 'delo/a.md'), 'utf8')).toContain('Delo keeps')
    expect(formatReport(report, true)).toContain('rename (dry run; nothing written)')
  })

  it('refuses a dirty tree', () => {
    const root = repo(FILES)
    writeFileSync(join(root, 'dirty.txt'), 'x')
    expect(() => runRename(root, { dryRun: false, allowDirty: false })).toThrow('uncommitted changes')
  })

  it('refuses a rename whose target path already exists, before writing anything', () => {
    const root = repo(FILES)
    mkdirSync(join(root, 'delorun'))
    writeFileSync(join(root, 'delorun', 'leftover'), 'x')
    expect(() => runRename(root, { dryRun: false, allowDirty: true })).toThrow('target path already exists')
    expect(readFileSync(join(root, 'delo/a.md'), 'utf8')).toContain('Delo keeps')
  })

  it('rewrites content, renames paths with git mv, and changes nothing on a second run', () => {
    const root = repo(FILES)
    const report = runRename(root, { dryRun: false, allowDirty: false })
    expect(report.changedFiles).toBe(2)
    expect(readFileSync(join(root, 'delorun/a.md'), 'utf8')).toBe('Delorun keeps ~/.delorun; Delo Run maintains it; see delo.run.\n')
    expect(readFileSync(join(root, 'delorun/delorun-b.ts'), 'utf8')).toBe("export const delorunHome = process.env['DELORUN_HOME']\n")
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toContain('@delo/cli')
    expect(readFileSync(join(root, 'snapshots/x/system-prompt.expected.md'), 'utf8')).toBe('Delo\n')
    expect(existsSync(join(root, 'delo'))).toBe(false)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toContain('RM delo/delo-b.ts -> delorun/delorun-b.ts')
    const again = runRename(root, { dryRun: false, allowDirty: true })
    expect(again.changedFiles).toBe(0)
    expect(again.renames).toEqual([])
    expect(formatReport(again, false)).toContain('rename (applied)')
  })

  it('samples at most a dozen changed lines in the diff', () => {
    const root = repo({ 'many.md': 'Delo\n'.repeat(30) })
    const report = runRename(root, { dryRun: true, allowDirty: false })
    expect(report.diffSample).toHaveLength(12)
    expect(report.diffSample[0]).toContain('-Delo\n+Delorun')
    expect(formatReport(report, true)).toContain('@@ -1 +1 @@')
  })
})

describe('main', () => {
  it('rejects unknown arguments, reports failures and prints the report', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = repo(FILES)
    expect(main(['--nope'], root)).toBe(2)
    writeFileSync(join(root, 'dirty.txt'), 'x')
    expect(main([], root)).toBe(1)
    expect(main(['--dry-run', '--skip-regenerate'], root)).toBe(0)
    expect(main(['--dry-run', '--skip-regenerate'], join(root, 'missing'))).toBe(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(3)
    vi.restoreAllMocks()
  })

  it('lists every regeneration step in a dry run', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(runPostSteps('/nowhere', true)).toBe(0)
    expect(log).toHaveBeenCalledTimes(POST_STEPS.length)
    expect(log.mock.calls[0]?.[0]).toContain('pnpm install --lockfile-only')
    vi.restoreAllMocks()
  })

  it('accepts a listed non-zero exit status and fails a required step on any other', () => {
    const exits = (status: number, acceptedStatuses?: readonly number[]): PostStep => ({ description: 'stub', command: ['sh', '-c', `exit ${String(status)}`], required: true, acceptedStatuses })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(runPostSteps('/tmp', false, [exits(3, [3])])).toBe(0)
    expect(runPostSteps('/tmp', false, [exits(3)])).toBe(1)
    expect(runPostSteps('/tmp', false, [exits(2, [3])])).toBe(1)
    expect(POST_STEPS.find(step => step.command.some(word => word.endsWith('ledger-record.ts')))?.acceptedStatuses).toEqual([3])
    error.mockRestore()
    log.mockRestore()
  })
})
