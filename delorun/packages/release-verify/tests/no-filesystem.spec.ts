/**
 * A whole start check, offline and online, touches no filesystem: `node:fs` and `node:fs/promises` are replaced by
 * modules whose every function fails and records its call, and a bundle that names its manifest file like a path is
 * refused without a file being opened. The genuine bundle verifies through the same replaced modules.
 */
import { vi } from 'vitest'

const { touched } = vi.hoisted(() => ({ touched: [] as string[] }))

/**
 * A module whose every export records its call and throws.
 * @param module - the module's name.
 * @returns the replacement.
 */
function refusing(module: string): object {
  return new Proxy({}, {
    get: (_target, property) => (...args: unknown[]) => {
      touched.push(`${module}.${String(property)}(${String(args[0])})`)
      throw new Error(`${module}.${String(property)} was reached during verification`)
    },
  })
}

vi.mock('node:fs', () => refusing('node:fs'))
vi.mock('node:fs/promises', () => refusing('node:fs/promises'))

const { describe, expect, it } = await import('vitest')
const { checkAtStart } = await import('../src/start.ts')
const { COSIGNED_AT, FixtureTransport, MANIFEST, scenario, VERSION } = await import('./fixtures.ts')

describe('a start check reaches no filesystem', () => {
  it('refuses a bundle whose manifest name is a path, opening no file', async () => {
    const fixture = scenario()
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const named = { ...fixture.bundle, manifest: { ...fixture.bundle.manifest, name: '../../../../etc/passwd' } }
    const result = await checkAtStart({ root: fixture.root, version: VERSION, manifest: MANIFEST, bundle: Buffer.from(JSON.stringify(named)), now: COSIGNED_AT + 60, stored: undefined, transport, mode: 'enforce', missingBundle: 'failed' })
    expect(result).toMatchObject({ state: 'failed', refusal: 'manifest-digest-mismatch', stop: true })
    expect(touched).toEqual([])
  })

  it('verifies the genuine bundle offline and online, opening no file', async () => {
    const fixture = scenario()
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const result = await checkAtStart({ root: fixture.root, version: VERSION, manifest: MANIFEST, bundle: Buffer.from(JSON.stringify(fixture.bundle)), now: COSIGNED_AT + 60, stored: undefined, transport, mode: 'enforce', missingBundle: 'failed' })
    expect(result.state).toBe('verified')
    expect(touched).toEqual([])
  })
})
