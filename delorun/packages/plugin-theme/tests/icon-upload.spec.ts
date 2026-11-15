import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ICON_TYPE_HEADER } from '@delorun/brand/branding'
import { readIcon } from '@delorun/home-auth'
import { receiveIcon } from '../src/icon-upload.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
let directory: string
let target: string

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'theme-icon-')); target = join(directory, 'storages', 'delorun-theme', 'branding-icon') })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const post = (body: BodyInit, type: string): Request => new Request('http://studio.invalid/api/delorunBranding.icon', { method: 'POST', headers: { 'content-type': 'application/octet-stream', [ICON_TYPE_HEADER]: type }, body })

describe('the icon upload', () => {
  it('stores a PNG as one file and answers its hash, which reads back only for that hash', async () => {
    const answer = await receiveIcon(post(PNG, 'image/png'), target)
    expect(answer.status).toBe(200)
    const { hash } = await answer.json() as { hash: string }
    expect(readFileSync(target)).toEqual(Buffer.from(PNG))
    expect(readIcon(target, hash)).toEqual(Buffer.from(PNG))
    expect(readIcon(target, 'b'.repeat(64))).toBeUndefined()
  })

  it('refuses an SVG server-side and writes nothing', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    expect((await receiveIcon(post(svg, 'image/svg+xml'), target)).status).toBe(415)
    expect((await receiveIcon(post(svg, 'image/png'), target)).status).toBe(415)
    expect(existsSync(target)).toBe(false)
  })

  it('refuses an oversize image and bytes that do not match the declared type', async () => {
    const big = new Uint8Array(256 * 1024 + 1)
    big.set(PNG)
    expect((await receiveIcon(post(big, 'image/png'), target)).status).toBe(413)
    expect((await receiveIcon(post(PNG, 'image/jpeg'), target)).status).toBe(415)
    expect(existsSync(target)).toBe(false)
  })

  it('shows the default for a file replaced behind the row\'s hash', async () => {
    const { hash } = await (await receiveIcon(post(PNG, 'image/png'), target)).json() as { hash: string }
    const other = Uint8Array.from([...PNG, 9])
    await receiveIcon(post(other, 'image/png'), target)
    expect(readIcon(target, hash)).toBeUndefined()
  })

  it('refuses without a home path', async () => {
    expect((await receiveIcon(post(PNG, 'image/png'), undefined)).status).toBe(503)
  })
})
