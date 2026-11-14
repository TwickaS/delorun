/**
 * The specs of the home key an export signs with: it is created once at 0600
 * inside a 0700 directory, read back unchanged, named by the fingerprint of
 * its public key, and refused when the file breaks C1's protected-file rules
 * or holds a key that is not Ed25519.
 */
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homeKeyPath, keyFingerprint, loadHomeKey } from '../src/index.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-home-key-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

describe('the home key', () => {
  it('is absent until a caller asks for it to be created', async () => {
    await expect(loadHomeKey(home)).resolves.toBeUndefined()
  })

  it('is created once at 0600 inside a 0700 directory and read back as the same key', async () => {
    const created = await loadHomeKey(home, { create: true })
    const again = await loadHomeKey(home, { create: true })

    expect(created).toBeDefined()
    expect(again!.publicKey).toBe(created!.publicKey)
    expect(created!.keyId).toBe(keyFingerprint(created!.publicKey))
    expect(statSync(homeKeyPath(home)).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(homeKeyPath(home))).mode & 0o777).toBe(0o700)
    expect(readFileSync(homeKeyPath(home), 'utf8')).toContain('BEGIN PRIVATE KEY')
    const signature = sign(null, Buffer.from('manifest'), created!.privateKey)
    expect(verify(null, Buffer.from('manifest'), createPublicKey(created!.privateKey), signature)).toBe(true)
  })

  it('refuses a key file other users can read', async () => {
    await loadHomeKey(home, { create: true })
    chmodSync(homeKeyPath(home), 0o644)

    await expect(loadHomeKey(home)).rejects.toThrow(/0600/)
  })

  it('refuses a key file that is a symbolic link', async () => {
    const elsewhere = join(home, 'elsewhere.pem')
    writeFileSync(elsewhere, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    mkdirSync(dirname(homeKeyPath(home)), { recursive: true, mode: 0o700 })
    symlinkSync(elsewhere, homeKeyPath(home))

    await expect(loadHomeKey(home, { create: true })).rejects.toThrow(/symbolic link/)
  })

  it('refuses a key that is not Ed25519', async () => {
    mkdirSync(dirname(homeKeyPath(home)), { recursive: true, mode: 0o700 })
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    writeFileSync(homeKeyPath(home), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })

    await expect(loadHomeKey(home)).rejects.toThrow('not an Ed25519 key')
  })

  it('refuses to create a key inside a directory other users can read', async () => {
    mkdirSync(dirname(homeKeyPath(home)), { recursive: true, mode: 0o755 })
    chmodSync(dirname(homeKeyPath(home)), 0o755)

    await expect(loadHomeKey(home, { create: true })).rejects.toThrow(/0700|chmod/)
  })
})
