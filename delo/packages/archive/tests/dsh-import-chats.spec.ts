/**
 * What the stock-home import reads inside a chat and a workspace list before
 * it carries them, and how it proves at copy time that what lands is what it
 * planned: a chat's log is read for its header and for a turn left open, a
 * chat must work inside the folder of the workspace it is filed under, a
 * workspace or chat in a sensitive folder is held back, every copied file must
 * have the digest the plan read, and a recovery leaves a file a profile wrote
 * to since.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDshHomeImport, readImportedChats, recoverDshImport, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL, type DshHomeImportPlan, type DshImportApplyOptions } from '../src/dsh-import/index.ts'
import { compareCredentials } from '../src/dsh-import/credentials.ts'
import type { CredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { chatLog, FILE_OBJECT, IMAGE, makeHomes, manifest, mark, plan, PROJECT, read, registry, type Homes } from './dsh-import-support.ts'

/** Every category taken. */
const ALL: DshImportApplyOptions = { include: { profiles: true, settings: true, instructions: true, skills: true, credentials: true } }

let homes: Homes
const locked: string[] = []

beforeEach(() => {
  homes = makeHomes()
})

afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o755)
  homes.remove()
})

/**
 * The reason and detail the plan gives one path it leaves behind.
 * @param planned - the plan.
 * @param path - the path.
 * @returns the reason and detail, or `undefined` when the plan carries it.
 */
function skipOf(planned: DshHomeImportPlan, path: string): readonly [string, string | undefined] | undefined {
  const entry = planned.skipped.find(skip => skip.path === path)
  return entry === undefined ? undefined : [entry.reason, entry.detail]
}

describe('a chat\'s log', () => {
  it('carries a chat whose turns are closed, and leaves one that stopped inside a turn behind', async () => {
    homes.write('sessions/_no-cwd/closed/session.v4.jsonl.zstd', chatLog('closed', undefined, [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'turn/start' }, { type: 'turn/end' }]))
    homes.write('sessions/_no-cwd/open/session.v4.jsonl.zstd', chatLog('open', undefined, [{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'turn/start' }, { type: 'assistant/message' }]))
    // Only the newest generation decides: an older one that ended inside a turn was closed by the newer.
    homes.write('sessions/_no-cwd/older/session.v3.jsonl.zstd', chatLog('older', undefined, [{ type: 'turn/start' }]))
    homes.write('sessions/_no-cwd/older/session.v4.jsonl.zstd', chatLog('older', undefined, [{ type: 'turn/start' }, { type: 'turn/end' }]))
    const planned = await plan(homes)
    expect(planned.chats.map(chat => [chat.path, chat.id, chat.cwd])).toEqual([['sessions/_no-cwd/closed', 'closed', undefined], ['sessions/_no-cwd/older', 'older', undefined]])
    expect(skipOf(planned, 'sessions/_no-cwd/open')).toEqual(['unfinished-turn', undefined])
  })

  it('reads a chat whose folder name escapes characters of its Session identifier', async () => {
    homes.write('sessions/_no-cwd/my~0020chat/session.v4.jsonl.zstd', chatLog('my chat', undefined))
    expect((await plan(homes)).chats.map(chat => chat.id)).toEqual(['my chat'])
  })

  it('leaves a chat behind whose log cannot be read, naming why and never quoting it', async () => {
    const logs: Record<string, Buffer> = {
      'not-zstd': Buffer.from('plain text, not a compressed log'),
      empty: Buffer.alloc(0),
      'no-header': zstdCompressSync(Buffer.from('')),
      'not-json': zstdCompressSync(Buffer.from('{"type":"session","id":"not-json"}\nsecret-text-of-a-record\n')),
      'not-session': zstdCompressSync(Buffer.from('{"type":"turn/start"}\n')),
      'array-header': zstdCompressSync(Buffer.from('[1]\n')),
      'relative-cwd': zstdCompressSync(Buffer.from('{"type":"session","id":"relative-cwd","cwd":"work"}\n')),
      'numeric-cwd': zstdCompressSync(Buffer.from('{"type":"session","id":"numeric-cwd","cwd":7}\n')),
      'other-id': chatLog('someone-else', undefined),
      bomb: zstdCompressSync(Buffer.from(`{"type":"session","id":"bomb"}\n${'a'.repeat(4 * 1024 * 1024)}\n`)),
    }
    for (const [name, bytes] of Object.entries(logs)) homes.write(`sessions/_no-cwd/${name}/session.v4.jsonl.zstd`, bytes)
    const planned = await plan(homes)
    expect(planned.chats).toEqual([])
    const reasons = Object.fromEntries(Object.keys(logs).map(name => [name, skipOf(planned, `sessions/_no-cwd/${name}`)]))
    expect(reasons['not-zstd']?.[1]).toMatch(/^its log cannot be read: it does not decompress \(/u)
    expect(reasons['empty']?.[1]).toMatch(/^its log cannot be read: it does not decompress \(/u)
    expect(reasons).toMatchObject({
      'no-header': ['unreadable', 'its log cannot be read: it holds no header'],
      'not-json': ['unreadable', 'its log cannot be read: one of its records is not JSON'],
      'not-session': ['unreadable', 'its log cannot be read: its header is not a Session header'],
      'array-header': ['unreadable', 'its log cannot be read: its header is not a Session header'],
      'relative-cwd': ['unreadable', 'its log cannot be read: its header is not a Session header'],
      'numeric-cwd': ['unreadable', 'its log cannot be read: its header is not a Session header'],
      'other-id': ['unreadable', 'its header names another chat than its folder'],
      bomb: ['unreadable', 'its log cannot be read: it decompresses to more than a hundred times its size'],
    })
    expect(JSON.stringify(planned)).not.toContain('secret-text-of-a-record')
  })

  it('reads a long log as a stream, its last record without a newline, and refuses a record too long to read', async () => {
    const long = randomBytes(3 * 1024 * 1024).toString('base64')
    homes.write('sessions/_no-cwd/long/session.v4.jsonl.zstd', zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: 'long' })}\n${JSON.stringify({ type: 'note', text: long })}\n\n{"type":"turn/start"}\n\n{"type":"turn/end"}`)))
    homes.write('sessions/_no-cwd/huge-record/session.v4.jsonl.zstd', zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: 'huge-record' })}\n${randomBytes(13 * 1024 * 1024).toString('base64')}`)))
    homes.write('sessions/_no-cwd/early/session.v4.jsonl.zstd', zstdCompressSync(Buffer.from(`{"type":"turn/start"}\n${long}\n`)))
    const planned = await plan(homes, { limits: { maxEntries: 100, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 } })
    expect(planned.chats.map(chat => chat.id)).toEqual(['long'])
    expect(skipOf(planned, 'sessions/_no-cwd/huge-record')).toEqual(['unreadable', 'its log cannot be read: one of its records is too long'])
    expect(skipOf(planned, 'sessions/_no-cwd/early')).toEqual(['unreadable', 'its log cannot be read: its header is not a Session header'])
  }, 60_000)
})

describe('a chat\'s working folder', () => {
  it('carries a chat filed under a workspace only when it works inside that workspace\'s folder', async () => {
    homes.write('sessions/--work-proj--/inside/session.v4.jsonl.zstd', chatLog('inside', '/work/proj/sub'))
    homes.write('sessions/--work-proj--/outside/session.v4.jsonl.zstd', chatLog('outside', '/home/someone/.ssh'))
    homes.write('sessions/_no-cwd/nowhere/session.v4.jsonl.zstd', chatLog('nowhere', undefined))
    homes.write('sessions/--work-free--/free/session.v4.jsonl.zstd', chatLog('free', '/work/free'))
    homes.write('storages/workspace.json', registry({ w1: { path: '/work/proj', sessionIds: ['inside', 'outside', 'nowhere'] } }))
    const planned = await plan(homes)
    expect(planned.chats.map(chat => chat.id)).toEqual(['free', 'inside'])
    expect(skipOf(planned, 'sessions/--work-proj--/outside')).toEqual(['outside-workspace', 'it works in "/home/someone/.ssh", outside its workspace "w1" at "/work/proj"'])
    expect(skipOf(planned, 'sessions/_no-cwd/nowhere')).toEqual(['outside-workspace', 'it works in no folder, outside its workspace "w1" at "/work/proj"'])
    await applyDshHomeImport(planned, { include: {} })
    // The list lands with only the chats the import carried.
    expect((JSON.parse(read(homes.target, 'storages/workspace.json')) as { tables: { workspaces: { w1: { sessionIds: string[] } } } }).tables.workspaces.w1.sessionIds).toEqual(['inside'])
  })

  it('holds back a workspace in a sensitive folder with its chats, and a chat filed under none that works in one', async () => {
    const person = join(homes.root, 'person')
    const workspaces = {
      root: '/',
      home: person,
      ssh: join(person, '.ssh'),
      config: join(person, '.config', 'tool'),
      stock: join(homes.source, 'profiles'),
      delo: join(homes.target, 'skills'),
      fine: join(person, 'code'),
      dotted: join(person, 'code', '.github'),
    }
    const ids = Object.keys(workspaces)
    homes.write('storages/workspace.json', registry(Object.fromEntries(ids.map(id => [id, { path: workspaces[id as keyof typeof workspaces], sessionIds: [`chat-${id}`] }]))))
    for (const id of ids) homes.write(`sessions/--p-${id}--/chat-${id}/session.v4.jsonl.zstd`, chatLog(`chat-${id}`, workspaces[id as keyof typeof workspaces]))
    homes.write('sessions/--loose--/loose/session.v4.jsonl.zstd', chatLog('loose', join(person, '.gnupg')))
    const planned = await plan(homes, { personHome: person })
    expect(planned.registry?.listed.map(workspace => [workspace.id, workspace.held, workspace.chats])).toEqual([
      ['root', 'the root of the file system', 0],
      ['home', 'your home folder itself', 0],
      ['ssh', 'a hidden folder of your home folder, where settings and keys live', 0],
      ['config', 'a hidden folder of your home folder, where settings and keys live', 0],
      ['stock', 'inside the DeepSeek Harness home', 0],
      ['delo', 'inside the Delorun home', 0],
      ['fine', undefined, 1],
      ['dotted', undefined, 1],
    ])
    expect(planned.chats.map(chat => chat.id).sort()).toEqual(['chat-dotted', 'chat-fine'])
    expect(skipOf(planned, 'sessions/--p-ssh--/chat-ssh')).toEqual(['sensitive-folder', `its workspace "ssh" at ${JSON.stringify(workspaces.ssh)} is a hidden folder of your home folder, where settings and keys live`])
    expect(skipOf(planned, 'sessions/--loose--/loose')).toEqual(['sensitive-folder', `its folder ${JSON.stringify(join(person, '.gnupg'))} is a hidden folder of your home folder, where settings and keys live`])
    await applyDshHomeImport(planned, { include: {} })
    const landed = JSON.parse(read(homes.target, 'storages/workspace.json')) as { global: { workspaceIds: string[] }, tables: { workspaces: Record<string, unknown> } }
    expect(landed.global.workspaceIds).toEqual(['fine', 'dotted'])
    expect(Object.keys(landed.tables.workspaces)).toEqual(['fine', 'dotted'])
  })

  it('without the person\'s home, still holds back the root and both Harness homes, and a folder that is not absolute', async () => {
    homes.write('storages/workspace.json', registry({ root: { path: '/', sessionIds: [] }, fine: { path: '/work/fine', sessionIds: [] } }))
    expect((await plan(homes)).registry?.listed.map(workspace => workspace.held)).toEqual(['the root of the file system', undefined])
    const { sensitiveFolder } = await import('../src/dsh-import/workspaces.ts')
    expect(sensitiveFolder('relative/folder', { personHome: undefined, stockHome: homes.source, deloHome: homes.target })).toBe('not an absolute folder')
  })

  it('holds back a workspace or a chat whose folder is a link into a sensitive place, judged by where the link leads', async () => {
    const person = join(homes.root, 'person')
    mkdirSync(join(person, '.secret'), { recursive: true })
    mkdirSync(join(person, 'code'), { recursive: true })
    symlinkSync(join(person, '.secret'), join(person, 'code', 'innocent'))
    symlinkSync(homes.target, join(person, 'code', 'delo-link'))
    symlinkSync(join(person, 'missing'), join(person, 'code', 'dangling'))
    homes.write('storages/workspace.json', registry({ linked: { path: join(person, 'code', 'innocent'), sessionIds: [] }, delo: { path: join(person, 'code', 'delo-link'), sessionIds: [] }, dangling: { path: join(person, 'code', 'dangling'), sessionIds: [] } }))
    homes.write('sessions/--loose--/loose/session.v4.jsonl.zstd', chatLog('loose', join(person, 'code', 'innocent', 'keys')))
    const planned = await plan(homes, { personHome: person })
    expect(planned.registry?.listed.map(workspace => [workspace.id, workspace.held])).toEqual([
      ['linked', 'a hidden folder of your home folder, where settings and keys live'],
      ['delo', 'inside the Delorun home'],
      ['dangling', undefined],
    ])
    expect(planned.chats).toEqual([])
    expect(planned.skipped).toContainEqual({ path: 'sessions/--loose--/loose', reason: 'sensitive-folder', detail: `its folder ${JSON.stringify(join(person, 'code', 'innocent', 'keys'))} is a hidden folder of your home folder, where settings and keys live` })
  })

  it('compares a folder with homes that do not exist by their written paths', async () => {
    const { sensitiveFolder } = await import('../src/dsh-import/workspaces.ts')
    const gone = join(homes.root, 'gone')
    expect(sensitiveFolder(join(gone, 'stock', 'x'), { personHome: join(gone, 'person'), stockHome: join(gone, 'stock'), deloHome: join(gone, 'delo') })).toBe('inside the DeepSeek Harness home')
    expect(sensitiveFolder(join(homes.root, 'elsewhere'), { personHome: join(gone, 'person'), stockHome: join(gone, 'stock'), deloHome: join(gone, 'delo') })).toBeUndefined()
  })

  it('refuses a stock list interrupted while it changed', async () => {
    homes.write('storages/workspace.json', registry({ w1: { path: '/work/one', sessionIds: [] } }, { pendingMutation: { operation: 'create', workspaceId: 'w1' } }))
    expect((await plan(homes)).blockers.map(blocker => [blocker.code, blocker.message])).toEqual([['DSH_IMPORT_REGISTRY_REFUSED', 'the stock workspace list was interrupted while it changed; start DeepSeek Harness once so it finishes the change, stop it, and import again']])
  })
})

describe('what lands is what was planned', () => {
  it('refuses a stock file rewritten to the same size with its modification time set back', async () => {
    mark(homes)
    homes.write('AGENTS.md', '# notes one\n')
    const planned = await plan(homes)
    const path = join(homes.source, 'AGENTS.md')
    const { atime, mtime } = statSync(path)
    writeFileSync(path, '# notes two\n')
    utimesSync(path, atime, mtime)
    await expect(applyDshHomeImport(planned, ALL)).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_CHANGED', message: expect.stringContaining('it was written to after the import read the stock home') as string })
    expect(existsSync(join(homes.target, 'AGENTS.md'))).toBe(false)
  })

  it('refuses at copy time a chat, an attachment, a skill or a workspace list whose bytes are not the ones the plan read', async () => {
    homes.write(`sessions/${PROJECT}/s1/session.v4.jsonl.zstd`, 'chat')
    homes.write(IMAGE, 'image-bytes')
    homes.write(FILE_OBJECT, 'file-bytes')
    homes.write('skills/review/SKILL.md', '# review\n')
    homes.write('storages/workspace.json', registry({ w1: { path: '/work/proj', sessionIds: ['s1'] } }))
    const planned = await plan(homes)
    const other = '0'.repeat(64)
    const [chat] = planned.chats
    const [skill] = planned.skills
    const registered = planned.registry as NonNullable<DshHomeImportPlan['registry']>
    const tampered: readonly DshHomeImportPlan[] = [
      { ...planned, chats: [{ ...chat as DshHomeImportPlan['chats'][number], files: (chat as DshHomeImportPlan['chats'][number]).files.map(file => ({ ...file, sha256: other })) }] },
      { ...planned, attachments: planned.attachments.map(file => ({ ...file, sha256: other })) },
      { ...planned, skills: [{ ...skill as DshHomeImportPlan['skills'][number], files: (skill as DshHomeImportPlan['skills'][number]).files.map(file => ({ ...file, sha256: other })) }] },
      { ...planned, registry: { ...registered, source: { ...registered.source, sha256: other } } },
    ]
    for (const plan of tampered) {
      await expect(applyDshHomeImport(plan, ALL)).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_CHANGED', message: expect.stringContaining('no longer holds the bytes the preview showed') as string })
    }
    expect(existsSync(join(homes.target, 'sessions'))).toBe(false)
    expect(existsSync(join(homes.target, 'storages'))).toBe(false)
  }, 30_000)
})

describe('the way back', () => {
  it('leaves in place, and reports, a published file a profile wrote to after a crash', async () => {
    homes.write('sessions/_no-cwd/s1/session.v4.jsonl.zstd', 'chat one')
    homes.write('sessions/_no-cwd/s2/session.v4.jsonl.zstd', 'chat two')
    let stopped: () => void = () => undefined
    const crashed = new Promise<void>((resolve) => { stopped = resolve })
    let placed = 0
    void applyDshHomeImport(await plan(homes), { include: {}, onPublished: () => {
      placed += 1
      if (placed < 2) return
      stopped()
      return new Promise<void>(() => undefined)
    } })
    await crashed
    // A profile started over the half-placed import and appended to one chat.
    writeFileSync(join(homes.target, 'sessions/_no-cwd/s2/session.v4.jsonl.zstd'), 'appended by a profile', { flag: 'a' })
    const recovered = await recoverDshImport(homes.target)
    expect(recovered).toEqual({ withdrawn: ['sessions/_no-cwd/s1/session.v4.jsonl.zstd'], kept: ['sessions/_no-cwd/s2/session.v4.jsonl.zstd'], removed: 0 })
    expect(read(homes.target, 'sessions/_no-cwd/s2/session.v4.jsonl.zstd')).toContain('appended by a profile')
    expect(existsSync(join(homes.target, 'sessions/_no-cwd/s1'))).toBe(false)
    expect(existsSync(join(homes.target, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))).toBe(false)
  })

  it('keeps the first failure when withdrawing what it placed fails too, and keeps the journal', async () => {
    homes.write('sessions/_no-cwd/s1/session.v4.jsonl.zstd', 'chat one')
    const parent = join(homes.target, STOCK_IMPORT_DIRECTORY)
    const refusal = await applyDshHomeImport(await plan(homes), { include: {}, onPublished: () => {
      chmodSync(parent, 0o000)
      locked.push(parent)
      throw Object.assign(new Error('the disk went away'), { code: 'EIO' })
    } }).then(() => new Error('the import was expected to refuse'), (error: unknown) => error as Error)
    expect(refusal).toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED' })
    expect(refusal.message).toContain('the import could not write its files (EIO)')
    expect(refusal.message).toContain('withdrawing what it had placed failed too')
    chmodSync(parent, 0o755)
    expect(existsSync(join(parent, STOCK_IMPORT_JOURNAL))).toBe(true)
  })
})

describe('the imported-chat mark', () => {
  it('reads back every chat each completed import copied, and nothing from a record that names none', async () => {
    expect(await readImportedChats(homes.target)).toEqual(new Set())
    homes.write('sessions/_no-cwd/s1/session.v4.jsonl.zstd', 'chat one')
    homes.write('sessions/_no-cwd/open/session.v4.jsonl.zstd', chatLog('open', undefined, [{ type: 'turn/start' }]))
    await applyDshHomeImport(await plan(homes), { include: {} })
    expect(await readImportedChats(homes.target)).toEqual(new Set(['s1']))
    // A record from an earlier build lists no chats, and an entry that is not a Session identifier is not one.
    const record = JSON.parse(read(homes.target, `${STOCK_IMPORT_DIRECTORY}/imports.json`)) as { imports: unknown[] }
    record.imports.push({ at: '2026-01-01T00:00:00.000Z' }, { sessions: ['s9', 7] })
    writeFileSync(join(homes.target, STOCK_IMPORT_DIRECTORY, 'imports.json'), JSON.stringify(record))
    expect(await readImportedChats(homes.target)).toEqual(new Set(['s1', 's9']))
  })
})

describe('the stored keys', () => {
  it('offers no api-key record whose name has no scope, or whose scope only starts like DeepSeek\'s', () => {
    const record = (key: string): CredentialsDocument['records'] extends Map<string, infer R> ? R : never => ({ kind: 'api-key', key })
    const stock: CredentialsDocument = { refs: new Map(), records: new Map([['llm-deepseekX', record('one')], ['llm-deepseek', record('two')], ['llm-deepseeker/main', record('three')], ['llm-deepseek/main', record('four')]]), ignoredKeys: [] }
    expect(compareCredentials(stock, undefined)).toEqual([
      { name: 'llm-deepseekX', state: 'not-carried' },
      { name: 'llm-deepseek', state: 'not-carried' },
      { name: 'llm-deepseeker/main', state: 'not-carried' },
      { name: 'llm-deepseek/main', state: 'offered' },
    ])
  })
})

describe('a profile', () => {
  it('lands its pnpm settings and patch template with the digest the journal records', async () => {
    homes.write('profiles/web/package.json', manifest(['@deepseek-ai/dsh-base']))
    await applyDshHomeImport(await plan(homes), ALL)
    expect(read(homes.target, 'profiles/web/cordis.patch.yml')).toContain('[]')
    expect(read(homes.target, 'profiles/web/pnpm-workspace.yaml')).toContain('nodeLinker: hoisted')
  })
})
