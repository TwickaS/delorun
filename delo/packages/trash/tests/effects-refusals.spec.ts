/**
 * Proves the purge effects remove only what they name: a missing store root
 * removes nothing, a store root that cannot be inspected or listed stops the
 * purge with the file system error rather than reporting a clean purge, and a
 * projection-cache record key that is not path-safe names no document.
 */
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  removeAttachments, removeProjectionCache, removeSessionDirectory, removeSpill, removeStrayGenerations,
} from '../src/effects.ts'
import { encodeSegment } from '../src/paths.ts'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delo-trash-effects-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A path that exists as a plain file, to stand where a directory belongs. */
function plainFile(name: string): string {
  const path = join(base, name)
  writeFileSync(path, 'not a directory')
  return path
}

describe('a store root that does not exist', () => {
  it('has nothing to remove from', async () => {
    const missing = join(base, 'missing')

    expect(await removeSessionDirectory(missing, 'chat-a')).toBeUndefined()
    expect(await removeStrayGenerations(missing, 'p/chat-a')).toEqual([])
    expect(await removeProjectionCache(missing, ['chat-a'])).toEqual([])
    expect(await removeAttachments(missing, ['ab'.repeat(32)])).toEqual([])
    await expect(removeSpill([missing], ['chat-a'])).resolves.toBeUndefined()
  })
})

describe('a store root that cannot be inspected', () => {
  it('stops the purge with the file system error', async () => {
    const parentIsFile = join(plainFile('parent'), 'sessions')

    await expect(removeSessionDirectory(parentIsFile, 'chat-a')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('removeSessionDirectory', () => {
  it('rethrows a listing failure of the sessions root', async () => {
    await expect(removeSessionDirectory(plainFile('sessions'), 'chat-a')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('leaves files in the sessions root and a file where the chat directory belongs', async () => {
    const root = join(base, 'sessions')
    mkdirSync(join(root, 'project'), { recursive: true })
    writeFileSync(join(root, 'stray-file'), 'x')
    writeFileSync(join(root, 'project', encodeSegment('chat-a')), 'a file, not a session directory')

    expect(await removeSessionDirectory(root, 'chat-a')).toBeUndefined()
    expect(existsSync(join(root, 'project', encodeSegment('chat-a')))).toBe(true)
  })

  it('rethrows a failure to inspect a candidate directory', async () => {
    const root = join(base, 'sessions')
    mkdirSync(join(root, 'project'), { recursive: true })

    await expect(removeSessionDirectory(root, 'x'.repeat(300))).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
  })
})

describe('removeStrayGenerations', () => {
  it('rethrows a listing failure of the origin directory', async () => {
    const root = join(base, 'sessions')
    mkdirSync(join(root, 'project'), { recursive: true })
    writeFileSync(join(root, 'project', 'chat-a'), 'a file where the origin directory belongs')

    await expect(removeStrayGenerations(root, 'project/chat-a')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('removes only generation files of the origin', async () => {
    const root = join(base, 'sessions')
    const origin = join(root, 'project', 'chat-a')
    mkdirSync(origin, { recursive: true })
    writeFileSync(join(origin, 'session.jsonl'), 'x')
    writeFileSync(join(origin, 'notes.txt'), 'x')

    expect(await removeStrayGenerations(root, 'project/chat-a')).toEqual(['session.jsonl'])
    expect(existsSync(join(origin, 'notes.txt'))).toBe(true)
  })
})

describe('removeProjectionCache', () => {
  it('rethrows a listing failure of the document table', async () => {
    const storages = join(base, 'storages')
    mkdirSync(join(storages, 'session_projcache'), { recursive: true })
    writeFileSync(join(storages, 'session_projcache', 'sessions'), 'a file where the table belongs')

    await expect(removeProjectionCache(storages, ['chat-a'])).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('names no document for a record key that is not path-safe', async () => {
    const table = join(base, 'storages', 'session_projcache', 'sessions')
    mkdirSync(table, { recursive: true })
    writeFileSync(join(table, 'chat-a.json'), 'x')
    writeFileSync(join(table, '..json'), 'x')

    expect(await removeProjectionCache(join(base, 'storages'), ['..', 'a/b', 'chat-a'])).toEqual([join(table, 'chat-a.json')])
    expect(existsSync(join(table, '..json'))).toBe(true)
  })
})
