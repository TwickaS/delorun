/**
 * Offers bundles through upstream's plugin manager: reads which are installed or available, and adds one only when
 * the person presses its button. Nothing here installs or enables anything on its own.
 * @module @delo/plugin-onboarding/client/bundles
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

type PluginManager = ClientRemote['pluginManager']
type BundleInfo = Extract<Awaited<ReturnType<PluginManager['listBundles']>>, { ok: true }>['value'][number]
type InstallOptions = NonNullable<Parameters<PluginManager['installBundle']>[1]>

/**
 * Where one offered bundle stands for this profile. `checking` is before the plugin manager answers; `available` is
 * the only state a button can add from; `unavailable` is a bundle this installation does not offer; `failed` is a
 * bundle the plugin manager cannot change or could not be asked, which Plugins finishes.
 */
export type BundleState = 'checking' | 'available' | 'installing' | 'installed' | 'restart' | 'unavailable' | 'failed'

/** One offered bundle as the steps draw it. */
export interface BundleView {
  /** Where it stands. */
  readonly state: BundleState
  /** The package's own title, when the plugin manager lists one. */
  readonly title?: LocalizedText
  /** The package's own description, when the plugin manager lists one. */
  readonly description?: LocalizedText
}

/** What the steps use to offer bundles. */
export interface BundleInstaller {
  /** Every offered bundle's view by package name; a name is absent until `refresh` names it. */
  readonly views: { getSnapshot(): Readonly<Record<string, BundleView>>; subscribe(listener: () => void): () => void }
  /**
   * Read where the named bundles stand. Never adds anything.
   * @param names - package names.
   */
  refresh(names: readonly string[]): void
  /**
   * Add and switch on a bundle the person chose. Only a bundle in the `available` state is added.
   * @param name - package name.
   * @returns when the attempt settled; it never rejects.
   */
  install(name: string): Promise<void>
  /** Open Plugins, where an addition that needs a decision is finished. */
  openPlugins(): void
}

/**
 * Where a listed bundle stands.
 * @param bundle - the plugin manager's row, or undefined when it lists none by that name.
 * @returns the state before any action.
 */
export function stateOf(bundle: BundleInfo | undefined): BundleState {
  if (bundle === undefined) return 'unavailable'
  if (bundle.error !== undefined || bundle.readOnlyReason !== undefined) return 'failed'
  if (bundle.availability === 'missing') return bundle.installTarget === undefined ? 'unavailable' : 'available'
  return bundle.enabled ? 'installed' : 'available'
}

/**
 * Create the installer over the plugin manager's remote.
 * @param ctx - the studio context; `remote` and `pluginNavigation` are read when needed, so a profile without them shows `failed`.
 * @returns the installer.
 */
export function createBundleInstaller(ctx: Context): BundleInstaller {
  const views = createSnapshotStore<Readonly<Record<string, BundleView>>>({})
  const known = new Map<string, BundleInfo>()
  const set = (name: string, view: BundleView): void => { views.set({ ...views.getSnapshot(), [name]: view }) }
  const setAll = (names: readonly string[], state: BundleState): void => {
    views.set({ ...views.getSnapshot(), ...Object.fromEntries(names.map(name => [name, { state }])) })
  }
  const read = async (names: readonly string[]): Promise<void> => {
    const remote = ctx.get('remote')?.pluginManager
    if (remote === undefined) {
      setAll(names, 'failed')
      return
    }
    const listed = await remote.listBundles()
    if (!listed.ok) {
      setAll(names, 'failed')
      return
    }
    for (const name of names) {
      const bundle = listed.value.find(each => each.name === name)
      if (bundle === undefined) known.delete(name)
      else known.set(name, bundle)
      set(name, {
        state: stateOf(bundle),
        ...bundle?.meta?.title === undefined ? {} : { title: bundle.meta.title },
        ...bundle?.meta?.description === undefined ? {} : { description: bundle.meta.description },
      })
    }
  }
  return {
    views,
    refresh: (names) => {
      setAll(names, 'checking')
      read(names).catch((error: unknown) => {
        console.warn('delo onboarding: the plugins were not read', error)
        setAll(names, 'failed')
      })
    },
    install: async (name) => {
      const bundle = known.get(name)
      const remote = ctx.get('remote')?.pluginManager
      const before = views.getSnapshot()[name]
      if (before?.state !== 'available' || bundle === undefined || remote === undefined) return
      set(name, { ...before, state: 'installing' })
      try {
        const target = bundle.availability === 'missing' ? bundle.installTarget : undefined
        const result = target === undefined
          ? await remote.setBundleEnabled(name, true)
          : await remote.installBundle(target.spec, {
            enabled: true,
            requestId: randomUUID() as NonNullable<InstallOptions['requestId']>,
            registry: null,
            ...target.spec.startsWith('link:') ? {} : { saveExact: true },
          })
        const application = result.ok ? result.value.application : 'failed'
        set(name, { ...before, state: application === 'applied' ? 'installed' : application === 'restart-required' ? 'restart' : 'failed' })
      } catch (error) {
        // The outcome is unknown here; Plugins shows what the profile holds and can finish it.
        console.warn('delo onboarding: the plugin was not added', error)
        set(name, { ...before, state: 'failed' })
      }
    },
    openPlugins: () => { ctx.get('pluginNavigation')?.openList() },
  }
}
