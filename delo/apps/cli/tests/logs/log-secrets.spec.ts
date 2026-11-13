/**
 * The home process's secret registry (`ctx.deloSecrets`): a Host plugin can register values and drop its own
 * registrations, and can read nothing back; a registration that protects nothing or exceeds the context's cap is refused.
 */
import { Context } from '@deepseek-ai/cordis'
import type { SecretKind, SecretSink } from '@delo/contract-operational-logs'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_REGISTRATIONS_PER_CONTEXT, SecretRegistry } from '../../src/log-secrets.ts'

let root: Context | undefined
afterEach(async () => {
  await root?.fiber.dispose()
  root = undefined
})

/** A sink that records what it was given, standing in for the home log's redactor. */
function recordingSink(): { readonly sink: SecretSink; readonly live: Map<string, SecretKind> } {
  const live = new Map<string, SecretKind>()
  return { live, sink: { register: (value, kind) => { live.set(value, kind); return () => { live.delete(value) } } } }
}

/**
 * Provide the registry on a root context and start a plugin context that reads it.
 * @param sink - where the registry registers values.
 * @returns the root and a plugin's context.
 */
async function mount(sink: SecretSink): Promise<{ readonly plugin: Context }> {
  root = new Context()
  new SecretRegistry(root, sink)
  let plugin: Context | undefined
  await root.plugin({ apply: (ctx: Context) => { plugin = ctx } })
  if (plugin === undefined) throw new Error('the plugin did not mount')
  return { plugin }
}

describe('ctx.deloSecrets', () => {
  it('registers and drops a plugin\'s values and offers no way to read any back', async () => {
    const { sink, live } = recordingSink()
    const { plugin } = await mount(sink)
    const secrets = plugin.deloSecrets
    if (secrets === undefined) throw new Error('the registry is not provided')
    const drop = secrets.register('plugin-minted-secret-1', 'session-secret')
    expect(live.get('plugin-minted-secret-1')).toBe('session-secret')
    drop()
    drop()
    expect(live.size).toBe(0)
    // The service holds the sink only in a closure: nothing it exposes, own or inherited, leads to a value.
    secrets.register('plugin-minted-secret-2', 'cookie')
    const surface = new Set<unknown>()
    for (let target: object | null = secrets; target !== null; target = Object.getPrototypeOf(target)) {
      for (const key of Reflect.ownKeys(target)) if (key !== 'ctx') surface.add(Reflect.get(target, key))
    }
    for (const exposed of surface) {
      expect(exposed).not.toBe(sink)
      expect(exposed).not.toBe(live)
      expect(JSON.stringify(typeof exposed === 'function' || typeof exposed === 'symbol' ? '' : exposed) ?? '').not.toContain('plugin-minted-secret-2')
    }
  })

  it('refuses a value too short for the redactor to match', async () => {
    const { sink, live } = recordingSink()
    const { plugin } = await mount(sink)
    expect(() => plugin.deloSecrets?.register('short', 'cookie')).toThrow(/shorter than the 8/)
    expect(live.size).toBe(0)
  })

  it('refuses a registration past the cap of one context, and counts a dropped one again', async () => {
    const { sink, live } = recordingSink()
    const { plugin } = await mount(sink)
    const drops = Array.from({ length: MAX_REGISTRATIONS_PER_CONTEXT }, (_, index) => plugin.deloSecrets?.register(`plugin-secret-${String(index).padStart(6, '0')}`, 'session-secret'))
    expect(() => plugin.deloSecrets?.register('one-secret-too-many', 'session-secret')).toThrow(/registrations already/)
    expect(live.has('one-secret-too-many')).toBe(false)
    drops[0]?.()
    expect(() => plugin.deloSecrets?.register('one-secret-too-many', 'session-secret')).not.toThrow()
  })
})
