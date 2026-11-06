import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeWarning, pinnedNodeMajor } from '../src/setup-worktree.ts'

describe('setup-worktree', () => {
  it('reads the pinned Node major from .nvmrc', () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-worktree-'))
    expect(pinnedNodeMajor(root)).toBeUndefined()
    writeFileSync(join(root, '.nvmrc'), '24\n')
    expect(pinnedNodeMajor(root)).toBe(24)
    writeFileSync(join(root, '.nvmrc'), 'v24.22.0\n')
    expect(pinnedNodeMajor(root)).toBe(24)
  })

  it('warns only when the running major differs from the pin', () => {
    expect(nodeWarning('v24.22.0', 24)).toBeUndefined()
    expect(nodeWarning('v26.12.1', 24)).toContain('pins Node 24')
    expect(nodeWarning('v26.12.1', undefined)).toBeUndefined()
  })
})
