/**
 * The worker host's page admission: the `authenticator` provider of a tree that only the spawning page can reach.
 */
import { describe, expect, it } from 'vitest'
import { installPageAdmission, type HostContext } from '../src/worker-host.ts'

/** Stand-in for cordis's `Service`: records the owner and the service name it was given. */
class FakeService {
  constructor(readonly ctx: HostContext, readonly name: string) {}
}

describe('page admission', () => {
  it('mounts an authenticator that admits the browser Peer and declares no listener policy', async () => {
    const browserPeer = { id: 'browser' }
    let mounted: (new (owner: HostContext) => { admit(): unknown; policy(): unknown; name: string }) | undefined
    const ctx: HostContext = {
      logger: { exporter: () => undefined },
      get: (service: string) => service === 'connection' ? { browserPeer } : undefined,
      provide: () => {},
      plugin: async (plugin: unknown) => { mounted = plugin as typeof mounted; return undefined },
      fiber: { dispose: async () => {} },
    }
    await installPageAdmission(ctx, (specifier) => {
      expect(specifier).toBe('@deepseek-ai/cordis')
      return { Service: FakeService }
    })
    if (mounted === undefined) throw new Error('no authenticator was mounted')
    const authenticator = new mounted(ctx)
    expect(authenticator.name).toBe('authenticator')
    expect(authenticator.admit()).toEqual({ kind: 'admitted', peer: browserPeer })
    expect(authenticator.policy()).toBeUndefined()
  })
})
