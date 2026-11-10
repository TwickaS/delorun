/**
 * Proves the trash store refuses what it cannot restore safely: a relative
 * root, a chat record without moved content, a restore that would overwrite a
 * session directory, an invalid or unreadable item record, and an item id that
 * could leave the items directory. It also proves the listing skips what has no
 * usable record and orders equal delete times by id.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TrashError, TrashStore, temporaryRoot } from '../src/store.ts'

let base: string
let store: TrashStore

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'delo-trash-store-'))
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

describe('the store root', () => {
  it('refuses a relative root', () => {
    expect(() => new TrashStore('relative/trash')).toThrowError(expect.objectContaining({ code: 'TRASH_RECORD_INVALID' }))
  })

  it('reports the resolved root it owns', () => {
    expect(new TrashStore(join(base, 'a', '..', 'trash')).trashRoot).toBe(join(base, 'trash'))
  })
})

describe('moveChatBack', () => {
  it.each([
    ['a chat without an origin', { id: 'a', movedAs: 'p/a' }, true],
    ['a chat without moved content', { id: 'a', origin: 'p/a' }, true],
    ['an item without a sessions root', { id: 'a', origin: 'p/a', movedAs: 'p/a' }, false],
  ])('refuses %s', async (_name, chat, withRoot) => {
    const item = await store.createItem('chat', 'x', { chats: [chat], sessionIds: ['a'], ...(withRoot ? { sessionsRoot: join(base, 'sessions') } : {}) }, 1)

    const error = await refusal(store.moveChatBack(item, chat))

    expect(error.code).toBe('TRASH_RECORD_INVALID')
  })

  it('refuses to overwrite an existing session directory and leaves the trash content in place', async () => {
    const sessionsRoot = join(base, 'sessions')
    mkdirSync(join(sessionsRoot, 'p', 'a'), { recursive: true })
    const source = join(base, 'origin-a')
    mkdirSync(source)
    writeFileSync(join(source, 'session.jsonl'), 'content\n')
    const chat = await store.moveChatIn('item-1', source, 'p/a', undefined, 'a')
    const item = await store.createItem('chat', 'x', { chats: [chat], sessionIds: ['a'], sessionsRoot }, 1)

    const error = await refusal(store.moveChatBack(item, chat))

    expect(error.code).toBe('TRASH_RESTORE_CONFLICT')
    expect(existsSync(join(store.chatContentPath('item-1', chat.movedAs!), 'session.jsonl'))).toBe(true)
  })

  it('rethrows a failure to inspect the origin that is not a missing directory', async () => {
    const sessionsRoot = join(base, 'sessions')
    mkdirSync(sessionsRoot)
    writeFileSync(join(sessionsRoot, 'p'), 'a file where the project directory belongs')
    const chat = { id: 'a', origin: 'p/a', movedAs: 'p/a' }
    const item = await store.createItem('chat', 'x', { chats: [chat], sessionIds: ['a'], sessionsRoot }, 1)

    await expect(store.moveChatBack(item, chat)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('readItem', () => {
  /** Write a raw record for an item id. */
  function plantRecord(id: string, raw: string): void {
    mkdirSync(store.itemPath(id), { recursive: true })
    writeFileSync(join(store.itemPath(id), 'item.json'), raw)
  }

  it('returns undefined for an item that does not exist', async () => {
    expect(await store.readItem('missing')).toBeUndefined()
  })

  it.each([
    ['a record of another schema version', JSON.stringify({ schemaVersion: 2, id: 'bad' })],
    ['a record without a string id', JSON.stringify({ schemaVersion: 1, id: 7 })],
  ])('refuses %s', async (_name, raw) => {
    plantRecord('bad', raw)

    const error = await refusal(store.readItem('bad'))

    expect(error.code).toBe('TRASH_RECORD_INVALID')
  })

  it('rethrows a read failure that is not a missing record', async () => {
    mkdirSync(join(store.itemPath('dir'), 'item.json'), { recursive: true })

    await expect(store.readItem('dir')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it.each(['../escape', 'a/b', 'a\\b', '.', '..'])('refuses the item id %j', async id => {
    const error = await refusal(store.readItem(id))

    expect(error.code).toBe('TRASH_RECORD_INVALID')
  })
})

describe('listItems', () => {
  it('lists nothing before the first delete', async () => {
    expect(await store.listItems()).toEqual([])
  })

  it('rethrows a listing failure that is not a missing items directory', async () => {
    mkdirSync(store.trashRoot, { recursive: true })
    writeFileSync(join(store.trashRoot, 'items'), 'a file where the items directory belongs')

    await expect(store.listItems()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('skips a directory without a record, an invalid record and an unreadable record', async () => {
    const kept = await store.createItem('chat', 'kept', { chats: [], sessionIds: [] }, 1)
    mkdirSync(store.itemPath('no-record'), { recursive: true })
    mkdirSync(store.itemPath('invalid'), { recursive: true })
    writeFileSync(join(store.itemPath('invalid'), 'item.json'), JSON.stringify({ schemaVersion: 9, id: 'invalid' }))
    mkdirSync(join(store.itemPath('unreadable'), 'item.json'), { recursive: true })

    expect((await store.listItems()).map(item => item.id)).toEqual([kept.id])
  })

  it('orders items deleted at the same instant by id', async () => {
    const first = await store.createItem('chat', 'a', { chats: [], sessionIds: [] }, 5)
    const second = await store.createItem('chat', 'b', { chats: [], sessionIds: [] }, 5)

    expect((await store.listItems()).map(item => item.id)).toEqual([first.id, second.id].sort((a, b) => a.localeCompare(b)))
  })
})

describe('temporaryRoot', () => {
  it('creates a private scratch directory', async () => {
    const root = await temporaryRoot()
    try {
      expect((await stat(root)).isDirectory()).toBe(true)
      expect(root.startsWith(join(tmpdir(), 'delo-trash-'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
