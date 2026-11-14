/**
 * The rehearsal's studio port: a loopback port at 1024 or above (the setup answers refuse lower ones) that can be bound
 * right away, and a second call does not hand back a port that is held.
 */
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { freeLoopbackPort } from './servers.ts'

describe('freeLoopbackPort', () => {
  it('returns a port setup accepts that can be bound on the loopback address', async () => {
    const port = await freeLoopbackPort()
    expect(port).toBeGreaterThanOrEqual(1024)
    const server = createServer()
    await new Promise<void>((done, fail) => { server.once('error', fail).listen(port, '127.0.0.1', done) })
    const held = await freeLoopbackPort()
    expect(held).not.toBe(port)
    await new Promise<void>(done => server.close(() => { done() }))
  })
})
