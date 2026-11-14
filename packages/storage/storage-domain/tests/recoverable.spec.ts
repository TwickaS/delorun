import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../../storage-json/src/index.ts'
import { defineDomain, descriptorOf, DomainFacility, domainTable } from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const itemSchema = z.object({ label: z.string() })
const spec = defineDomain({
  name: 'keep',
  version: 1,
  recoverable: true,
  tables: { items: domainTable<string, z.infer<typeof itemSchema>>(itemSchema) },
})

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function open(backend: JsonStorageBackend | MemoryStorageBackend) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('b', backend)
  const warn = vi.spyOn(ctx.logger, 'warn')
  const facility = new DomainFacility(ctx, { backend: 'b', routes: {} })
  ctx.storage.mount('domain', facility)
  return { facility, warn }
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-domain-recoverable-'))
  roots.push(root)
  return root
}

const document = (items: Record<string, unknown>) =>
  JSON.stringify({ unit: { name: 'keep', version: 1 }, global: null, tables: { items } })

describe('recoverable domain', () => {
  it('projects the flag onto the descriptor', () => {
    expect(descriptorOf(spec)).toMatchObject({ recoverable: true })
    expect(descriptorOf(defineDomain({ name: 'plain', version: 1, tables: {} }))).not.toHaveProperty('recoverable')
  })

  it('opens empty and reports the location when the document is unparsable', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'keep.json'), '{nope', 'utf8')
    const { facility, warn } = await open(new JsonStorageBackend(root))
    const domain = await facility.open(spec)
    expect(domain.quarantined).toHaveLength(1)
    expect(await readFile(domain.quarantined[0]!, 'utf8')).toBe('{nope')
    expect(domain.table('items').size).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(domain.quarantined[0]!))
    await domain.close()
  })

  it('sets a record that fails its schema aside, keeps the valid ones and removes the bad one from the file', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'keep.json'), document({ ok: { label: 'fine' }, bad: { label: 5 } }), 'utf8')
    const { facility, warn } = await open(new JsonStorageBackend(root))
    const domain = await facility.open(spec)
    expect([...domain.table('items').keys()]).toEqual(['ok'])
    expect(domain.quarantined).toHaveLength(1)
    const aside = JSON.parse(await readFile(domain.quarantined[0]!, 'utf8')) as Record<string, unknown>
    expect(aside).toMatchObject({ domain: 'keep', table: 'items', key: 'bad', record: { label: 5 } })
    expect(Object.keys(JSON.parse(await readFile(join(root, 'keep.json'), 'utf8')).tables.items)).toEqual(['ok'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("record 'bad'"))
    await domain.close()
  })

  it('sets a consumer finding aside on the write chain', async () => {
    const root = await freshRoot()
    const { facility } = await open(new JsonStorageBackend(root))
    const domain = await facility.open(spec)
    const location = await domain.setAside({ finding: 1 })
    expect(JSON.parse(await readFile(location!, 'utf8'))).toEqual({ finding: 1 })
    expect(domain.quarantined).toEqual([location])
    await domain.close()
  })

  it('has nothing to set aside on a backend without support, and a bad record still rejects', async () => {
    const { facility } = await open(new MemoryStorageBackend())
    const domain = await facility.open(spec)
    expect(await domain.setAside({ finding: 1 })).toBeUndefined()
    expect(domain.quarantined).toEqual([])
    await domain.close()
  })

  it('rejects a bad record when the backend cannot set it aside', async () => {
    const pool = new MemoryMediaPool()
    const seed = await new MemoryStorageBackend(pool).kv.open(descriptorOf(spec))
    await seed.putRecord('items', 'bad', { label: 5 })
    await seed.close()
    const { facility } = await open(new MemoryStorageBackend(pool))
    await expect(facility.open(spec)).rejects.toMatchObject({ code: 'invalid-record' })
  })
})
