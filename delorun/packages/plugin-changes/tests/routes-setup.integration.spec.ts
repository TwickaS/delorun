/**
 * The studio's setup routes: the person at their computer writes the profile's setup as a signed file, reads a file
 * and sees everything its import would change, and applies it once. A remote session, another site, a changed file, a
 * token used twice and a key in a settings row are each refused, and the import runs the same plugin operation as an
 * agent's plugin request, with the plugin's code left waiting for review.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readApproved } from '@delorun/changes'
import { SETUP_PATHS } from '../src/wire.ts'
import { approvedPlugin, CREDENTIAL, get, json, post, routeHome, send, serveRoutes } from './routes-fixture.ts'

vi.setConfig({ testTimeout: 60_000 })

/**
 * Write the source profile's setup through the route.
 * @returns the file as base64 and the answer.
 */
async function exportedFile(): Promise<{ file: string, answer: Record<string, unknown> }> {
  const { ctx } = await approvedPlugin()
  writeFileSync(join(ctx.profileDir, 'cordis.patch.yml'), '- id: llm-deepseek\n  config:\n    model: deepseek-v4\n- id: sandbox-policy\n  config:\n    mode: off\n')
  const server = await serveRoutes(ctx)
  const answer = json(await post(server.port, SETUP_PATHS.export))
  return { file: answer['file'] as string, answer }
}

describe('setup export', () => {
  it('writes the plugins and the carried settings as one signed file and names what it left out', async () => {
    const { answer } = await exportedFile()
    expect(answer).toMatchObject({ name: 'setup.delorun', plugins: 1, local: 1, settings: 1, leftOut: [expect.stringContaining('sandbox-policy')] })
    expect(typeof answer['signedBy']).toBe('string')
  })

  it('refuses a settings row that holds a key and names the setting, not the value', async () => {
    const { ctx } = await approvedPlugin()
    writeFileSync(join(ctx.profileDir, 'cordis.patch.yml'), '- id: llm-deepseek\n  config:\n    apiKey: not-a-real-secret-value\n')
    const server = await serveRoutes(ctx)
    const reply = await post(server.port, SETUP_PATHS.export)
    expect(reply.status).toBe(422)
    expect(json(reply)).toMatchObject({ code: 'SETUP_REFUSED' })
    expect(reply.body).not.toContain('not-a-real-secret-value')
  })
})

describe('setup import', () => {
  it('shows an unknown signer as unverified and everything that changes, then applies once with the code left for review', async () => {
    const { file } = await exportedFile()
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const inspected = json(await post(server.port, SETUP_PATHS.inspect, { file }))
    expect(inspected).toMatchObject({
      signer: { state: 'unverified', reason: 'key-not-trusted' },
      install: [{ name: 'plug', version: '1.0.0', kind: 'add', source: 'local' }],
      remove: [],
      settings: ['set: llm-deepseek'],
      changes: true,
    })
    expect(server.operations).toEqual([])
    const applied = await post(server.port, SETUP_PATHS.apply, { token: inspected['token'] })
    expect(applied.status).toBe(200)
    expect(json(applied)).toMatchObject({ removed: [], installed: [{ name: 'plug', reviewChange: expect.any(String) }], settingsWritten: true })
    expect(server.operations.map(args => args[0])).toEqual(['add'])
    expect((await readApproved(ctx.profileDir)).plugins['plug']).toBeUndefined()
    // The token was consumed: a second apply and a guessed token apply nothing.
    const again = await post(server.port, SETUP_PATHS.apply, { token: inspected['token'] })
    expect(again.status).toBe(410)
    expect(json(again)).toMatchObject({ code: 'SETUP_EXPIRED' })
    expect((await post(server.port, SETUP_PATHS.apply, { token: 'guess' })).status).toBe(410)
    expect(server.operations).toHaveLength(1)
  })

  it('refuses a file that was changed, an empty file and a field the route does not take', async () => {
    const { file } = await exportedFile()
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const bytes = Buffer.from(file, 'base64')
    bytes[Math.floor(bytes.length / 3)] = (bytes[Math.floor(bytes.length / 3)]! + 1) % 256
    const damaged = await post(server.port, SETUP_PATHS.inspect, { file: bytes.toString('base64') })
    expect(damaged.status).toBe(422)
    expect(String(json(damaged)['code'])).toMatch(/^ARCHIVE_/u)
    expect((await post(server.port, SETUP_PATHS.inspect, { file: '' })).status).toBe(400)
    expect((await post(server.port, SETUP_PATHS.inspect, { file, extra: 1 })).status).toBe(400)
    expect((await post(server.port, SETUP_PATHS.apply, { token: 1 })).status).toBe(400)
    expect(server.operations).toEqual([])
  })
})

describe('who may move a setup', () => {
  it('answers a remote session and another site before it reads the body, and a GET with 405', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    for (const path of Object.values(SETUP_PATHS)) {
      const remote = await send(server.port, path, { method: 'POST', headers: [CREDENTIAL, 'x-test-remote: 1'], body: {}, withholdBody: true })
      expect(json(remote)).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
      const crossSite = await send(server.port, path, { method: 'POST', headers: [CREDENTIAL, 'Origin: http://evil.example'], body: {}, withholdBody: true })
      expect(json(crossSite)).toMatchObject({ code: 'CROSS_SITE' })
      expect((await get(server.port, path)).status).toBe(405)
      expect((await send(server.port, path, { method: 'POST', body: {} })).status).toBe(401)
    }
    expect(server.operations).toEqual([])
  })
})
