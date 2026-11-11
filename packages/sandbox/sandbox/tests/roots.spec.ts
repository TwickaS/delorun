/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift, and so the workspace-plus-
 * additional set stays one shared derivation across backend dialects.
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxProtectedRootError, assertRootsOutsideHome, canonicalPath, pathWithin, protectedReadGuard, toolReadableOnly, workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    roots.push(dir)
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('workspaceWritableRoots', () => {
  it('workspace-write grants only the workspace when no extra root is configured', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws })).toEqual([realpathSync.native(ws)])
  })

  it('workspace-write deduplicates physical extra directories and rejects symlink aliases', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    const alias = join(ws, 'alias')
    symlinkSync(extra, alias, 'dir')
    roots.push(ws, extra)
    const grants = workspaceWritableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [extra, extra],
    })
    expect(grants).toEqual([realpathSync.native(ws), realpathSync.native(extra)])
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [alias] }))
      .toThrow('use the physical directory path')
  })

  it('rejects missing and non-directory extra roots before granting access', () => {
    const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-roots-')))
    roots.push(ws)
    const file = join(ws, 'file.txt')
    writeFileSync(file, 'file')
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [file] }))
      .toThrow('expected an existing directory')
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [join(ws, 'missing')] }))
      .toThrow('cannot read the directory')
  })

  it('read-only grants nothing even when extra roots are carried on the policy', () => {
    expect(workspaceWritableRoots({ mode: 'read-only', workspaceRoot: '/ws', additionalWritableRoots: ['/extra'] })).toEqual([])
    expect(writableRoots({ mode: 'read-only', workspaceRoot: '/ws', additionalWritableRoots: ['/extra'] })).toEqual([])
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writable).toContain(realpathSync.native(ws))
    expect(writable).toContain(canonicalPath('/tmp'))
    expect(writable).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(writable).size).toBe(writable.length)
  })

  it('workspace-write includes an explicit extra directory beside the temp areas', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    roots.push(ws, extra)
    expect(writableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [extra],
    })).toContain(realpathSync.native(extra))
  })
})

describe('pathWithin', () => {
  it('compares by path segment', () => {
    expect(pathWithin('/a/b', '/a/b')).toBe(true)
    expect(pathWithin('/a/b/c', '/a/b')).toBe(true)
    expect(pathWithin('/a/bc', '/a/b')).toBe(false)
    expect(pathWithin('/a', '/a/b')).toBe(false)
    expect(pathWithin('/a/..b', '/a')).toBe(true)
    expect(pathWithin('/x', '/a')).toBe(false)
  })
})

describe('assertRootsOutsideHome', () => {
  it('refuses a root that equals, lies inside or contains the home with HOME_IN_WRITABLE_ROOT', () => {
    for (const root of ['/u/.delo', '/u/.delo/skills', '/u', '/']) {
      expect(() => { assertRootsOutsideHome(['/w', root], '/u/.delo') }).toThrow(SandboxProtectedRootError)
    }
    try {
      assertRootsOutsideHome(['/u'], '/u/.delo')
    } catch (error) {
      expect(error).toMatchObject({ code: 'HOME_IN_WRITABLE_ROOT', name: 'SandboxProtectedRootError' })
      expect(String(error)).toContain('/u/.delo')
    }
  })

  it('accepts roots beside the home', () => {
    expect(() => { assertRootsOutsideHome(['/u/project', '/u/.delo-other', '/tmp'], '/u/.delo') }).not.toThrow()
  })
})

describe('protectedReadGuard', () => {
  const reads = { roots: ['/u/.delo', '/mnt/distro/u/.delo'], readable: ['/u/.delo/runtimes', '/mnt/distro/u/.delo/runtimes'] }

  it('refuses paths under every root except the readable entries', () => {
    const refused = protectedReadGuard(reads, 'workspace-write')
    expect(refused('/u/.delo')).toBe(true)
    expect(refused('/u/.delo/secrets/key')).toBe(true)
    expect(refused('/mnt/distro/u/.delo/run/start-token')).toBe(true)
    expect(refused('/u/.delo/runtimes/0.1.0/node')).toBe(false)
    expect(refused('/u/.delo-other/key')).toBe(false)
    expect(refused('/u/project/a.ts')).toBe(false)
    expect(protectedReadGuard(reads, 'read-only')('/u/.delo/secrets/key')).toBe(true)
  })

  it('lets read tools read a tool-readable entry, and refuses the rest of the home beside it', () => {
    const withSpill = { ...reads, toolReadable: ['/u/.delo/spill', '/mnt/distro/u/.delo/spill'] }
    const refused = protectedReadGuard(withSpill, 'workspace-write')
    expect(refused('/u/.delo/spill/session-1/grep.txt')).toBe(false)
    expect(refused('/mnt/distro/u/.delo/spill/session-1/grep.txt')).toBe(false)
    expect(refused('/u/.delo/spill-other/key')).toBe(true)
    expect(refused('/u/.delo/secrets/key')).toBe(true)
    expect(toolReadableOnly(withSpill, '/u/.delo/spill/session-1')).toBe(true)
    expect(toolReadableOnly(withSpill, '/u/.delo/runtimes')).toBe(false)
    expect(toolReadableOnly(reads, '/u/.delo/spill')).toBe(false)
  })

  it('refuses nothing under danger-full-access or without protected reads', () => {
    expect(protectedReadGuard(reads, 'danger-full-access')('/u/.delo/secrets/key')).toBe(false)
    expect(protectedReadGuard(undefined, 'read-only')('/u/.delo/secrets/key')).toBe(false)
  })
})
