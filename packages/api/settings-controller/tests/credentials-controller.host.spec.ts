import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerId, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol/types'
import CredentialsController from '../src/credentials.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

/** A store whose `describe` carries more than the view declares, as a foreign provider might. */
class LeakyCredentials extends MemoryCredentials {
  override describe(): Promise<CredentialInfo> {
    return Promise.resolve(
      { configured: true, source: 'memory', writable: true, masked: '•'.repeat(9), value: 'sk-leaked', preview: 'sk…ed' } as CredentialInfo,
    )
  }
}

/** A store that masks a stored value the way the local file store does: prefix, suffix and length. */
class MaskingCredentials extends MemoryCredentials {
  override async describe(ref: Parameters<MemoryCredentials['describe']>[0]): Promise<CredentialInfo> {
    const info = await super.describe(ref)
    const value = (await this.resolve(ref))?.value ?? ''
    return { ...info, masked: `${value.slice(0, 3)}${'•'.repeat(5)}${value.slice(-4)} (${String(value.length)})` }
  }
}

/** A store whose write rejects with a bare string, the way some client libraries do. */
class LiteralRejectingCredentials extends MemoryCredentials {
  override async set(): Promise<void> {
    throw 'the store refused'
  }
}

/** A store whose provider-owned policy rejects an otherwise valid write. */
class RejectingCredentials extends MemoryCredentials {
  override set(): Promise<void> {
    return Promise.reject(new Error('the stored document no longer parses'))
  }
}

async function boot(
  seed: Record<string, string> = {},
  provider: typeof MemoryCredentials = MemoryCredentials,
): Promise<CredentialsController> {
  const ctx = new Context()
  await ctx.plugin(provider, seed)
  await ctx.plugin(CredentialsController)
  return ctx.credentialsController
}

describe('the credentials Remote namespace a configuration surface calls', () => {
  it('publishes the credentials namespace from its own service key', async () => {
    const controller = await boot()
    const binding = controller.typertRemote
    expect(binding.serviceKey).toBe('credentialsController')
    expect(binding.namespace).toBe('credentials')
    expect(remoteMethods(controller)).toEqual([
      { method: 'describe', invocation: { kind: 'direct' } },
      { method: 'set', invocation: { kind: 'direct' } },
      { method: 'unset', invocation: { kind: 'direct' } },
    ])
  })

  it('reports the actionable configuration error while no credential provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(CredentialsController)
    for (const call of [
      () => ctx.credentialsController.describe(['DEEPSEEK_API_KEY']),
      () => ctx.credentialsController.set('DEEPSEEK_API_KEY', 'sk-live'),
      () => ctx.credentialsController.unset('DEEPSEEK_API_KEY'),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({
        code: 'gateway/internal',
        message: 'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        details: {},
      })
    }
  })

  it('describes a batch of references as one map, values excluded', async () => {
    const controller = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    const described = await controller.describe(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])
    expect(described).toEqual({
      DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true },
      OPENAI_API_KEY: { configured: false, writable: true },
    })
    expect(JSON.stringify(described)).not.toContain('sk-seeded')
  })

  it('reports an invalid reference as bad-request', async () => {
    const controller = await boot()
    for (const call of [
      () => controller.describe(['DEEPSEEK_API_KEY', 'not a var']),
      () => controller.set('not a var', 'sk-live'),
      () => controller.unset('not a var'),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('answers the largest batch it accepts and reports one reference more as bad-request', async () => {
    const controller = await boot()
    const accepted = Array.from({ length: 64 }, (_unused, index) => `REF_${String(index)}`)
    expect(Object.keys(await controller.describe(accepted))).toHaveLength(64)
    const failure = await controller.describe([...accepted, 'REF_64']).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
  })

  it('answers only the fields the view declares, whatever a provider returns', async () => {
    const controller = await boot({}, LeakyCredentials)
    const described = await controller.describe(['DEEPSEEK_API_KEY'])
    expect(described.DEEPSEEK_API_KEY).toEqual({ configured: true, source: 'memory', writable: true, masked: '•'.repeat(9) })
    expect(JSON.stringify(described)).not.toContain('sk-leaked')
    expect(JSON.stringify(described)).not.toContain('sk…ed')
  })

  it('gives a caller that is not the owner presence and writability only, with no part or length of the key', async () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    const ctx = new Context()
    await ctx.plugin(MaskingCredentials, { DEEPSEEK_API_KEY: key })
    await ctx.plugin(CredentialsController)
    const signal = new AbortController().signal
    const as = (principal: Principal) => ctx.extend({
      invocation: {
        request: { namespace: 'credentials', method: 'describe', args: {} },
        service: 'credentialsController',
        peer: { id: 'p' as PeerId, ctx, principal, interactions: 'answer', signal, dispose: async () => {} },
        signal,
        uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      } satisfies RemoteInvocation,
    }).credentialsController
    const owner = await as({ kind: 'owner' }).describe(['DEEPSEEK_API_KEY'])
    expect(owner.DEEPSEEK_API_KEY?.masked).toBeDefined()
    const device = await as({ kind: 'test-guest', guest: 'viewer' }).describe(['DEEPSEEK_API_KEY'])
    expect(device).toEqual({ DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true } })
    const text = JSON.stringify(device)
    for (let at = 0; at + 4 <= key.length; at++) expect(text).not.toContain(key.slice(at, at + 4))
    expect(text).not.toContain(String(key.length))
  })

  it('stores and removes through the same references the batch describes', async () => {
    const controller = await boot()
    await controller.set('DEEPSEEK_API_KEY', 'sk-live')
    expect(await controller.describe(['DEEPSEEK_API_KEY']))
      .toEqual({ DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true } })
    await controller.unset('DEEPSEEK_API_KEY')
    expect(await controller.describe(['DEEPSEEK_API_KEY']))
      .toEqual({ DEEPSEEK_API_KEY: { configured: false, writable: true } })
  })

  it('reports a refused write as credential/rejected naming only the reference', async () => {
    const controller = await boot({}, RejectingCredentials)
    const failure = await controller.set('DEEPSEEK_API_KEY', 'sk-live').catch((error: unknown) => error)
    const { code, message, details } = remoteErrorOf(failure) ?? {}
    expect(code).toBe('credential/rejected')
    expect(message).toContain('no longer parses')
    expect(details).toEqual({ ref: 'DEEPSEEK_API_KEY' })
  })

  it('reports an empty value as bad-request', async () => {
    const controller = await boot()
    const failure = await controller.set('DEEPSEEK_API_KEY', '').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
  })

  it('stringifies a refusal that is not an Error', async () => {
    const controller = await boot({}, LiteralRejectingCredentials)
    const failure = await controller.set('DEEPSEEK_API_KEY', 'sk-live').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)?.message).toBe('the store refused')
  })
})
