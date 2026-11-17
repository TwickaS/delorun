import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordAbsentNames, removeSandboxLeftovers } from '../src/leftovers.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ea1-codex-leftovers-'))
  roots.push(root)
  return root
}

describe('sandbox leftovers (decision 5)', () => {
  it('records only the protected names a root lacks', () => {
    const root = scratch()
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.codex'), '')
    expect(recordAbsentNames([root, root])).toEqual([{ root, absent: ['.agents'] }])
  })

  it('removes a name that was absent and is now an empty folder', () => {
    const root = scratch()
    const records = recordAbsentNames([root])
    for (const name of ['.git', '.agents', '.codex']) mkdirSync(join(root, name))
    expect(removeSandboxLeftovers(records)).toEqual(['.git', '.agents', '.codex'].map(name => join(root, name)))
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('keeps a folder that existed before, even when it is empty', () => {
    const root = scratch()
    mkdirSync(join(root, '.git'))
    const records = recordAbsentNames([root])
    expect(removeSandboxLeftovers(records)).toEqual([])
    expect(existsSync(join(root, '.git'))).toBe(true)
  })

  it('keeps a new folder with anything in it, a new file and a new link, and removes nothing inside them', () => {
    const root = scratch()
    const target = scratch()
    const records = recordAbsentNames([root])
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, '.agents'), 'notes')
    symlinkSync(target, join(root, '.codex'))
    expect(removeSandboxLeftovers(records)).toEqual([])
    expect(['.git/HEAD', '.agents', '.codex'].map(name => existsSync(join(root, name)))).toEqual([true, true, true])
    expect(existsSync(target)).toBe(true)
  })

  it('never removes anything outside the three names', () => {
    const root = scratch()
    const records = recordAbsentNames([root])
    mkdirSync(join(root, 'empty'))
    removeSandboxLeftovers(records)
    expect(existsSync(join(root, 'empty'))).toBe(true)
  })
})
