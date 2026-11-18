import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '../../../storage/storage-json/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry from '../src/index.ts'
import { inspectRegistryText } from '../src/inspect.ts'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'

interface Document {
  global: { workspaceIds: string[] }
  tables: { workspaces: Record<string, Record<string, unknown>> }
}

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-quarantine-'))
  roots.push(await realpath(root))
  return await realpath(root)
}

async function boot(backend: StorageBackend) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('b', backend)
  const facility = new DomainFacility(ctx, { backend: 'b', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: async () => [], open: vi.fn(), stat: vi.fn() } as never)
  const warn = vi.spyOn(ctx.logger, 'warn')
  const fiber = await ctx.plugin(WorkspaceRegistry)
  return { ctx, fiber, warn, registry: ctx.workspaceRegistry }
}

/** Create three workspaces over folders under `root`, stop, and return the registry file's document. */
async function seed(root: string): Promise<{ file: string; document: Document; folders: string[] }> {
  const folders = [join(root, 'a'), join(root, 'b'), join(root, 'c')]
  const store = join(root, 'store')
  const { fiber, registry } = await boot(new JsonStorageBackend(store))
  for (const folder of folders) {
    await mkdir(folder)
    await registry.create(folder, folder.slice(-1))
  }
  await fiber.dispose()
  const file = join(store, 'workspace.json')
  return { file, document: JSON.parse(await readFile(file, 'utf8')) as Document, folders }
}

/** The id at a position of the seeded registry order; the seed holds three. */
function idAt(document: Document, index: number): string {
  const id = document.global.workspaceIds[index]
  if (id === undefined) throw new Error(`the seeded registry order has no entry ${String(index)}`)
  return id
}

/** The seeded record of a workspace id. */
function recordOf(document: Document, id: string): Record<string, unknown> {
  const found = document.tables.workspaces[id]
  if (found === undefined) throw new Error(`the seeded document has no record ${id}`)
  return found
}

const asides = async (store: string): Promise<string[]> =>
  (await readdir(store)).filter(name => name.includes('.quarantined-')).sort()

describe('registry quarantine', () => {
  it('boots with the consistent records and sets the inconsistent ones aside', async () => {
    const root = await freshRoot()
    const { file, document, folders } = await seed(root)
    const [first, second, third] = [idAt(document, 0), idAt(document, 1), idAt(document, 2)]
    // A record outside the order, a dangling and a repeated order entry, a path claimed twice and a session claimed twice.
    document.tables.workspaces.orphan = { ...recordOf(document, first), path: join(root, 'orphan') }
    document.tables.workspaces.twin = { ...recordOf(document, second) }
    recordOf(document, third).sessionIds = ['s1']
    recordOf(document, second).sessionIds = ['s1']
    document.global.workspaceIds = [...document.global.workspaceIds, 'twin', 'ghost', second]
    await writeFile(file, JSON.stringify(document), 'utf8')

    const { registry, warn, fiber } = await boot(new JsonStorageBackend(join(root, 'store')))
    expect(registry.list().map(workspace => workspace.path).sort()).toEqual(folders.slice().sort())
    expect(registry.get(third as never)?.sessionIds ?? []).toEqual([])
    expect(registry.quarantined).toHaveLength(1)
    const aside = JSON.parse(await readFile(registry.quarantined[0]!, 'utf8')) as { reasons: string[]; records: object }
    expect(aside.reasons.join('\n')).toMatch(/orphan.*absent from registry order/)
    expect(aside.reasons.join('\n')).toMatch(/claimed by both/)
    expect(aside.reasons.join('\n')).toMatch(/references missing workspace 'ghost'/)
    expect(aside.reasons.join('\n')).toMatch(/repeats workspace/)
    expect(Object.keys(aside.records).sort()).toEqual(['orphan', 'twin'])
    const logged = warn.mock.calls.map(call => String(call[0])).join('\n')
    expect(logged).toContain(registry.quarantined[0]!)
    expect(logged).toContain("record 'orphan'")
    expect(logged).toContain("record 'twin'")
    await fiber.dispose()

    const cleaned = JSON.parse(await readFile(file, 'utf8')) as Document
    expect(Object.keys(cleaned.tables.workspaces)).toHaveLength(3)
    expect(cleaned.global.workspaceIds).toHaveLength(3)

    // The cleaned file starts again without another set-aside file.
    const again = await boot(new JsonStorageBackend(join(root, 'store')))
    expect(again.registry.quarantined).toEqual([])
    expect(again.registry.list()).toHaveLength(3)
    await again.fiber.dispose()
    expect(await asides(join(root, 'store'))).toHaveLength(1)
  })

  it('boots empty with the raw file set aside when the file does not parse, and never overwrites an earlier quarantine', async () => {
    const root = await freshRoot()
    const { file } = await seed(root)
    const store = join(root, 'store')
    await writeFile(file, '{ "unit": ', 'utf8')
    const first = await boot(new JsonStorageBackend(store))
    expect(first.registry.list()).toEqual([])
    expect(await readFile(first.registry.quarantined[0]!, 'utf8')).toBe('{ "unit": ')
    await first.registry.create(join(root, 'a'), 'a')
    await first.fiber.dispose()

    await writeFile(file, 'garbage', 'utf8')
    const second = await boot(new JsonStorageBackend(store))
    await second.fiber.dispose()
    expect(await asides(store)).toHaveLength(2)
    expect(await readFile(first.registry.quarantined[0]!, 'utf8')).toBe('{ "unit": ')
  })

  it('keeps the other records when one record does not match the record format', async () => {
    const root = await freshRoot()
    const { file, document } = await seed(root)
    recordOf(document, idAt(document, 0)).title = 5
    await writeFile(file, JSON.stringify(document), 'utf8')
    const { registry, fiber } = await boot(new JsonStorageBackend(join(root, 'store')))
    // The record is gone from the table, so the order entry for it is dangling and set aside too.
    expect(registry.list()).toHaveLength(2)
    expect(registry.quarantined).toHaveLength(2)
    await fiber.dispose()
  })

  it('refuses to start when the backend cannot keep the records aside', async () => {
    const pool = new MemoryMediaPool()
    const seeded = await boot(new MemoryStorageBackend(pool))
    await seeded.fiber.dispose()
    const unit = await new MemoryStorageBackend(pool).kv.open({ name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true })
    await unit.setGlobal({ initialized: true, workspaceIds: ['ghost'], archivedSessionIds: [], pinnedSessionIds: [] })
    await unit.close()
    await expect(boot(new MemoryStorageBackend(pool))).rejects.toThrow(/references missing workspace 'ghost'/)
  })
})

describe('inspectRegistryText', () => {
  const record = { path: '/p', title: 't', sessionIds: [], createdAt: 'x', updatedAt: 'x' }
  const document = (global: unknown, workspaces: unknown) =>
    JSON.stringify({ unit: { name: 'workspace', version: 2 }, global, tables: { workspaces } })

  it('reports an unreadable file', () => {
    expect(inspectRegistryText('{')).toMatchObject({ state: 'unreadable', reason: expect.stringContaining('not valid JSON') })
    expect(inspectRegistryText('null')).toMatchObject({ state: 'unreadable' })
    expect(inspectRegistryText('{"unit":{"name":"other"}}')).toMatchObject({ state: 'unreadable' })
    expect(inspectRegistryText('{"unit":{"name":"workspace"},"tables":{"workspaces":[]}}')).toMatchObject({ state: 'unreadable' })
  })

  it('counts workspaces and names each problem', () => {
    expect(inspectRegistryText(document({ initialized: true, workspaceIds: ['a'] }, { a: record })))
      .toEqual({ state: 'readable', workspaces: 1, problems: [] })
    expect(inspectRegistryText('{"unit":{"name":"workspace"}}')).toEqual({ state: 'readable', workspaces: 0, problems: [] })
    expect(inspectRegistryText(document(null, { a: record }))).toEqual({ state: 'readable', workspaces: 1, problems: [] })
    const damaged = inspectRegistryText(document({ initialized: true, workspaceIds: ['a', 'x'] }, { a: record, b: record, c: { ...record, title: 4 } }))
    expect(damaged).toMatchObject({ state: 'readable', workspaces: 2 })
    if (damaged.state !== 'readable') throw new Error('the damaged registry reads as unreadable')
    expect(damaged.problems.join('\n')).toMatch(/record 'c' does not match the record format[\s\S]*missing workspace 'x'[\s\S]*'b' is absent[\s\S]*claimed by both/)
    expect(inspectRegistryText(document({ initialized: 'yes' }, {}))).toMatchObject({ problems: [expect.stringContaining('state format')] })
  })
})
