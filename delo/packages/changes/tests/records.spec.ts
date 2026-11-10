import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isChangesError, type ChangesCode } from '../src/errors.ts'
import { changesDirectory, profileChangesDirectory, protectionPath } from '../src/paths.ts'
import {
  approvedOf,
  attestStudio,
  attestTerminal,
  closeWorkSession,
  findEntry,
  noteLoaded,
  openWorkSession,
  readActiveRecord,
  readApproved,
  readChangeLog,
  readProtection,
  readWorkSession,
  setProtection,
  withEntry,
  writeActiveRecord,
  writeApproved,
  writeChangeLog,
  type AtComputer,
} from '../src/records.ts'
import { CHANGE_LOG_SCHEMA, type ApprovedRecord, type ChangeEntry, type ChangeId, type ChangeLog, type ContentVersion } from '../src/types.ts'

const hooks = vi.hoisted(() => ({ linkError: undefined as Error | undefined }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: async (existing: string, created: string) => {
      if (hooks.linkError !== undefined) throw hooks.linkError
      await actual.link(existing, created)
    },
  }
})

const POSIX = process.platform !== 'win32'
const PROFILE = 'default'
const VERSION_A = brandString<ContentVersion>('a'.repeat(64))
const VERSION_B = brandString<ContentVersion>('b'.repeat(64))
const ID_1 = brandString<ChangeId>('c0123456789')
const ID_2 = brandString<ChangeId>('cabcdefabcd')

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'changes-records-'))
})

afterEach(async () => {
  hooks.linkError = undefined
  await rm(home, { recursive: true, force: true })
})

const terminal = (): AtComputer => attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
const studio = (): AtComputer => attestStudio({ loopback: true, credential: true, remoteSession: false })

async function refusal(action: Promise<unknown> | (() => unknown)): Promise<ChangesCode | undefined> {
  try {
    await (typeof action === 'function' ? action() : action)
  } catch (error) {
    if (isChangesError(error)) return error.code
    throw error
  }
  return undefined
}

async function writeRecord(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode })
  await chmod(path, mode)
}

function entry(fields: Partial<ChangeEntry> = {}): ChangeEntry {
  return { id: ID_1, kind: 'plugin-edit', state: 'pending', subject: { plugin: 'p', source: '/src/p' }, summary: 'Edits p', createdAt: '2026-11-10T10:00:00.000Z', ...fields }
}

describe('attestTerminal', () => {
  it('issues a terminal proof when both streams are terminals', () => {
    expect(terminal().kind).toBe('terminal')
  })

  it('refuses when standard input or output is not a terminal', async () => {
    expect(await refusal(() => attestTerminal({ stdin: {}, stdout: { isTTY: true } }))).toBe('NOT_AT_COMPUTER')
    expect(await refusal(() => attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: false } }))).toBe('NOT_AT_COMPUTER')
  })
})

describe('attestStudio', () => {
  it('issues a studio proof for a loopback request with the credential', () => {
    expect(studio().kind).toBe('studio')
  })

  it('refuses a remote session, a caller not on loopback and a missing credential', async () => {
    expect(await refusal(() => attestStudio({ loopback: true, credential: true, remoteSession: true }))).toBe('NOT_AT_COMPUTER')
    expect(await refusal(() => attestStudio({ loopback: false, credential: true, remoteSession: false }))).toBe('NOT_AT_COMPUTER')
    expect(await refusal(() => attestStudio({ loopback: true, credential: false, remoteSession: false }))).toBe('NOT_AT_COMPUTER')
  })
})

describe('protection', () => {
  it('is block when the home has no record', async () => {
    expect(await readProtection(home)).toBe('block')
  })

  it('is set from a terminal and read back, at 0600 under a 0700 changes directory', async () => {
    const record = await setProtection(home, 'warn', terminal())
    expect(record.level).toBe('warn')
    expect(await readProtection(home)).toBe('warn')
    if (POSIX) {
      expect((await stat(protectionPath(home))).mode & 0o777).toBe(0o600)
      expect((await stat(changesDirectory(home))).mode & 0o777).toBe(0o700)
    }
  })

  it('refuses a studio proof', async () => {
    expect(await refusal(setProtection(home, 'off', studio()))).toBe('NOT_AT_COMPUTER')
    expect(await readProtection(home)).toBe('block')
  })

  it('refuses an object that only looks like a terminal proof', async () => {
    const forged = { kind: 'terminal' } as AtComputer
    expect(await refusal(setProtection(home, 'off', forged))).toBe('NOT_AT_COMPUTER')
    const copied = { ...terminal() }
    expect(await refusal(setProtection(home, 'off', copied))).toBe('NOT_AT_COMPUTER')
    expect(await readProtection(home)).toBe('block')
  })

  it.runIf(POSIX)('refuses a record other users can read', async () => {
    await writeRecord(protectionPath(home), { schema: 'delo.changes-protection/1', level: 'off', setAt: '2026-11-10T10:00:00Z' }, 0o644)
    expect(await refusal(readProtection(home))).toBe('RECORD_UNREADABLE')
  })

  it('refuses an unknown level and every other malformed record', async () => {
    const valid = { schema: 'delo.changes-protection/1', level: 'off', setAt: '2026-11-10T10:00:00Z' }
    const cases: unknown[] = [
      { ...valid, level: 'none' },
      { ...valid, schema: 'delo.changes-protection/2' },
      { ...valid, setAt: 'yesterday' },
      { ...valid, setAt: 17 },
      { ...valid, extra: true },
      { schema: valid.schema, level: 'off' },
      [valid],
      null,
      '{ not json',
    ]
    for (const value of cases) {
      await writeRecord(protectionPath(home), value)
      expect(await refusal(readProtection(home)), JSON.stringify(value)).toBe('RECORD_UNREADABLE')
    }
    await writeRecord(protectionPath(home), valid)
    expect(await readProtection(home)).toBe('off')
  })

  it('refuses a record it cannot read', async () => {
    await writeFile(changesDirectory(home), 'not a directory')
    expect(await refusal(readProtection(home))).toBe('RECORD_UNREADABLE')
  })
})

describe('work session', () => {
  const start = { plugin: '@scope/p', source: '/src/p', from: VERSION_A }

  it('is absent until opened, and a second opening is refused', async () => {
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
    const record = await openWorkSession(home, PROFILE, start, terminal())
    expect(record).toMatchObject({ schema: 'delo.changes-work-session/1', ...start, startedFrom: 'terminal' })
    expect(await readWorkSession(home, PROFILE)).toEqual(record)
    expect(await refusal(openWorkSession(home, PROFILE, { ...start, plugin: 'other' }, studio()))).toBe('WORK_SESSION_OPEN')
    expect(await readdir(profileChangesDirectory(home, PROFILE))).toEqual(['work-session.json'])
    if (POSIX) expect((await stat(join(profileChangesDirectory(home, PROFILE), 'work-session.json'))).mode & 0o777).toBe(0o600)
  })

  it('records the studio as where it started', async () => {
    expect((await openWorkSession(home, PROFILE, start, studio())).startedFrom).toBe('studio')
  })

  it('refuses to open without a proof the attest functions issued', async () => {
    expect(await refusal(openWorkSession(home, PROFILE, start, { kind: 'studio' } as AtComputer))).toBe('NOT_AT_COMPUTER')
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
  })

  it('passes on a failure to link the record other than an existing one', async () => {
    hooks.linkError = Object.assign(new Error('link failed'), { code: 'EPERM' })
    await expect(openWorkSession(home, PROFILE, start, terminal())).rejects.toThrow('link failed')
    expect(await readdir(profileChangesDirectory(home, PROFILE))).toEqual([])
  })

  it('closes only the open plugin, with a proof', async () => {
    expect(await refusal(closeWorkSession(home, PROFILE, start.plugin, terminal()))).toBe('NO_WORK_SESSION')
    await openWorkSession(home, PROFILE, start, terminal())
    expect(await refusal(closeWorkSession(home, PROFILE, 'other', terminal()))).toBe('NO_WORK_SESSION')
    expect(await refusal(closeWorkSession(home, PROFILE, start.plugin, { kind: 'terminal' } as AtComputer))).toBe('NOT_AT_COMPUTER')
    expect((await closeWorkSession(home, PROFILE, start.plugin, studio())).plugin).toBe(start.plugin)
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
  })

  it('notes the content that last loaded', async () => {
    expect(await refusal(noteLoaded(home, PROFILE, VERSION_B))).toBe('NO_WORK_SESSION')
    await openWorkSession(home, PROFILE, start, terminal())
    expect((await noteLoaded(home, PROFILE, VERSION_B)).lastLoaded).toBe(VERSION_B)
    expect((await readWorkSession(home, PROFILE))?.lastLoaded).toBe(VERSION_B)
  })

  it('refuses a malformed record', async () => {
    const path = join(profileChangesDirectory(home, PROFILE), 'work-session.json')
    const valid = { schema: 'delo.changes-work-session/1', ...start, startedAt: '2026-11-10T10:00:00Z', startedFrom: 'terminal' }
    for (const value of [{ ...valid, startedFrom: 'remote' }, { ...valid, plugin: 'Not A Name' }, { ...valid, lastLoaded: 'abc' }, { ...valid, from: 7 }]) {
      await writeRecord(path, value)
      expect(await refusal(readWorkSession(home, PROFILE)), JSON.stringify(value)).toBe('RECORD_UNREADABLE')
    }
  })
})

describe('change log', () => {
  const full = entry({
    id: ID_2,
    kind: 'plugin-update',
    state: 'left-out-at-start',
    subject: { plugin: 'p', source: '/s', file: 'f', setting: 's', spec: 'p@1' },
    from: VERSION_A,
    to: VERSION_B,
    decidedAt: '2026-11-10T11:00:00Z',
    decidedFrom: 'start',
    historyVersion: 'h1',
    leftOut: { at: '2026-11-10T11:00:00Z', failure: 'did not start' },
    lastFailure: { at: '2026-11-10T11:05:00Z', failure: 'did not load' },
    shownAt: '2026-11-10T12:00:00Z',
  })

  it('is empty when the profile has none, and reads back what was written', async () => {
    expect(await readChangeLog(home, PROFILE)).toEqual({ schema: CHANGE_LOG_SCHEMA, entries: [] })
    const log: ChangeLog = { schema: CHANGE_LOG_SCHEMA, migratedAt: '2026-11-10T09:00:00Z', entries: [entry(), full] }
    await writeChangeLog(home, PROFILE, log)
    expect(await readChangeLog(home, PROFILE)).toEqual(log)
  })

  it('refuses an unknown state, a malformed id and every other malformed log', async () => {
    const valid = { schema: CHANGE_LOG_SCHEMA, entries: [entry()] }
    const cases: unknown[] = [
      { ...valid, entries: [{ ...entry(), state: 'maybe' }] },
      { ...valid, entries: [{ ...entry(), id: 'c123' }] },
      { ...valid, entries: [{ ...entry(), kind: 'plugin-delete' }] },
      { ...valid, entries: [{ ...entry(), decidedFrom: 'phone' }] },
      { ...valid, entries: [{ ...entry(), subject: { plugin: 'p', owner: 'x' } }] },
      { ...valid, entries: [{ ...entry(), leftOut: { at: '2026-11-10T11:00:00Z' } }] },
      { ...valid, entries: [entry(), entry()] },
      { ...valid, entries: {} },
      { ...valid, migratedAt: 'soon' },
    ]
    for (const value of cases) {
      await writeRecord(join(profileChangesDirectory(home, PROFILE), 'log.json'), value)
      expect(await refusal(readChangeLog(home, PROFILE)), JSON.stringify(value)).toBe('RECORD_UNREADABLE')
    }
  })

  it('replaces an entry with the same id or appends one, and finds entries', () => {
    const log: ChangeLog = { schema: CHANGE_LOG_SCHEMA, entries: [entry()] }
    const appended = withEntry(log, full)
    expect(appended.entries.map(item => item.id)).toEqual([ID_1, ID_2])
    const replaced = withEntry(appended, entry({ state: 'applied' }))
    expect(replaced.entries.map(item => item.state)).toEqual(['applied', 'left-out-at-start'])
    expect(findEntry(replaced, ID_2)).toBe(full)
    expect(findEntry(log, ID_2)).toBeUndefined()
  })
})

describe('active record', () => {
  it('is empty when the profile has none, and reads back what was written', async () => {
    expect(await readActiveRecord(home, PROFILE)).toEqual({ schema: 'delo.changes-active/1', plugins: {} })
    const record = { schema: 'delo.changes-active/1' as const, plugins: { '@scope/p': { version: VERSION_A, kind: 'work-session' as const } } }
    await writeActiveRecord(home, PROFILE, record)
    expect(await readActiveRecord(home, PROFILE)).toEqual(record)
  })

  it('refuses an unknown kind, a name that is not a package name and plugins that are not an object', async () => {
    const path = join(profileChangesDirectory(home, PROFILE), 'active.json')
    const content = { version: VERSION_A, kind: 'approved' }
    for (const plugins of [{ p: { ...content, kind: 'loaded' } }, { '../escape': content }, ['p']]) {
      await writeRecord(path, { schema: 'delo.changes-active/1', plugins })
      expect(await refusal(readActiveRecord(home, PROFILE)), JSON.stringify(plugins)).toBe('RECORD_UNREADABLE')
    }
  })
})

describe('approved record', () => {
  const approved: ApprovedRecord = {
    schema: 'delo.changes-approved/1',
    plugins: { p: { source: '/src/p', version: VERSION_A, approvedAt: '2026-11-10T10:00:00Z', approvedAtUpgrade: true } },
  }

  async function profileWith(manifest: unknown): Promise<string> {
    const directory = join(home, 'profile')
    await mkdir(directory)
    await writeFile(join(directory, 'package.json'), typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`)
    return directory
  }

  it('is empty when the manifest has no record', async () => {
    expect(await readApproved(await profileWith({ name: 'profile' }))).toEqual({ schema: 'delo.changes-approved/1', plugins: {} })
    await rm(join(home, 'profile'), { recursive: true })
    expect(await readApproved(await profileWith({ name: 'profile', delo: { other: 1 } }))).toEqual({ schema: 'delo.changes-approved/1', plugins: {} })
  })

  it('is written into package.json keeping every other field and the format, at 0600', async () => {
    const manifest = { name: 'profile', dependencies: { p: 'link:../p' }, delo: { other: 1 } }
    const directory = await profileWith(manifest)
    await writeApproved(directory, approved)
    const text = await readFile(join(directory, 'package.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify({ ...manifest, delo: { other: 1, changes: approved } }, null, 2)}\n`)
    if (POSIX) expect((await stat(join(directory, 'package.json'))).mode & 0o777).toBe(0o600)
    expect(await readApproved(directory)).toEqual(approved)
  })

  it('writes into a manifest without a delo field', async () => {
    const directory = await profileWith({ name: 'profile' })
    await writeApproved(directory, approved)
    expect(await readApproved(directory)).toEqual(approved)
  })

  it('names a plugin only when it is approved', () => {
    expect(approvedOf(approved, 'p')).toBe(approved.plugins.p)
    expect(approvedOf(approved, 'q')).toBeUndefined()
    expect(approvedOf(approved, 'constructor')).toBeUndefined()
  })

  it('refuses a missing or malformed package.json and a malformed record', async () => {
    expect(await refusal(readApproved(join(home, 'missing')))).toBe('RECORD_UNREADABLE')
    const plugin = approved.plugins.p
    const cases: unknown[] = [
      '{ not json',
      ['array'],
      { delo: 'text' },
      { delo: { changes: { ...approved, plugins: { p: { ...plugin, approvedAtUpgrade: false } } } } },
      { delo: { changes: { ...approved, plugins: { p: { ...plugin, approvedAt: 'later' } } } } },
      { delo: { changes: { schema: 'delo.changes-approved/0', plugins: {} } } },
    ]
    for (const manifest of cases) {
      const directory = await profileWith(manifest)
      expect(await refusal(readApproved(directory)), JSON.stringify(manifest)).toBe('RECORD_UNREADABLE')
      await rm(directory, { recursive: true })
    }
    const directory = await profileWith({ delo: 'text' })
    expect(await refusal(writeApproved(directory, approved))).toBe('RECORD_UNREADABLE')
  })
})
