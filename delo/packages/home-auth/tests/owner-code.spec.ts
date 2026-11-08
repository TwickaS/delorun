/**
 * The owner code (C5's "Owner claim" and its limits): its base32 form, its normalisation, its digest at rest, its
 * single use and its 10-minute expiry.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OWNER_CODE_CHARS, base32Encode, hashSecret, newOwnerCode, normaliseOwnerCode, secretMatches } from '../src/secret.ts'
import { OwnerCodeStore } from '../src/owner-code.ts'
import { homeFixture } from './fixtures/home.ts'

const MINUTE = 60 * 1000

describe('the owner code', () => {
  it('writes bytes as unpadded RFC 4648 base32, 26 characters for 128 bits', () => {
    // RFC 4648's own test vector, which pins the bit order.
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    expect(base32Encode(new Uint8Array(16))).toBe('A'.repeat(26))
    expect(base32Encode(new Uint8Array(16).fill(0xff))).toBe(`${'7'.repeat(25)}4`)
    const code = newOwnerCode()
    expect(code).toHaveLength(OWNER_CODE_CHARS)
    expect(code).toMatch(/^[A-Z2-7]{26}$/)
  })

  it('reads a typed code in either case, with spaces and hyphens ignored', () => {
    const code = newOwnerCode(size => new Uint8Array(size).fill(3))
    expect(normaliseOwnerCode(code.toLowerCase())).toBe(code)
    expect(normaliseOwnerCode(` ${code.slice(0, 5)}-${code.slice(5, 10)} ${code.slice(10)} `)).toBe(code)
    expect(normaliseOwnerCode('')).toBeUndefined()
    expect(normaliseOwnerCode(code.slice(0, 25))).toBeUndefined()
    expect(normaliseOwnerCode(`${code}0`)).toBeUndefined()
    // `0` and `1` are outside the alphabet, so a code typed with them is not an owner code at all.
    expect(normaliseOwnerCode(`${code.slice(0, 25)}0`)).toBeUndefined()
    expect(normaliseOwnerCode(`${code.slice(0, 25)}1`)).toBeUndefined()
  })

  it('compares a presented secret with a digest, and only with that digest', () => {
    const digest = hashSecret('DELO-RK1-EXAMPLE')
    expect(secretMatches('DELO-RK1-EXAMPLE', digest)).toBe(true)
    expect(secretMatches('DELO-RK1-EXAMPLF', digest)).toBe(false)
    expect(secretMatches('DELO-RK1-EXAMPLE', hashSecret('other'))).toBe(false)
    expect(secretMatches('DELO-RK1-EXAMPLE', 'not a digest')).toBe(false)
  })
})

describe('the owner code store', () => {
  it('keeps the code\'s digest at mode 0600 and never the code', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      const file = join(home.directory, 'owner-code.json')
      const text = await readFile(file, 'utf8')
      // Pins "stored hashed": a store that wrote the code itself fails here.
      expect(text).not.toContain(issued.code)
      const record = JSON.parse(text) as { v: number; hash: string; expiresAt: number }
      expect(record.v).toBe(1)
      expect(record.hash).toBe(hashSecret(issued.code))
      expect(record.expiresAt).toBe(issued.expiresAt)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      await home.dispose()
    }
  })

  it('accepts a code once and refuses the same code afterwards', async () => {
    const home = await homeFixture()
    try {
      const store = new OwnerCodeStore({ file: join(home.directory, 'code.json'), now: home.clock.read, random: home.random })
      const issued = await store.issue()
      await expect(store.consume(issued.code)).resolves.toBe(true)
      // Pins "single use": without the removal on a match, the consumed code matches a second time.
      await expect(store.consume(issued.code)).resolves.toBe(false)
      await expect(store.outstanding()).resolves.toBe(false)
    } finally {
      await home.dispose()
    }
  })

  it('refuses a code 10 minutes after it was printed, and removes it', async () => {
    const home = await homeFixture()
    try {
      const store = new OwnerCodeStore({ file: join(home.directory, 'code.json'), now: home.clock.read, random: home.random })
      const issued = await store.issue()
      home.clock.advance(10 * MINUTE - 1)
      await expect(store.outstanding()).resolves.toBe(true)
      home.clock.advance(1)
      // Pins "expires": without the expiry comparison the code is outstanding and consumable at 10 minutes.
      await expect(store.outstanding()).resolves.toBe(false)
      await expect(store.consume(issued.code)).resolves.toBe(false)
      await expect(stat(join(home.directory, 'code.json'))).rejects.toThrow(/ENOENT/)
    } finally {
      await home.dispose()
    }
  })

  it('leaves the outstanding code in place when a wrong code is presented', async () => {
    const home = await homeFixture()
    try {
      const store = new OwnerCodeStore({ file: join(home.directory, 'code.json'), now: home.clock.read, random: home.random })
      const issued = await store.issue()
      // Pins "consume only on a match": consuming on any attempt makes the next two expectations fail.
      await expect(store.consume('A'.repeat(26))).resolves.toBe(false)
      await expect(store.outstanding()).resolves.toBe(true)
      await expect(store.consume(issued.code.toLowerCase())).resolves.toBe(true)
    } finally {
      await home.dispose()
    }
  })

  it('replaces the previous code when a new one is printed, and clears on request', async () => {
    const home = await homeFixture()
    try {
      const store = new OwnerCodeStore({ file: join(home.directory, 'code.json'), now: home.clock.read, random: home.random })
      const first = await store.issue()
      const second = await store.issue()
      const record = JSON.parse(await readFile(join(home.directory, 'code.json'), 'utf8')) as { hash: string }
      // Pins "a new code replaces the previous one": the file holds one record, and it is the new code's.
      expect(record.hash).toBe(hashSecret(second.code))
      expect(record.hash).not.toBe(hashSecret(first.code))
      await store.clear()
      await expect(store.outstanding()).resolves.toBe(false)
    } finally {
      await home.dispose()
    }
  })

  it('refuses a store file that is not a version 1 record', async () => {
    const home = await homeFixture()
    try {
      await writeFile(join(home.directory, 'owner-code.json'), JSON.stringify({ v: 2, hash: 'x' }), { mode: 0o600 })
      // Pins "a corrupt store refuses": reading it as "no code" would let a claim proceed as if nothing were printed.
      await expect(home.auth.ownerCodeOutstanding()).rejects.toMatchObject({ code: 'STORE_INVALID' })
    } finally {
      await home.dispose()
    }
  })

  it('refuses a store file that another user can read', async () => {
    const home = await homeFixture()
    try {
      const file = join(home.directory, 'owner-code.json')
      await writeFile(file, JSON.stringify({ v: 1, hash: 'x', issuedAt: 0, expiresAt: 1 }), { mode: 0o644 })
      // Pins C1's protected-file check: a laxer mode must refuse rather than read the digest as an ordinary file.
      await expect(home.auth.ownerCodeOutstanding()).rejects.toMatchObject({ code: 'STORE_INVALID' })
    } finally {
      await home.dispose()
    }
  })
})
