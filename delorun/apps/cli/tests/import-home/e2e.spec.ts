/**
 * The stock-home import end to end. A stock home is made with upstream's own
 * Session persistence: one chat written through it in the current format, and
 * one chat in the format version 3 generation upstream still reads and
 * migrates. Beside them it holds a workspace registration, a profile with one
 * bundled and one third-party plugin, and a key. `delorun import-home
 * --dry-run` prints the preview and writes nothing; the real import copies
 * the data, the profile and the key after a yes to each; upstream's own Session listing over the Delorun home then shows both
 * chats with the same events it shows over the stock home; and every file of
 * the stock home is byte-identical to before.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { EXIT } from '../../src/exit.ts'
import { main } from '../../src/main.ts'
import { fresh, put, removeScratch, runCommand, snapshot, STOCK_SECRET } from './support.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  removeScratch()
})

/**
 * Mount upstream's JSONL Session persistence over one sessions root.
 * @param root - the sessions root.
 * @returns the persistence service, whose context the spec disposes.
 */
async function persistence(root: string): Promise<SessionPersistence> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  return ctx.sessionPersistence
}

/**
 * Every chat upstream's listing shows over one sessions root, with the events a read returns.
 * @param root - the sessions root.
 * @returns each chat's id with its events, by id.
 */
async function chats(root: string): Promise<Record<string, readonly SessionEvent[]>> {
  const store = await persistence(root)
  const result: Record<string, readonly SessionEvent[]> = {}
  for (const listed of await store.list()) {
    const handle = await store.open(listed.header.id, 'read')
    try {
      result[listed.header.id] = (await handle.read()).events
    } finally {
      await handle.close()
    }
  }
  return result
}

/**
 * Write a chat through upstream's persistence in the current format.
 * @param root - the sessions root.
 * @param cwd - the chat's working directory.
 */
async function currentChat(root: string, cwd: string): Promise<void> {
  const store = await persistence(root)
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('current-chat'), createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 }
  const handle = await store.create(header)
  try {
    const message = { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
    // The events as a stored log holds them; upstream's append checks each one against the current format.
    const events: SessionEvent[] = JSON.parse(JSON.stringify([
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 11, data: message, surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
    ]))
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

/**
 * Write a chat as a format version 3 generation, the form upstream's version 3 harness wrote and this one migrates.
 * @param root - the sessions root.
 */
async function olderChat(root: string): Promise<void> {
  const id = SessionId('older-chat')
  const path = generationLogPath(root, undefined, id, 3, 'zstd')
  const message = { id: 'next', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }
  const rows = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: message, surfaceOp: 'append' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: seq + 10 }))
  const header = { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([await compressZstdFrame(`${JSON.stringify(header)}\n`), await compressZstdFrame(rows.map(row => `${JSON.stringify(row)}\n`).join(''))]), { mode: 0o600 })
}

describe('delorun import-home end to end', () => {
  it('previews, writes nothing on a dry run, imports, and leaves both chats readable by upstream and the stock home byte-identical', async () => {
    const person = fresh('e2e')
    const source = join(person, '.dsh')
    const target = join(person, '.delorun')
    const workspace = join(person, 'project')
    mkdirSync(workspace)
    await currentChat(join(source, 'sessions'), workspace)
    await olderChat(join(source, 'sessions'))
    put(source, 'storages/workspace.json', `${JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: { w1: { path: workspace, title: 'project', sessionIds: ['current-chat'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } } }, null, 2)}\n`)
    put(source, 'profiles/web/package.json', `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { 'third-party-plugin': '^1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-plugin'] } } }, null, 2)}\n`)
    put(source, 'profiles/web/cordis.patch.yml', '[]\n')
    put(source, '.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${STOCK_SECRET}\n`, 0o600)
    const stock = await chats(join(source, 'sessions'))
    expect(Object.keys(stock).sort()).toEqual(['current-chat', 'older-chat'])
    const before = snapshot(source)

    let out = ''
    let err = ''
    expect(await main(['import-home', '--dry-run'], { env: { HOME: person, DELORUN_HOME: target }, stdout: (text) => { out += text }, stderr: (text) => { err += text } })).toBe(EXIT.ok)
    expect(err).toBe('')
    expect(out).toContain('  Chats: 2 chats to copy')
    expect(out).toContain('  Workspaces: 1 registration, copied as the Delorun home\'s workspace list')
    expect(out).toContain('      carried      "@deepseek-ai/dsh-base" (ships with DeepSeek Harness)')
    expect(out).toContain('      to install   "third-party-plugin" (from the registry, ^1.0.0)')
    expect(out).toContain('    "DEEPSEEK_API_KEY": can be copied')
    expect(out).not.toContain(STOCK_SECRET)
    expect(snapshot(target)).toEqual([])

    // Yes to the data, to the profile and to the key: the stock home holds no settings, instructions or skills to ask about.
    const run = await runCommand([], { home: target, env: { HOME: person }, answers: ['y', 'y', 'y'] })
    expect(run.code).toBe(EXIT.ok)
    expect(run.asked).toHaveLength(3)
    expect(run.out).toContain('Imported 2 chats')
    expect(readFileSync(join(target, 'profiles/web/package.json'), 'utf8')).toContain('"@delorun/bundle-local"')

    const imported = await chats(join(target, 'sessions'))
    expect(Object.keys(imported).sort()).toEqual(['current-chat', 'older-chat'])
    for (const id of Object.keys(stock)) expect(imported[id]).toHaveLength((stock[id] as readonly SessionEvent[]).length)
    expect(imported).toEqual(stock)
    expect(readFileSync(join(target, 'storages/workspace.json'), 'utf8')).toBe(readFileSync(join(source, 'storages/workspace.json'), 'utf8'))
    expect(readFileSync(join(target, '.credentials.yaml'), 'utf8')).toContain(STOCK_SECRET)
    expect(snapshot(source)).toEqual(before)
  }, 120_000)
})
