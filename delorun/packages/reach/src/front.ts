/**
 * The fixed listener port of a reach option (contract C7, "Tailscale serve target").
 *
 * Upstream's reach listener binds a port the operating system assigns, which changes at every start. The serve target
 * that `tailscale serve --bg` persists in `tailscaled` must name a port this home holds whenever the rule exists, so the
 * service binds `127.0.0.1:<listenerPort>`, a port `delorun reach on tailscale` chose once and recorded, before it
 * writes the rule, and relays each connection on it, byte for byte, to the reach listener's assigned port. A port
 * another program holds fails the bind, and the rule is not written.
 *
 * @module @delorun/reach/front
 */
import { randomInt } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { REACH_LISTENER_BIND_HOST } from '@delorun/contract-admission'
import { ReachError } from './tailscale.ts'

/** The bound fixed port, relaying to the reach listener once {@link LoopbackFront.connect} names it. */
export interface LoopbackFront {
  /** The fixed port on `127.0.0.1`. */
  readonly port: number
  /**
   * Relay every later connection to the reach listener; a connection accepted before this is closed unanswered.
   * @param target - the reach listener's port on `127.0.0.1`.
   */
  connect(target: number): void
  /**
   * Stop accepting and destroy every relayed connection.
   * @returns once the port is released.
   */
  close(): Promise<void>
}

/**
 * Bind the fixed listener port.
 * @param port - the port on `127.0.0.1`.
 * @returns the bound front.
 * @throws {ReachError} `PORT_CONFLICT` when the port cannot be bound, which another program holding it causes.
 */
export async function openFront(port: number): Promise<LoopbackFront> {
  const sockets = new Set<Socket>()
  let target: number | undefined
  const server = createServer((socket) => {
    if (target === undefined) {
      socket.destroy()
      return
    }
    const upstream = connect(target, REACH_LISTENER_BIND_HOST)
    sockets.add(socket)
    sockets.add(upstream)
    const end = (): void => {
      socket.destroy()
      upstream.destroy()
      sockets.delete(socket)
      sockets.delete(upstream)
    }
    socket.on('error', end).on('close', end)
    upstream.on('error', end).on('close', end)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  try {
    await listen(server, port)
  } catch (error) {
    throw new ReachError('PORT_CONFLICT', `Another program on this computer holds 127.0.0.1:${String(port)}, the port Tailscale forwards this home's address to (${String(error)}). Close that program, or stop Delorun and run delorun reach on tailscale again to choose another port`)
  }
  return {
    port,
    connect: (value) => { target = value },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/**
 * Whether a port on `127.0.0.1` is free: it binds and is released at once.
 * @param port - the port.
 * @returns whether it bound.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const server = createServer()
  try {
    await listen(server, port)
  } catch {
    // A port that does not bind is held by another program or refused to this user, which is the answer.
    return false
  }
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return true
}

/**
 * Choose a free port at random from a range.
 * @param range - the inclusive range.
 * @param range.min - the lowest port.
 * @param range.max - the highest port.
 * @param attempts - how many random ports to try.
 * @returns the port.
 * @throws Error when no port tried was free.
 */
export async function chooseListenerPort(range: { readonly min: number; readonly max: number }, attempts = 32): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = randomInt(range.min, range.max + 1)
    if (await isPortFree(port)) return port
  }
  throw new Error(`reach: no free port on 127.0.0.1 between ${String(range.min)} and ${String(range.max)} after ${String(attempts)} tries`)
}

/**
 * Bind a server to a port on `127.0.0.1`, exclusively.
 * @param server - the server.
 * @param port - the port.
 * @returns once it listens.
 */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: REACH_LISTENER_BIND_HOST, port, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })
}
