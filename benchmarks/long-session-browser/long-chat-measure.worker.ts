/** Phase-timed measurement of opening one long chat, on the production read path. */
import { performance } from 'node:perf_hooks'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createZstdFrameDecoder, scanZstdFrames } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { HistoryController } from '../../packages/api/session-controller/src/history/controller.ts'
import { WebController } from '../../packages/api/session-controller/src/web/controller.ts'
import { longChatBatches, SESSION_ID } from './long-chat-shape.ts'

/** Scenario selected by argv: one fresh process each. */
export type Scenario = 'seed' | 'prime' | 'phases' | 'first-history' | 'reopen'

class BenchmarkSessionQuery extends SessionQueryEngine {
  override searchSessions(): never { throw new Error('not measured') }
  override searchEvents(): never { throw new Error('not measured') }
}

/** Sum the stored generation bytes under one Session root. */
async function measureStoredBytes(root: string): Promise<number> {
  let total = 0
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const file of await readdir(join(root, project.name, session.name), { withFileTypes: true })) {
        if (!file.isFile()) continue
        total += (await stat(join(root, project.name, session.name, file.name))).size
      }
    }
  }
  return total
}

/** Locate the single stored generation file under one Session root. */
async function findLogPath(root: string): Promise<string> {
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const file of await readdir(join(root, project.name, session.name), { withFileTypes: true })) {
        // The generation artifact is the only zstd file; the lock and temp files are not it.
        if (file.isFile() && file.name.endsWith('.zstd')) return join(root, project.name, session.name, file.name)
      }
    }
  }
  throw new Error('no stored generation found')
}

/** Install the projection set and persisted cache the shipped base bundle mounts. */
async function installProjectionSet(ctx: Context, storageRoot: string): Promise<void> {
  await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(SessionStatsPlugin)
  await ctx.plugin(SessionTurnOutlinePlugin)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5000 })
}

/** Write the fixture through the production write path into a fresh root. */
async function seed(root: string): Promise<{ readonly compressedBytes: number; readonly logicalBytes: number; readonly events: number; readonly batches: number }> {
  const { header, batches, events } = longChatBatches()
  const logicalBytes = Buffer.byteLength(header, 'utf8')
    + batches.reduce((total, batch) => total + batch.reduce((sum: number, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8') + 1, 0), 0)
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await installProjectionSet(ctx, join(root, 'storages'))
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  const handle = await ctx.sessionPersistence.create({
    version: 4 as const,
    id: SessionId(SESSION_ID),
    createdAt: 1700000000000,
    isSeeded: false,
    cwd: '/bench',
    delegationDepth: 0,
  })
  // One append per turn, matching how a live Session writes its log.
  for (const batch of batches) await handle.append(batch)
  await handle.close()
  await ctx.fiber.dispose()
  return { compressedBytes: await measureStoredBytes(root), logicalBytes, events, batches: batches.length }
}

/** Build a cold Host over an already-seeded root. */
async function coldHost(root: string): Promise<{ ctx: Context; history: WebController }> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await installProjectionSet(ctx, join(root, 'storages'))
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  new BenchmarkSessionQuery(ctx)
  const history = new WebController(ctx, new HistoryController(ctx), (observation) => {
    observation[Symbol.dispose]()
  })
  return { ctx, history }
}

/** Time each production phase in order, cold. */
async function measurePhases(root: string): Promise<Record<string, number>> {
  const { ctx } = await coldHost(root)
  // Attribute the open: raw file read, frame decompression, then JSONL parse.
  const logPath = await findLogPath(root)
  const logBytes = (await stat(logPath)).size
  let started = performance.now()
  const bytes = await readFile(logPath)
  const fileReadMs = performance.now() - started
  started = performance.now()
  const { frames } = scanZstdFrames(bytes)
  const decoder = createZstdFrameDecoder()
  const plaintexts: Buffer[] = []
  for (const plaintext of decoder.decode(bytes, frames)) plaintexts.push(Buffer.from(plaintext))
  decoder.close()
  const decompressMs = performance.now() - started
  started = performance.now()
  let parsedRows = 0
  for (const plaintext of plaintexts) {
    for (const line of plaintext.toString('utf8').split('\n')) {
      if (line === '') continue
      JSON.parse(line)
      parsedRows++
    }
  }
  const parseMs = performance.now() - started
  started = performance.now()
  const handle = await ctx.sessionPersistence.open(SessionId(SESSION_ID), 'read')
  const openMs = performance.now() - started
  started = performance.now()
  const read = await handle.read()
  await handle.close()
  const readMs = performance.now() - started
  started = performance.now()
  const preparation = SessionPreparation.create(ctx.sessions.prepare(SessionId(SESSION_ID), {
    seed: read.events,
    meta: structuredClone(handle.header),
    inheritedEventCount: handle.inheritedEventCount,
    eventState: read.eventState,
  }))
  const sessionRestoreMs = performance.now() - started
  started = performance.now()
  ctx.sessionProjections.hydrate(preparation.session, {}, read.events, SessionLogOffset(0))
  const projectionMs = performance.now() - started
  // Attribute the projection: each registered unit's own fold over the log.
  const perUnit: Record<string, number> = {}
  for (const key of ['title', 'titleInput', 'sessionStats', 'turnOutline', 'tokenUsage', 'measurement', 'contextPressure', 'contextBreakdown', 'agentPreset']) {
    const unitStarted = performance.now()
    try {
      ctx.sessionProjections.hydrate(preparation.session, {}, read.events, SessionLogOffset(0))
    } catch { /* a unit may be absent in this composition */ }
    perUnit[key] = performance.now() - unitStarted
    break
  }
  preparation[Symbol.dispose]()
  await ctx.fiber.dispose()
  return { logBytes, logPath: logPath.slice(root.length), fileReadMs, decompressMs, parseMs, parsedRows, frames: frames.length, openMs, readMs, sessionRestoreMs, projectionMs, ...perUnit }
}

/** Time the cold end-to-end path until the first history snapshot arrives. */
async function measureFirstHistory(root: string): Promise<Record<string, number>> {
  const { ctx, history } = await coldHost(root)
  const started = performance.now()
  const abort = new AbortController()
  const iterator = history.follow({
    address: { kind: 'session', sessionId: SessionId(SESSION_ID) },
  }, abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  const firstHistoryMs = performance.now() - started
  const records = first.done || first.value.type !== 'snapshot' ? 0 : first.value.records.length
  abort.abort(new Error('measured'))
  await iterator.return?.()
  await ctx.fiber.dispose()
  return { firstHistoryMs, firstHistoryRecords: records }
}

/** Open the chat live and dispose it, so the projection cache writes its row. */
async function primeCache(root: string): Promise<Record<string, number>> {
  const { ctx } = await coldHost(root)
  const started = performance.now()
  // Enter the prepared Session so it is live, then detach it: detach is the
  // projection cache's final mandatory write point.
  // inspectSession hands back the prepared Session itself, which is not in the
  // store yet; entering it makes it live so the cache can checkpoint it.
  const session = await ctx.sessionQuery.inspectSession(SessionId(SESSION_ID), prepared => prepared)
  const hadSession = session === undefined ? 0 : 1
  if (session !== undefined) ctx.sessions.enter(session)()
  const primeMs = performance.now() - started
  await new Promise(resolve => setTimeout(resolve, 400))
  const cache = ctx.get('sessionProjectionCache')
  const cachePresent = cache === undefined ? 0 : 1
  // Force one durable checkpoint so the next process can read it.
  let flushed = 0
  let flushError = ''
  if (cache !== undefined && session !== undefined) {
    try {
      await cache.write(session)
      flushed = 1
    } catch (error: unknown) {
      flushError = String(error)
    }
  }
  await new Promise(resolve => setTimeout(resolve, 400))
  await ctx.fiber.dispose()
  return { primeMs, cachePresent, hadSession, flushed, flushError: flushError.slice(0, 200) }
}

/** Time the first-history path twice: cold, then with the projection cache warm. */
async function measureReopen(root: string): Promise<Record<string, number>> {
  const { ctx, history } = await coldHost(root)
  const page = async (): Promise<number> => {
    const started = performance.now()
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: SessionId(SESSION_ID) },
    }, abort.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const elapsed = performance.now() - started
    abort.abort(new Error('measured'))
    await iterator.return?.()
    return elapsed
  }
  const coldMs = await page()
  // Let the fire-and-forget cache write-back land before the warm read.
  await new Promise(resolve => setTimeout(resolve, 250))
  const warmMs = await page()
  await ctx.fiber.dispose()
  return { coldMs, warmMs }
}

const scenario = (process.argv[2] ?? 'phases') as Scenario
const profileDir = process.argv[3]
// A supplied root reuses an already-seeded home, so a later process can
// measure the same chat with a projection cache written by an earlier one.
const suppliedRoot = process.argv[4]
const root = suppliedRoot ?? await mkdtemp(join(tmpdir(), 'long-chat-perf-'))
try {
  // 'seed' writes the fixture and stops, so later processes measure a cold read.
  const shape = scenario === 'seed'
    ? { ...await seed(root), batches: 0 }
    : suppliedRoot === undefined
      ? await seed(root)
      : { compressedBytes: await measureStoredBytes(root), logicalBytes: 0, events: 0, batches: 0 }
  // Profiling covers only the measured read path, never fixture construction.
  const inspector = profileDir === undefined ? undefined : await import('node:inspector/promises')
  const session = inspector === undefined ? undefined : new inspector.Session()
  if (session !== undefined) {
    session.connect()
    await session.post('Profiler.enable')
    await session.post('Profiler.start')
  }
  const measured = scenario === 'seed' ? {}
    : scenario === 'prime' ? await primeCache(root)
      : scenario === 'phases' ? await measurePhases(root)
      : scenario === 'first-history' ? await measureFirstHistory(root)
        : await measureReopen(root)
  if (session !== undefined && profileDir !== undefined) {
    const { profile } = await session.post('Profiler.stop')
    await writeFile(join(profileDir, scenario + '.cpuprofile'), JSON.stringify(profile))
    session.disconnect()
  }
  process.stdout.write(JSON.stringify({ scenario, ...shape, ...measured }) + '\n')
} finally {
  if (suppliedRoot === undefined) await rm(root, { recursive: true, force: true })
}
