import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEFTHOOK_LOCAL_CONTENT, nodeWarning, pinnedNodeMajor, writeHooksFile } from '../src/setup-worktree.ts'

describe('setup-worktree', () => {
  it('reads the pinned Node major from .nvmrc', () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-worktree-'))
    expect(pinnedNodeMajor(root)).toBeUndefined()
    writeFileSync(join(root, '.nvmrc'), '24\n')
    expect(pinnedNodeMajor(root)).toBe(24)
    writeFileSync(join(root, '.nvmrc'), 'v24.22.0\n')
    expect(pinnedNodeMajor(root)).toBe(24)
  })

  it('writes lefthook-local.yml extending delorun/lefthook.yml, and keeps an existing file that extends it', () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-worktree-'))
    expect(writeHooksFile(root)).toBe(true)
    expect(readFileSync(join(root, 'lefthook-local.yml'), 'utf8')).toBe(LEFTHOOK_LOCAL_CONTENT)
    writeFileSync(join(root, 'lefthook-local.yml'), 'extends: [delorun/lefthook.yml]\npre-commit:\n  jobs: []\n')
    expect(writeHooksFile(root)).toBe(false)
    expect(readFileSync(join(root, 'lefthook-local.yml'), 'utf8')).toContain('pre-commit:')
  })

  it('refuses an existing lefthook-local.yml that does not extend delorun/lefthook.yml, a commented one included', () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-worktree-'))
    for (const text of ['extends:\n  - other.yml\n', '# extends: [delorun/lefthook.yml]\n']) {
      writeFileSync(join(root, 'lefthook-local.yml'), text)
      expect(() => writeHooksFile(root)).toThrow('does not extend delorun/lefthook.yml, so Delorun\'s hooks would not run')
    }
  })

  it('warns only when the running major differs from the pin', () => {
    expect(nodeWarning('v24.22.0', 24)).toBeUndefined()
    expect(nodeWarning('v26.12.1', 24)).toContain('pins Node 24')
    expect(nodeWarning('v26.12.1', undefined)).toBeUndefined()
  })
})
