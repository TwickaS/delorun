/**
 * The specs of two first uses of the home key at once: the key another process
 * linked first is kept and this process's key is dropped, and a link that
 * fails for another reason is reported, leaving no temporary file behind.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** What the mocked `link` does on its next call. */
const linkPlan: { next: ((path: string) => Error) | undefined } = { next: undefined }

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    link: async (existing: string, path: string): Promise<void> => {
      const plan = linkPlan.next
      linkPlan.next = undefined
      if (plan !== undefined) throw plan(path)
      await original.link(existing, path)
    },
  }
})

const { homeKeyPath, loadHomeKey, encodePublicKey } = await import('../src/index.ts')

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-home-key-race-'))
})

afterEach(() => {
  linkPlan.next = undefined
  rmSync(home, { recursive: true, force: true })
})

describe('two first uses of the home key at once', () => {
  it('keeps the key the other process linked first', async () => {
    const theirs = generateKeyPairSync('ed25519')
    linkPlan.next = path => {
      writeFileSync(path, theirs.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
      return Object.assign(new Error('file exists'), { code: 'EEXIST' })
    }

    const key = await loadHomeKey(home, { create: true })

    expect(key!.publicKey).toBe(encodePublicKey(theirs.publicKey))
    expect(readdirSync(dirname(homeKeyPath(home)))).toEqual(['home-key.pem'])
  })

  it('reports a link that fails for another reason and leaves no temporary file', async () => {
    linkPlan.next = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' })

    await expect(loadHomeKey(home, { create: true })).rejects.toThrow('operation not permitted')
    expect(readdirSync(dirname(homeKeyPath(home)))).toEqual([])
  })
})
