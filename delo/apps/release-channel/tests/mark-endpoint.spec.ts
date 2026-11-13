/**
 * The publish-time mark endpoint: a request signed with the shared secret moves the high-water mark to the timestamp
 * just uploaded, never lowers it, and leaves the next cron run to refuse a restored older timestamp.
 */
import { describe, expect, it } from 'vitest'
import { handleMarkRequest, MARK_SIGNATURE_HEADER, markSignature } from '../src/mark-endpoint.ts'
import { postMark } from '../src/publish-release.ts'
import { resignTimestamp } from '../src/resign-core.ts'
import { FIRST, MemoryMark, signedChannel, storeWith } from './support.ts'

const SECRET = 'a-mark-secret'
const URL = 'https://resign.example.workers.dev/mark'

/**
 * A signed request.
 * @param body - the request body.
 * @param secret - the secret that signs it.
 * @returns the request.
 */
function request(body: Uint8Array, secret = SECRET): Request {
  return new Request(URL, { method: 'POST', body, headers: { [MARK_SIGNATURE_HEADER]: markSignature(secret, body) } })
}

describe('the mark endpoint', () => {
  it('moves the mark to the uploaded timestamp when the body is signed with the secret', async () => {
    const channel = signedChannel({ version: 5 })
    const store = storeWith(channel)
    const mark = new MemoryMark()
    const response = await handleMarkRequest(request(store.objects.get('timestamp.json')!.bytes), { secret: SECRET, bucket: store, mark })
    expect(response.status).toBe(200)
    expect(await mark.read()).toMatchObject({ version: 5 })
  })

  it('refuses a wrong or missing signature and leaves the mark alone', async () => {
    const store = storeWith(signedChannel({ version: 5 }))
    const mark = new MemoryMark()
    const bytes = store.objects.get('timestamp.json')!.bytes
    const wrong = await handleMarkRequest(request(bytes, 'another-secret'), { secret: SECRET, bucket: store, mark })
    const missing = await handleMarkRequest(new Request(URL, { method: 'POST', body: bytes }), { secret: SECRET, bucket: store, mark })
    // Pins the HMAC check: a body signed under another secret, or unsigned, moves nothing.
    expect([wrong.status, missing.status]).toEqual([401, 401])
    expect(await mark.read()).toBeUndefined()
  })

  it('refuses a lower version than the mark, and a timestamp the bucket does not hold', async () => {
    const mark = new MemoryMark()
    await mark.write({ version: 9, channels: { stable: '0.1.0', beta: '0.1.0' } })
    const store = storeWith(signedChannel({ version: 5 }))
    const bytes = store.objects.get('timestamp.json')!.bytes
    const lower = await handleMarkRequest(request(bytes), { secret: SECRET, bucket: store, mark })
    expect(lower.status).toBe(409)
    expect((await mark.read())?.version).toBe(9)
    const other = storeWith(signedChannel({ version: 12 }))
    const absent = await handleMarkRequest(request(bytes), { secret: SECRET, bucket: other, mark: new MemoryMark() })
    expect(absent.status).toBe(409)
  })

  it('changes nothing when the same request is sent again', async () => {
    const store = storeWith(signedChannel({ version: 5 }))
    const mark = new MemoryMark()
    const bytes = store.objects.get('timestamp.json')!.bytes
    await handleMarkRequest(request(bytes), { secret: SECRET, bucket: store, mark })
    const first = await mark.read()
    const again = await handleMarkRequest(request(bytes), { secret: SECRET, bucket: store, mark })
    expect(again.status).toBe(200)
    expect(await mark.read()).toEqual(first)
  })

  it('answers only a POST to /mark, and a body that is no timestamp with 400', async () => {
    const store = storeWith(signedChannel({ version: 5 }))
    const deps = { secret: SECRET, bucket: store, mark: new MemoryMark() }
    expect((await handleMarkRequest(new Request('https://x.example/other', { method: 'POST' }), deps)).status).toBe(404)
    expect((await handleMarkRequest(new Request(URL, { method: 'GET' }), deps)).status).toBe(405)
    expect((await handleMarkRequest(request(Buffer.from('not json')), deps)).status).toBe(400)
  })

  it('makes the next cron run refuse a restored older timestamp after a publish moved the mark', async () => {
    const older = signedChannel({ version: 4 })
    const newer = signedChannel({ version: 5, keys: older.keys })
    const mark = new MemoryMark()
    const store = storeWith(newer)
    // The publisher uploaded version 5 and told the Worker.
    await postMark({ url: URL, secret: SECRET, fetch: async (_url, init) => await handleMarkRequest(new Request(URL, init), { secret: SECRET, bucket: store, mark }) })(store.objects.get('timestamp.json')!.bytes)
    // A rolled-back bucket holds the older timestamp again; the cron run refuses it.
    const rolledBack = storeWith(older)
    await expect(resignTimestamp({ store: rolledBack, mark, key: older.keys.timestamp, now: FIRST + 3600 })).rejects.toThrow(/high-water mark/u)
  })

  it('fails the publish when the Worker refuses the request', async () => {
    const send = postMark({ url: URL, secret: SECRET, fetch: async () => new Response('Unauthorized\n', { status: 401 }) })
    await expect(send(Buffer.from('x'))).rejects.toThrow(/refused to move the high-water mark \(401\)/u)
  })
})
