/**
 * The fixed listener port over real loopback sockets: it relays bytes to the reach listener once connected, closes a
 * connection that arrives before, refuses a port another program holds, and releases the port when closed. The port
 * chooser picks a free port from a range.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { connect, createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { LISTENER_PORT_RANGE } from '@delorun/contract-reach-providers'
import { chooseListenerPort, isPortFree, openFront } from '../src/front.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
})

/**
 * Listen on a port the operating system assigns, answering each connection with `echo:` and what it received.
 * @returns the port.
 */
async function echo(): Promise<number> {
  const server = createServer((socket) => { socket.on('data', (data) => { socket.write(`echo:${data.toString()}`) }) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

/**
 * Send one message to a port and read the first reply, or the close.
 * @param port - the port on `127.0.0.1`.
 * @param message - the text.
 * @returns the reply, or `closed` for a close or a reset.
 */
function exchange(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write(message) })
    socket.once('data', (data) => { resolve(data.toString()); socket.destroy() })
    socket.once('close', () => { resolve('closed') })
    // A connection the relay destroys may reach the client as a reset rather than a close.
    socket.once('error', (error: NodeJS.ErrnoException) => { if (error.code === 'ECONNRESET') resolve('closed'); else reject(error) })
  })
}

describe('the fixed listener port', () => {
  it('relays to the reach listener once connected, and closes a connection that arrives before', async () => {
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    expect(port).toBeGreaterThanOrEqual(LISTENER_PORT_RANGE.min)
    expect(port).toBeLessThanOrEqual(LISTENER_PORT_RANGE.max)
    const front = await openFront(port)
    try {
      expect(front.port).toBe(port)
      // Pins the unconnected refusal: nothing is relayed before the reach listener exists.
      await expect(exchange(port, 'early')).resolves.toBe('closed')
      front.connect(await echo())
      await expect(exchange(port, 'hello')).resolves.toBe('echo:hello')
    } finally {
      await front.close()
    }
    // Pins the release: the port is free once the front closes.
    await expect(isPortFree(port)).resolves.toBe(true)
  })

  it('refuses a port another program holds', async () => {
    const held = await echo()
    // Pins the bind before the rule: a port another program holds is never relayed to.
    await expect(openFront(held)).rejects.toMatchObject({ code: 'PORT_CONFLICT', detail: expect.stringContaining(`127.0.0.1:${String(held)}`) })
    await expect(isPortFree(held)).resolves.toBe(false)
    await expect(chooseListenerPort({ min: held, max: held }, 2)).rejects.toThrow(/no free port/)
  })

  it('ends both sides of a relayed connection when either ends, and every one at close', async () => {
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    const front = await openFront(port)
    // A reach listener that is gone: the relay closes the client's connection.
    const gone = await echo()
    await new Promise<void>((resolve) => { servers.pop()?.close(() => { resolve() }) })
    front.connect(gone)
    await expect(exchange(port, 'x')).resolves.toBe('closed')
    // A connection open at close is ended.
    front.connect(await echo())
    const socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => { socket.once('connect', () => { resolve() }) })
    socket.write('ping')
    await new Promise<void>((resolve) => { socket.once('data', () => { resolve() }) })
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    await front.close()
    await closed
  })
})
