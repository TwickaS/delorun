/**
 * The Engine API client against a local stand-in engine on a Unix socket: a call that the engine never answers ends
 * at its deadline, a pull's progress stream is read line by line however long it is, and an error line in it fails
 * the pull.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { engineAt, EngineError } from '../src/index.ts'
import { tempHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
let server: Server | undefined
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => { if (server === undefined) resolve(); else server.close(() => { resolve() }) })
  server = undefined
  temp?.remove()
  temp = undefined
})

async function standIn(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  temp = await tempHome()
  const path = join(temp.outside, 'engine.sock')
  server = createServer(handler)
  await new Promise<void>((resolve) => { server?.listen(path, resolve) })
  return path
}

describe('the Engine API client', () => {
  it('ends a call the engine never answers at its deadline, as an engine that does not answer', { timeout: 10_000 }, async () => {
    const path = await standIn(() => { /* never answers */ })
    const started = Date.now()
    const error = await engineAt(path, { callMs: 300, pullMs: 1_000 }).call('GET', '/info').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EngineError)
    expect(error).toMatchObject({ status: 0, message: expect.stringContaining('within 300 ms') })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('reads a pull\'s progress stream line by line, however long it is', { timeout: 30_000 }, async () => {
    const line = `${JSON.stringify({ status: 'Downloading', progress: 'x'.repeat(1_000) })}\n`
    const path = await standIn((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      // About 12 MiB, past the 8 MiB a JSON call's body may hold.
      for (let index = 0; index < 12_000; index += 1) response.write(line)
      response.end(`${JSON.stringify({ status: 'Digest: sha256:x' })}\n`)
    })
    await expect(engineAt(path, { callMs: 1_000, pullMs: 20_000 }).pull('ghcr.io/twickas/delorun-workspace-s2', `sha256:${'a'.repeat(64)}`)).resolves.toBeUndefined()
  })

  it('fails a pull whose progress stream reports an error', async () => {
    const path = await standIn((_request, response) => {
      response.writeHead(200)
      response.end(`${JSON.stringify({ status: 'Pulling' })}\n${JSON.stringify({ error: 'manifest unknown', errorDetail: { message: 'manifest unknown' } })}\n`)
    })
    await expect(engineAt(path, { callMs: 1_000, pullMs: 5_000 }).pull('ghcr.io/twickas/delorun-workspace-s2', `sha256:${'a'.repeat(64)}`)).rejects.toThrow(/manifest unknown/)
  })
})
