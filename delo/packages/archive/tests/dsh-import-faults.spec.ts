/**
 * Faults the stock-home import cannot cause from a fixture: a stock file that
 * grows or shrinks while it is read, which the reader refuses rather than
 * copying torn; a platform without `/proc`, where the reader proves a path by
 * resolving it again; a file system that does not sync a directory; and a
 * failure of the profile reader that is not a refusal, which the plan passes
 * on rather than reporting the profile as unreadable.
 */
import { lstatSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDshHomeImport } from '../src/dsh-import/index.ts'
import { carryNotes } from '../src/dsh-import/profiles.ts'
import { SourceReader } from '../src/dsh-import/source.ts'
import { makeHomes, manifest, mark, plan, type Homes } from './dsh-import-support.ts'

const fault = vi.hoisted(() => ({
  read: undefined as 'grow' | 'shrink' | undefined,
  inventory: undefined as number | undefined,
  bundles: false,
  procfs: true,
  directorySync: undefined as string | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readlink: (async (...args: Parameters<typeof actual.readlink>) => {
      if (!fault.procfs && String(args[0]).startsWith('/proc/')) throw Object.assign(new Error('no procfs'), { code: 'ENOENT' })
      return actual.readlink(...args)
    }) as typeof actual.readlink,
    opendir: (async (...args: Parameters<typeof actual.opendir>) => {
      if (!fault.procfs && String(args[0]).startsWith('/proc/')) throw Object.assign(new Error('no procfs'), { code: 'ENOENT' })
      return actual.opendir(...args)
    }) as typeof actual.opendir,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const code = fault.directorySync
      if (code !== undefined && args[1] === 'r' && String(args[0]).endsWith('stock-import')) {
        // A directory opened to sync it, on a file system that refuses the sync.
        return new Proxy(handle, {
          get(target, key) {
            if (key !== 'sync') return Reflect.get(target, key, target)
            return async () => { throw Object.assign(new Error(code), { code }) }
          },
        })
      }
      if (fault.read === undefined) return handle
      const mode = fault.read
      // The first read returns more bytes than the file held, or none, as a concurrent writer would make it.
      return new Proxy(handle, {
        get(target, key) {
          if (key !== 'read') return Reflect.get(target, key, target)
          return async (buffer: Buffer) => ({ bytesRead: mode === 'grow' ? buffer.length + 1 : 0, buffer })
        },
      })
    }) as typeof actual.open,
  }
})

vi.mock('@delo/profile-safety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delo/profile-safety')>()
  return {
    ...actual,
    bundleListOf: (...args: Parameters<typeof actual.bundleListOf>) => {
      if (fault.bundles) throw new TypeError('an unexpected bundle failure')
      return actual.bundleListOf(...args)
    },
    readInventory: (...args: Parameters<typeof actual.readInventory>) => {
      // The reader fails once the given number of reads succeeded.
      if (fault.inventory !== undefined && fault.inventory-- === 0) throw new TypeError('an unexpected failure')
      return actual.readInventory(...args)
    },
  }
})

let homes: Homes

beforeEach(() => {
  homes = makeHomes()
})

afterEach(() => {
  fault.read = undefined
  fault.inventory = undefined
  fault.procfs = true
  fault.bundles = false
  fault.directorySync = undefined
  homes.remove()
})

describe('faults', () => {
  it('refuses a stock file that grew or shrank while it was read', async () => {
    homes.write('AGENTS.md', '# notes\n')
    const reader = new SourceReader(homes.source, 10, lstatSync(homes.source).dev)
    const entry = await reader.inspect('AGENTS.md')
    if (entry.kind !== 'file') throw new Error('the fixture is a plain file')
    fault.read = 'grow'
    await expect(reader.read(entry.file)).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_CHANGED', message: expect.stringContaining('it grew while it was read') })
    fault.read = 'shrink'
    await expect(reader.read(entry.file)).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_CHANGED', message: expect.stringContaining('it shrank while it was read') })
  })

  it('passes on a failure of the profile reader that is not a refusal', async () => {
    homes.write('profiles/web/package.json', manifest([]))
    fault.inventory = 0
    await expect(plan(homes)).rejects.toThrow('an unexpected failure')
    fault.inventory = undefined
    fault.bundles = true
    await expect(plan(homes)).rejects.toThrow('an unexpected bundle failure')
    fault.bundles = false
    fault.inventory = 1
    const text = manifest([])
    expect(() => carryNotes({ stockManifest: text, stockPatch: undefined, stockHomePatch: undefined, landedManifest: text, landedPatch: undefined, landedHomePatch: undefined, bundles: [], ownHomePatch: false })).toThrow('an unexpected failure')
  })

  it('proves a listed directory and a read file by resolving the path again where there is no /proc', async () => {
    homes.write('sessions/_no-cwd/s1/session.v4.jsonl.zstd', 'chat')
    fault.procfs = false
    const planned = await plan(homes)
    expect(planned.chats.map(chat => chat.path)).toEqual(['sessions/_no-cwd/s1'])
    await applyDshHomeImport(planned, { include: {} })
  })

  it('completes an import on a file system that does not sync a directory, and stops on any other sync failure', async () => {
    mark(homes)
    fault.directorySync = 'EINVAL'
    await applyDshHomeImport(await plan(homes), { include: {} })
    homes.remove()
    homes = makeHomes()
    mark(homes)
    fault.directorySync = 'EIO'
    await expect(applyDshHomeImport(await plan(homes), { include: {} })).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED', message: expect.stringContaining('(EIO)') as string })
  })
})
