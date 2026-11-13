/**
 * The publish-time mark endpoint: a request signed with the shared secret moves the high-water mark to the timestamp
 * just uploaded, never lowers it, and leaves the next cron run to refuse a restored older timestamp.
 */
import { describe, expect, it } from 'vitest'
import { handleMarkRequest, MARK_BODY_LIMIT, MARK_SIGNATURE_HEADER, markSignature } from '../src/mark-endpoint.ts'
import { raiseMark, type HighWaterMark } from '../src/mark.ts'
import { postMark } from '../src/publish-release.ts'
import { resignTimestamp } from '../src/resign-core.ts'
import { FIRST, MemoryMark, signedChannel, storeWith } from './support.ts'

const SECRET = 'a-mark-secret'
const URL = 'https://resign.example.workers.dev/mark'
const now = (): number => FIRST + 60

/**
 * A signed request.
 * @param body - the request body.
 * @param secret - the secret that signs it.
 * @returns the request.
 */
function request(body: Uint8Array, secret = SECRET): Request {
  return new Request(URL, { method: 'POST', body: new Uint8Array(body), headers: { [MARK_SIGNATURE_HEADER]: markSignature(secret, body) } })
}

describe('the mark endpoint', () => {
  it('moves the mark to the uploaded timestamp when the body is signed with the secret', async () => {
    const channel = signedChannel({ version: 5 })
    const store = storeWith(channel)
    const mark = new MemoryMark()
    const response = await handleMarkRequest(request(store.objects.get('timestamp.json')!.bytes), { secret: SECRET, bucket: store, mark, now })
    expect(response.status).toBe(200)
    expect(await mark.read()).toMatchObject({ version: 5 })
  })

  it('refuses a wrong or missing signature and leaves the mark alone', async () => {
    const store = storeWith(signedChannel({ version: 5 }))
    const mark = new MemoryMark()
    const bytes = store.objects.get('timestamp.json')!.bytes
    const wrong = await handleMarkRequest(request(bytes, 'another-secret'), { secret: SECRET, bucket: store, mark, now })
    const missing = await handleMarkRequest(new Request(URL, { method: 'POST', body: new Uint8Array(bytes) }), { secret: SECRET, bucket: store, mark, now })
    // Pins the HMAC check: a body signed under another secret, or unsigned, moves nothing.
    expect([wrong.status, missing.status]).toEqual([401, 401])
    expect(await mark.read()).toBeUndefined()
  })

  it('refuses a lower version than the mark, and a timestamp the bucket does not hold', async () => {
    const mark = new MemoryMark()
    await mark.write({ version: 9, channels: { stable: '0.1.0', beta: '0.1.0' } })
    const store = storeWith(signedChannel({ version: 5 }))
    const bytes = store.objects.get('timestamp.json')!.bytes
    const lower = await handleMarkRequest(request(bytes), { secret: SECRET, bucket: store, mark, now })
    expect(lower.status).toBe(409)
    expect((await mark.read())?.version).toBe(9)
    const other = storeWith(signedChannel({ version: 12 }))
    const absent = await handleMarkRequest(request(bytes), { secret: SECRET, bucket: other, mark: new MemoryMark(), now })
    expect(absent.status).toBe(409)
  })

  it('changes nothing when the same request is sent again', async () => {
    const store = storeWith(signedChannel({ version: 5 }))
    const mark = new MemoryMark()
    const bytes = store.objects.get('timestamp.json')!.bytes
    await handleMarkRequest(request(bytes), { secret: SECRET, bucket: store, mark, now })
    const first = await mark.read()
    const again = await handleMarkRequest(request(bytes), { secret: SECRET, bucket: store, mark, now })
    expect(again.status).toBe(200)
    expect(await mark.read()).toEqual(first)
  })

  it('answers only a POST to /mark, and a body that is no timestamp with 400', async () => {
    const store = storeWith(signedChannel({ version: 5 }))
    const deps = { secret: SECRET, bucket: store, mark: new MemoryMark(), now }
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
    await postMark({ url: URL, secret: SECRET, fetch: async (_url, init) => await handleMarkRequest(new Request(URL, init), { secret: SECRET, bucket: store, mark, now }) })(store.objects.get('timestamp.json')!.bytes)
    // A rolled-back bucket holds the older timestamp again; the cron run refuses it.
    const rolledBack = storeWith(older)
    await expect(resignTimestamp({ store: rolledBack, mark, key: older.keys.timestamp, now: FIRST + 3600 })).rejects.toThrow(/high-water mark/u)
  })

  it('refuses a validly HMAC-signed body whose timestamp is unsigned or signed by another key, and leaves the mark alone', async () => {
    const unsigned = signedChannel({ version: 9_000_000 })
    const stripped = Buffer.from(JSON.stringify({ signed: JSON.parse(unsigned.timestamp.bytes.toString()).signed, signatures: [] }))
    const genuine = signedChannel({ version: 1, keys: unsigned.keys })
    const forged = signedChannel({ version: 9_000_001, keys: unsigned.keys, signer: signedChannel().keys.timestamp })
    for (const bytes of [stripped, forged.timestamp.bytes]) {
      const store = storeWith(genuine)
      store.force('timestamp.json', bytes)
      const mark = new MemoryMark()
      const response = await handleMarkRequest(request(bytes), { secret: SECRET, bucket: store, mark, now })
      // Pins the signature check: the HMAC and the bucket's bytes match, but no root key signed this version.
      expect(response.status).toBe(409)
      expect(mark.value).toBeUndefined()
    }
  })

  it('refuses a body over the limit by its declared length and by its streamed bytes, before it reads them', async () => {
    const store = storeWith(signedChannel({ version: 5 }))
    const mark = new MemoryMark()
    const big = Buffer.alloc(MARK_BODY_LIMIT + 1, 1)
    const declared = new Request(URL, { method: 'POST', body: new Uint8Array(big), headers: { [MARK_SIGNATURE_HEADER]: markSignature(SECRET, big), 'content-length': String(big.length) } })
    expect((await handleMarkRequest(declared, { secret: SECRET, bucket: store, mark, now })).status).toBe(413)
    const streamed = new Request(URL, { method: 'POST', body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(big)); controller.close() } }), duplex: 'half', headers: { [MARK_SIGNATURE_HEADER]: markSignature(SECRET, big) } } as RequestInit)
    expect((await handleMarkRequest(streamed, { secret: SECRET, bucket: store, mark, now })).status).toBe(413)
    expect(mark.value).toBeUndefined()
  })

  it('writes the higher mark again when a concurrent writer replaced it with a lower one, and never lowers a higher one', async () => {
    const low: HighWaterMark = { version: 4, channels: { stable: '0.1.0', beta: '0.1.0' } }
    const high: HighWaterMark = { ...low, version: 5 }
    class Racing extends MemoryMark {
      raced = false
      override async write(mark: HighWaterMark): Promise<void> {
        await super.write(mark)
        // The cron run, which read the old mark, writes its lower value right after the first write.
        if (!this.raced) { this.raced = true; this.value = low }
      }
    }
    const racing = new Racing()
    await raiseMark(racing, high)
    // Pins the re-read: without it the lower value the cron wrote last stands.
    expect(racing.value).toEqual(high)
    const kept = new MemoryMark()
    kept.value = { ...high, version: 9 }
    await raiseMark(kept, high)
    expect(kept.value.version).toBe(9)
  })

  it('fails the publish when the Worker refuses the request', async () => {
    const send = postMark({ url: URL, secret: SECRET, fetch: async () => new Response('Unauthorized\n', { status: 401 }) })
    await expect(send(Buffer.from('x'))).rejects.toThrow(/refused to move the high-water mark \(401\)/u)
  })
})
