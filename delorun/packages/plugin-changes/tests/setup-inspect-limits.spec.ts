/**
 * The studio reads an uploaded setup file inside the Host, so it refuses a file whose entries declare more than a setup
 * of that size can hold before it inflates any of them, and it names the limit a too large upload broke.
 */
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { exportSetupArchive, loadHomeKey } from '@delorun/archive'
import { DEFAULT_IMPORT_OPTIONS } from '@delorun/changes/setup-transfer'
import { HeldSetups, inspectSetup, MAX_SETUP_FILE_BYTES, SETUP_INSPECT_LIMITS, SetupRefusal } from '../src/setup-actions.ts'
import { SETUP_PATHS } from '../src/wire.ts'
import { json, post, routeHome, serveRoutes } from './routes-fixture.ts'

/**
 * A setup file with one local plugin file that declares `size` bytes: incompressible bytes for a hundredth of it and
 * zeros for the rest, so the compression ratio stays under the contract's limit of 100 and only the size limits refuse.
 * @param home - the home whose key writes the file.
 * @param size - the declared size of the plugin file, in bytes.
 * @returns the file as base64.
 */
async function setupDeclaring(home: string, size: number): Promise<string> {
  const key = (await loadHomeKey(home, { create: true }))!
  const content = Buffer.concat([randomBytes(Math.ceil(size / 90)), Buffer.alloc(size - Math.ceil(size / 90))])
  const sha256 = createHash('sha256').update(content).digest('hex')
  const manifest = Buffer.from('{"name":"big","version":"1.0.0"}\n')
  const manifestSha = createHash('sha256').update(manifest).digest('hex')
  const bytes = exportSetupArchive({
    createdBy: 'test',
    origin: { homeKeyId: key.keyId, publicKey: key.publicKey },
    document: { schemaVersion: 1, profile: 'p', includesSettings: false, plugins: [{ name: 'big', source: 'local', files: [{ path: 'package.json', sha256: manifestSha, size: manifest.length, executable: false }, { path: 'blob.bin', sha256, size, executable: false }] }], models: [], settings: [] },
    files: new Map([[sha256, content], [manifestSha, manifest]]),
  })
  return Buffer.from(bytes).toString('base64')
}

describe('setup inspect limits', () => {
  it('refuses an entry that declares more than a setup file of the studio\'s size can hold, naming the limit', async () => {
    const { ctx } = routeHome()
    const file = await setupDeclaring(ctx.home, SETUP_INSPECT_LIMITS.maxEntryBytes + 1)
    const refusal = await inspectSetup(ctx, { file }, new HeldSetups(), DEFAULT_IMPORT_OPTIONS).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(SetupRefusal)
    expect(refusal).toMatchObject({ status: 422, code: 'ARCHIVE_ENTRY_TOO_LARGE' })
  })

  it('keeps limits that cannot be wider than the contract and that an entry under them passes', async () => {
    const { ctx } = routeHome()
    expect(SETUP_INSPECT_LIMITS.maxEntryBytes).toBeLessThan(1024 * 1024 * 1024)
    expect(SETUP_INSPECT_LIMITS.maxTotalBytes).toBeLessThan(4 * 1024 * 1024 * 1024)
    const file = await setupDeclaring(ctx.home, 1024 * 1024)
    expect(await inspectSetup(ctx, { file }, new HeldSetups(), DEFAULT_IMPORT_OPTIONS)).toMatchObject({ named: [], install: [{ name: 'big' }] })
  })
})

describe('the sentence of a body that is too large', () => {
  it('names the 32 MiB setup file for the setup route, not the larger limit of its encoded body', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const reply = await post(server.port, SETUP_PATHS.inspect, 'x'.repeat(Math.ceil(MAX_SETUP_FILE_BYTES * 4 / 3) + 2048))
    expect(reply.status).toBe(413)
    expect(json(reply).message).toBe('A setup file larger than 32 MiB is imported with delorun setup import.')
  })
})
