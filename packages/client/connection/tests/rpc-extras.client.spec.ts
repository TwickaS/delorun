/** The extra request headers a client plugin registers reach every generic RPC request, and the request's own win. */

import { describe, expect, it, vi } from 'vitest'
import { createWebConnectionRpc, type RpcFetch } from '../src/client/rpc.ts'

describe('Connection RPC request extras', () => {
  it('sends the registered headers on each request, read per request, without overriding the content type', async () => {
    let token = 'one'
    const send = vi.fn<RpcFetch>().mockResolvedValue(new Response('{}', { status: 500 }))
    const rpc = createWebConnectionRpc(send, undefined, () => ({ 'delorun-unlock': token, 'content-type': 'text/plain' }))
    await rpc.call('/api', 'session.list', {}).catch(() => undefined)
    token = 'two'
    await rpc.call('/api', 'session.list', {}).catch(() => undefined)
    const headers = send.mock.calls.map(call => call[1]?.headers)
    // Pins the per-request read: a changed credential applies to the next request.
    expect(headers).toEqual([
      { 'delorun-unlock': 'one', 'content-type': 'application/json' },
      { 'delorun-unlock': 'two', 'content-type': 'application/json' },
    ])
  })
})
