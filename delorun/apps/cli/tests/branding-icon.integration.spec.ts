/**
 * The Branding icon upload against a real studio: the host checks the bytes of a posted image, stores the one icon
 * file and answers its hash, and refuses an SVG, a type the bytes do not match and an oversize body.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Relative: this app does not depend on the brand package, and a test must not add a dependency.
import { ICON_MAX_BYTES, ICON_TYPE_HEADER, STUDIO_ICON_UPLOAD_PATH } from '../../../packages/brand/src/branding.ts'
import { bootStudio, type Studio } from './denial/admission/studio.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')

let studio: Studio
let origin: string
let cookie: string

beforeAll(async () => {
  studio = await bootStudio([], { local: true })
  origin = `http://127.0.0.1:${String(studio.ctx.webServer.port)}`
  const minted = await fetch(studio.ctx.connection.authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  cookie = minted.headers.getSetCookie()[0]?.split(';')[0] ?? ''
  if (!cookie.startsWith('dsh-auth-')) throw new Error(`the launch-token exchange set no browser cookie (${String(minted.status)})`)
}, 120_000)

afterAll(async () => { await studio.close() })

/**
 * Post an image to the upload route as the loopback studio.
 * @param body - the bytes.
 * @param type - the claimed image type.
 * @returns the response.
 */
function upload(body: Uint8Array, type: string): Promise<Response> {
  return fetch(`${origin}${STUDIO_ICON_UPLOAD_PATH}`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/octet-stream', [ICON_TYPE_HEADER]: type },
    body: body as BodyInit,
  })
}

describe('the icon upload route', () => {
  it('stores a PNG, answers its hash and refuses an SVG, a mismatched type and an oversize body', async () => {
    const stored = await upload(PNG, 'image/png')
    expect(stored.status).toBe(200)
    const { hash } = await stored.json() as { hash: string }
    expect(hash).toBe(createHash('sha256').update(PNG).digest('hex'))
    // Pins the refusals: without the byte check each of these is stored.
    expect((await upload(SVG, 'image/svg+xml')).status).toBe(415)
    expect((await upload(SVG, 'image/png')).status).toBe(415)
    expect((await upload(PNG, 'image/jpeg')).status).toBe(415)
    expect((await upload(new Uint8Array(ICON_MAX_BYTES + 1).fill(7), 'image/png')).status).toBe(413)
    // The refused uploads left the stored icon alone.
    const served = await fetch(`${origin}/delorun/branding/icon`, { headers: { cookie } })
    expect(served.status).toBe(404)
  })
})
