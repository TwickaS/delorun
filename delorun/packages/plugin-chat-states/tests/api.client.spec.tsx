// @vitest-environment jsdom
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatStatesApi, ChatStatesRequestError } from '../src/client/api.ts'
import { CHAT_STATE_PATHS } from '../src/wire.ts'

afterEach(() => { vi.unstubAllGlobals() })

function answer(body: unknown, status = 200) {
  const fetch = vi.fn(async (..._: Parameters<typeof globalThis.fetch>) => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('the studio\'s calls to the harness', () => {
  it('lists the states from the document-relative route, with the signal when there is one', async () => {
    const fetch = answer({ chats: { a: { settledAt: 1 } } })
    expect(await chatStatesApi.list()).toEqual({ chats: { a: { settledAt: 1 } } })
    const signal = new AbortController().signal
    await chatStatesApi.list(signal)
    expect(fetch.mock.calls.map(([path, init]) => [path, init?.signal ?? null])).toEqual([[CHAT_STATE_PATHS.list.slice(1), null], [CHAT_STATE_PATHS.list.slice(1), signal]])
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ accept: 'application/json' })
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined()
  })

  it('posts a change as JSON and returns the states after it', async () => {
    const fetch = answer({ chats: { a: { settledAt: 1 } } })
    const request = { action: 'settle', session: SessionId('a') } as const
    expect(await chatStatesApi.set(request)).toEqual({ chats: { a: { settledAt: 1 } } })
    const [path, init] = fetch.mock.calls[0] ?? []
    expect([path, init?.method, init?.body, init?.headers]).toEqual([
      CHAT_STATE_PATHS.set.slice(1), 'POST', JSON.stringify(request), { accept: 'application/json', 'content-type': 'application/json' },
    ])
  })

  it('rejects with the route and status when the harness refuses', async () => {
    answer({ code: 'failed', message: 'x' }, 500)
    const failure = await chatStatesApi.list().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ChatStatesRequestError)
    expect(failure).toMatchObject({ path: CHAT_STATE_PATHS.list, status: 500 })
  })

  it.each([
    ['a chat id with a space', { chats: { 'a b': { settledAt: 1 } } }],
    ['a time that is not a number', { chats: { a: { settledAt: 'later' } } }],
    ['a field the plugin does not send', { chats: {}, extra: true }],
    ['no chats', {}],
  ])('rejects an answer that holds %s', async (_, body) => {
    answer(body)
    await expect(chatStatesApi.list()).rejects.toThrow()
  })
})
