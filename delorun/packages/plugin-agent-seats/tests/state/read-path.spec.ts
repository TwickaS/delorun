/**
 * The seat's logged events through the real read path of the JSONL Session store: a log that holds them reads back, a log
 * that holds an event type this build does not know is refused, and an earlier preview's ignorable plugin records are admitted.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SEAT_NOTICE_EVENT, SEAT_STATE_EVENT, SEAT_STATUS_EVENT } from '../../src/state/index.ts'
import { describeSeat } from './support.ts'

let root: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ea2-seat-read-'))
  ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(SessionStore)
})

afterEach(async () => {
  try {
    await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** The path of the one log file under the store root. */
async function logPath(): Promise<string> {
  const entries = await readdir(root, { recursive: true })
  const logs = entries.filter(entry => entry.endsWith('.jsonl'))
  expect(logs).toHaveLength(1)
  return join(root, logs[0] as string)
}

/** Write a seat child's log through the persistence plugin and return its id and file path. */
async function writtenLog(): Promise<{ id: SessionId, path: string }> {
  const session = ctx.sessions.create()
  describeSeat(session)
  session.append(SEAT_STATUS_EVENT, { state: 'working' })
  session.append(SEAT_STATE_EVENT, { programSessionId: 'program-1', cursor: 'm1' })
  session.append(SEAT_NOTICE_EVENT, { kind: 'model-chosen', text: 'x' })
  const writer = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
  try {
    await writer.append(session.snapshotEvents())
  } finally {
    await writer.close()
  }
  return { id: session.header.id, path: await logPath() }
}

/**
 * Read the log back through the persistence plugin.
 * @param id - the Session id.
 * @returns the event types in order.
 */
async function readTypes(id: SessionId): Promise<string[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events.map(event => event.type)
  } finally {
    await handle.close()
  }
}

/**
 * Rewrite the log's seat rows.
 * @param path - the log file.
 * @param change - maps a seat row to the row to store.
 */
async function rewriteSeatRows(path: string, change: (row: { type: string, [key: string]: unknown }) => unknown): Promise<void> {
  const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as { type: string })
  await writeFile(path, rows.map(row => JSON.stringify(row.type.startsWith('external-agent/') ? change(row) : row)).join('\n') + '\n')
}

describe('the seat events on the JSONL read path', () => {
  it('reads back a log that holds them', async () => {
    const { id } = await writtenLog()
    expect(await readTypes(id)).toEqual(['subagent/descriptor', SEAT_STATUS_EVENT, SEAT_STATE_EVENT, SEAT_NOTICE_EVENT])
  })

  it('refuses a log that holds a required event type this build does not know, as an older build refuses these three', async () => {
    const { id, path } = await writtenLog()
    await rewriteSeatRows(path, row => ({ ...row, type: `${row.type}-from-a-later-build` }))
    await expect(readTypes(id)).rejects.toThrow('unknown to this harness and not marked ignorable')
  })

  it('admits the ignorable plugin records an earlier preview wrote, and returns them as unknown records', async () => {
    const { id, path } = await writtenLog()
    await rewriteSeatRows(path, row => ({ ...row, type: row.type.replace('external-agent/', 'plugin:delorun/agent-seat/'), ignorable: true }))
    expect(await readTypes(id)).toEqual(['subagent/descriptor', ...['status', 'state', 'notice'].map(name => `plugin:delorun/agent-seat/${name}`)])
  })
})
