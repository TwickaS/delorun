/**
 * Proves the trash store refuses what it cannot handle safely: a relative
 * root, an item id that could leave the items directory, a record whose paths
 * are not two encoded segments, an invalid or unreadable record, and a move
 * onto something that already exists. A record it cannot read is reported as
 * damaged with its directory, never skipped, and a record is written whole.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSafeOrigin, moveDirectory, TrashError, TrashStore, temporaryRoot } from '../src/store.ts'

let base: string
let store: TrashStore

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delorun-trash-store-'))
  store = new TrashStore(join(base, 'trash'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** Run a promise and return the TrashError it rejects with. */
async function refusal(promise: Promise<unknown>): Promise<TrashError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(TrashError)
  return error as TrashError
}

/** Write a raw record for an item id. */
function plantRecord(id: string, raw: string): void {
  mkdirSync(join(store.trashRoot, 'items', id), { recursive: true })
  writeFileSync(join(store.trashRoot, 'items', id, 'item.json'), raw)
}

/** A valid record body for an item id, with fields replaced. */
function record(id: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, id, kind: 'chat', label: 'x', chats: [], sessionIds: [], workspaceIds: [], attachments: [], deletedAt: 1, expiresAt: 2, ...fields })
}

describe('the store root', () => {
  it('refuses a relative root', () => {
    expect(() => new TrashStore('relative/trash')).toThrowError(expect.objectContaining({ code: 'TRASH_RECORD_INVALID' }))
  })

  it('resolves an absolute root', () => {
    expect(new TrashStore(join(base, 'a', '..', 'trash')).trashRoot).toBe(join(base, 'trash'))
  })
})

describe('the paths a record names', () => {
  it.each(['p/a', '--work--/chat-a', '_no-cwd/chat~0020a'])('admits the two-segment name %j', path => {
    expect(isSafeOrigin(path)).toBe(true)
  })

  it.each(['a', 'p/a/b', '../a', 'p/..', './a', '/abs/a', 'p\\a', 'p/a b', '', 'p/'])('refuses %j', path => {
    expect(isSafeOrigin(path)).toBe(false)
  })

  it('refuses a content name that is not two encoded segments', () => {
    expect(() => store.chatContentPath('1-a', '../../escape')).toThrowError(expect.objectContaining({ code: 'TRASH_RECORD_INVALID' }))
  })

  it.each(['../escape', 'a/b', 'a\\b', '.', '..', 'bad'])('refuses to address the item id %j', id => {
    expect(() => store.itemPath(id)).toThrowError(expect.objectContaining({ code: 'TRASH_RECORD_INVALID' }))
  })
})

describe('readItem', () => {
  it('returns undefined for an item that does not exist, and for a string that is no item id', async () => {
    expect(await store.readItem('1-a')).toBeUndefined()
    expect(await store.readItem('../escape')).toBeUndefined()
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['a value that is not an object', '[]'],
    ['a record of another schema version', record('1-a', { schemaVersion: 2 })],
    ['a record naming another id', record('1-a', { id: '1-b' })],
    ['a record of an unknown kind', record('1-a', { kind: 'folder' })],
    ['a record without a label', record('1-a', { label: 7 })],
    ['a record without times', record('1-a', { deletedAt: 'now' })],
    ['a record whose session ids are not strings', record('1-a', { sessionIds: [7] })],
    ['a record whose attachments are not digests', record('1-a', { attachments: ['not-a-digest'] })],
    ['a record whose archived list is not a list', record('1-a', { archived: 'chat-a' })],
    ['a record whose registration has no path', record('1-a', { registration: { title: 'x' } })],
    ['a record whose registration is not an object', record('1-a', { registration: 7 })],
    ['a record without chats', record('1-a', { chats: 'none' })],
    ['a record whose chat has no id', record('1-a', { chats: [{}] })],
    ['a record whose chat is not an object', record('1-a', { chats: [null] })],
    ['a record whose chat origin climbs out of the sessions root', record('1-a', { chats: [{ id: 'a', origin: '../../../home/elsewhere' }] })],
    ['a record whose chat origin is absolute', record('1-a', { chats: [{ id: 'a', origin: '/etc/passwd' }] })],
    ['a record whose moved content names another directory', record('1-a', { chats: [{ id: 'a', movedAs: '../other-item/chats/p' }] })],
    ['a record whose moved content is not a string', record('1-a', { chats: [{ id: 'a', movedAs: 7 }] })],
    ['a record whose pending mark is not true', record('1-a', { chats: [{ id: 'a', pending: false }] })],
  ])('refuses %s', async (_name, raw) => {
    plantRecord('1-a', raw)

    expect((await refusal(store.readItem('1-a'))).code).toBe('TRASH_RECORD_INVALID')
  })

  it('rethrows a read failure that is not a missing record', async () => {
    mkdirSync(join(store.trashRoot, 'items', '1-a', 'item.json'), { recursive: true })

    await expect(store.readItem('1-a')).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('writeItem', () => {
  it('replaces a record whole and leaves no temporary file', async () => {
    const item = await store.createItem('chat', 'first', { chats: [], sessionIds: [] }, 1)

    await store.writeItem({ ...item, label: 'second' })

    expect((await store.readItem(item.id))!.label).toBe('second')
    expect(readdirSync(store.itemPath(item.id))).toEqual(['item.json'])
  })

  it('refuses to write a record whose paths are unsafe', async () => {
    const item = await store.createItem('chat', 'first', { chats: [], sessionIds: [] }, 1)

    expect((await refusal(store.writeItem({ ...item, chats: [{ id: 'a', origin: '../escape' }] }))).code).toBe('TRASH_RECORD_INVALID')
  })

  it('removes its temporary file when the rename fails', async () => {
    const item = await store.createItem('chat', 'first', { chats: [], sessionIds: [] }, 1)
    rmSync(join(store.itemPath(item.id), 'item.json'))
    mkdirSync(join(store.itemPath(item.id), 'item.json', 'blocker'), { recursive: true })

    await expect(store.writeItem(item)).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|ENOTEMPTY|EEXIST/) })
    expect(readdirSync(store.itemPath(item.id))).toEqual(['item.json'])
  })
})

describe('scan', () => {
  it('lists nothing before the first delete', async () => {
    expect(await store.scan()).toEqual({ items: [], damaged: [] })
  })

  it('rethrows a listing failure that is not a missing items directory', async () => {
    mkdirSync(store.trashRoot, { recursive: true })
    writeFileSync(join(store.trashRoot, 'items'), 'a file where the items directory belongs')

    await expect(store.listItems()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('reports a directory without a record, an invalid record, an unreadable record and a foreign name as damaged, with its directory', async () => {
    const kept = await store.createItem('chat', 'kept', { chats: [], sessionIds: [] }, 1)
    mkdirSync(join(store.trashRoot, 'items', '2-a'), { recursive: true })
    plantRecord('3-a', '{"schemaVersion":1')
    mkdirSync(join(store.trashRoot, 'items', '4-a', 'item.json'), { recursive: true })
    mkdirSync(join(store.trashRoot, 'items', 'foreign'), { recursive: true })

    const { items, damaged } = await store.scan()

    expect(items.map(item => item.id)).toEqual([kept.id])
    expect(damaged.map(entry => [entry.id, entry.directory])).toEqual([
      ['2-a', join(store.trashRoot, 'items', '2-a')],
      ['3-a', join(store.trashRoot, 'items', '3-a')],
      ['4-a', join(store.trashRoot, 'items', '4-a')],
      ['foreign', join(store.trashRoot, 'items', 'foreign')],
    ])
    expect(damaged.map(entry => entry.reason)).toEqual([
      'the directory holds no item.json',
      'the trash record of "3-a" is not JSON',
      expect.stringContaining('EISDIR'),
      'the directory\'s name is not a trash item id',
    ])
  })

  it('orders items deleted at the same instant by id', async () => {
    const first = await store.createItem('chat', 'a', { chats: [], sessionIds: [] }, 5)
    const second = await store.createItem('chat', 'b', { chats: [], sessionIds: [] }, 5)

    expect((await store.listItems()).map(item => item.id)).toEqual([first.id, second.id].sort((a, b) => a.localeCompare(b)))
  })

  it('reports a failure that is not an error by its text', async () => {
    plantRecord('5-a', record('5-a'))
    const failing = new TrashStore(store.trashRoot)
    failing.readItem = () => Promise.reject('a plain failure')

    expect((await failing.scan()).damaged.map(entry => entry.reason)).toEqual(['a plain failure'])
  })
})

describe('the content an item holds', () => {
  it('has none before a move, and some after one', async () => {
    const item = await store.createItem('chat', 'x', { chats: [], sessionIds: [] }, 1)
    expect(await store.holdsContent(item.id)).toBe(false)
    const source = join(base, 'origin')
    mkdirSync(source)
    writeFileSync(join(source, 'session.jsonl'), '{}\n')

    await store.moveChatIn(item.id, source, 'p/a')

    expect(await store.holdsChat(item.id, 'p/a')).toBe(true)
    expect(await store.holdsContent(item.id)).toBe(true)
  })

  it('rethrows a listing failure that is not a missing chats directory', async () => {
    const item = await store.createItem('chat', 'x', { chats: [], sessionIds: [] }, 1)
    writeFileSync(join(store.itemPath(item.id), 'chats'), 'a file where the chats directory belongs')

    await expect(store.holdsContent(item.id)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('moveDirectory', () => {
  it('refuses a target that exists, even an empty directory a rename would replace', async () => {
    const from = join(base, 'from')
    const to = join(base, 'to')
    mkdirSync(from)
    writeFileSync(join(from, 'session.jsonl'), 'content\n')
    mkdirSync(to)

    await expect(moveDirectory(from, to)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(existsSync(join(from, 'session.jsonl'))).toBe(true)
  })

  it('rethrows a failure to inspect the target that is not a missing path', async () => {
    writeFileSync(join(base, 'file'), '')

    await expect(moveDirectory(join(base, 'from'), join(base, 'file', 'to'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('temporaryRoot', () => {
  it('creates a private scratch directory', async () => {
    const root = await temporaryRoot()
    try {
      expect((await stat(root)).isDirectory()).toBe(true)
      expect(root.startsWith(join(tmpdir(), 'delorun-trash-'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
