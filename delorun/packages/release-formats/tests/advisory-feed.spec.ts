/**
 * The advisory feed's request and answer, keyed by package name: a name that is also an `Object.prototype` member is an
 * ordinary package.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryFeed } from '@delorun/release-formats/advisory/feed'

afterEach(() => { vi.unstubAllGlobals() })

/** Stub the global fetch to answer `answer` and record the request body it was sent. */
function feedAnswering(answer: unknown): { readonly sent: () => unknown } {
  let sent: unknown
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string)
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }))
  })
  return { sent: () => sent }
}

describe('queryFeed', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])('sends a package named %s with its versions and finds no answer for it', async (name) => {
    const feed = feedAnswering({})
    const answer = await queryFeed('https://feed.example/advisories', [{ name, version: '1.0.0' }, { name, version: '2.0.0' }, { name: 'left-pad', version: '1.3.0' }], { timeoutMs: 1000 })
    expect(feed.sent()).toEqual({ [name]: ['1.0.0', '2.0.0'], 'left-pad': ['1.3.0'] })
    expect(answer[name]).toBeUndefined()
    expect(answer[name] ?? []).toEqual([])
  })

  it('returns the advisories the feed names for a package called constructor', async () => {
    const advisory = { url: 'https://github.com/advisories/GHSA-2222-3333-4444', title: 't', severity: 'high', vulnerable_versions: '<2.0.0' }
    feedAnswering({ constructor: [advisory] })
    const answer = await queryFeed('https://feed.example/advisories', [{ name: 'constructor', version: '1.0.0' }], { timeoutMs: 1000 })
    expect(answer['constructor']).toEqual([advisory])
  })
})
