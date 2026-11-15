/**
 * The providers step's services over the studio's own remote namespaces: the provider directory, the free model-list
 * request for a typed key, and saving a key the way upstream's Models settings page does.
 * @module @delorun/plugin-onboarding/client/providers-face
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { deriveKeyRef, type DirectoryEntry, type KeyProbe } from './providers.ts'
import type { ProvidersFace } from './types.ts'

/** The settings namespace whose profiles name a credential reference only once a key is stored. */
const PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * @param value - a settings value.
 * @param path - keys to follow.
 * @returns the value at the path, or undefined.
 */
function at(value: unknown, path: readonly string[]): unknown {
  let node = value
  for (const key of path) node = typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined
  return node
}

/**
 * Build the services from the studio's remote namespaces.
 * @param ctx - the browser plugin context, which declares `remote.credentials`, `remote.llm` and `remote.settings`.
 * @returns the services. Every method resolves; none rejects.
 */
export function createProvidersFace(ctx: Context): ProvidersFace {
  return {
    directory: async () => {
      try {
        const response = await ctx.remote.llm.listConfigurableProviders()
        if (!response.ok) return undefined
        return response.value.map((each): DirectoryEntry => ({
          provider: each.provider,
          displayName: each.displayName,
          settingsNs: each.settingsNs,
          settingsPath: each.settingsPath,
          ...each.declared === undefined ? {} : { declared: each.declared },
          ...each.defaultBaseURL === undefined ? {} : { defaultBaseURL: each.defaultBaseURL },
          authEnv: each.nativeAuth?.env ?? [],
          baseURLEnv: each.baseURLEnv ?? [],
        }))
      } catch (error) {
        console.warn('delorun onboarding: the provider directory was not read', error)
        return undefined
      }
    },
    probe: async (entry, key, baseURL): Promise<KeyProbe> => {
      try {
        const endpoint = baseURL ?? entry.defaultBaseURL
        const response = await ctx.remote.llm.discoverModels(entry.settingsNs, {
          provider: entry.provider, apiKey: key, ...endpoint === undefined ? {} : { baseURL: endpoint },
        })
        if (!response.ok) return { kind: 'failed' }
        const first = response.value[0]
        return { kind: 'works', models: response.value.length, defaultModel: first === undefined ? undefined : first.name ?? first.id }
      } catch (error) {
        console.warn('delorun onboarding: the key was not tested', error)
        return { kind: 'failed' }
      }
    },
    save: async (entry, key, baseURL) => {
      try {
        const described = await ctx.remote.settings.describe()
        if (!described.ok) return false
        const namespace = described.value.namespaces.find(each => each.ns === entry.settingsNs)
        const profile = at(namespace?.value, entry.settingsPath)
        const named = at(profile, ['apiKeyEnv'])
        const ref = typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(entry.provider)
        // As upstream's provider editor: a catalog route names the conventional reference only once a key is stored.
        const names = entry.settingsNs === PI_AI_NAMESPACE && at(namespace?.base, [...entry.settingsPath, 'apiKeyEnv']) === undefined && at(profile, ['apiKeyEnv']) === undefined
        const fields: Record<string, string> = { ...names ? { apiKeyEnv: ref } : {}, ...baseURL === undefined ? {} : { baseURL } }
        if (Object.keys(fields).length > 0) {
          const ops = profile === undefined
            ? [{ op: 'set' as const, path: [...entry.settingsPath], value: fields }]
            : Object.entries(fields).map(([field, value]) => ({ op: 'set' as const, path: [...entry.settingsPath, field], value }))
          const written = await ctx.remote.settings.mutate(entry.settingsNs, ops, namespace?.revision)
          if (!written.ok) return false
        }
        return (await ctx.remote.credentials.set(ref, key)).ok
      } catch (error) {
        console.warn('delorun onboarding: the key was not saved', error)
        return false
      }
    },
  }
}
