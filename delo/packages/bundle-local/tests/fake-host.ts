/**
 * A fake home for the client specs of the Devices section and the unlock: each route answers its latest scripted
 * answer, and an unscripted route answers 404 as the Host's router does. Also a fixed unlock view for a section spec.
 */
import { vi } from 'vitest'
import type { HostFetch } from '../src/client/devices-api.ts'
import type { UnlockView } from '../src/client/unlock.ts'

/** One scripted Host answer: a JSON body, a raw text body, or a request that never completes. */
export type Answer = { status: number; body?: unknown; text?: string } | 'unreachable' | Promise<{ status: number; body: unknown }>

/** A route key: the method and the path. */
export type RouteKey = `${'GET' | 'POST'} ${string}`

/** One request the fake Host received. */
interface Received {
  readonly key: RouteKey
  readonly init: RequestInit | undefined
  readonly body: unknown
}

/**
 * A fake home answering each route with the latest scripted answer; an unscripted route answers 404 as the Host's
 * router does.
 * @param script - the answers by route.
 * @returns the fake `fetch`, the received requests and the script, which a test changes between steps.
 */
export function fakeHost(script: Partial<Record<RouteKey, Answer>> = {}) {
  const received: Received[] = []
  const fetch: HostFetch = async (input, init) => {
    const key: RouteKey = `${init?.method === 'POST' ? 'POST' : 'GET'} ${input}`
    received.push({ key, init, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const scripted = script[key] ?? { status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } }
    if (scripted === 'unreachable') throw new TypeError('Failed to fetch')
    const answer = await scripted
    return new Response('text' in answer && answer.text !== undefined ? answer.text : JSON.stringify(answer.body), { status: answer.status })
  }
  const count = (key: RouteKey): number => received.filter(request => request.key === key).length
  return { fetch, received, script, count }
}

/** The unlock view where no device unlocks, as at the home's own computer. */
export const AWAY: UnlockView = { place: 'away', state: { kind: 'none' }, dialog: null, ended: 0, lockFailed: false }

/**
 * The unlock props of the Devices section over one fixed view.
 * @param view - the view.
 * @returns the hook and spies for the open and lock actions.
 */
export function staticUnlock(view: UnlockView) {
  return {
    useUnlock: <T,>(select: (current: UnlockView) => T): T => select(view),
    openUnlock: vi.fn<() => void>(),
    lockUnlock: vi.fn<() => Promise<void>>(async () => {}),
  }
}
