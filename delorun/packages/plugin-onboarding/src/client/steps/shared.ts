/**
 * What the built-in step bodies share: their props, store and bundle hooks.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { BundleView } from '../bundles.ts'
import type { Guide, Store } from '../guide.ts'
import type { StepServices } from '../types.ts'

/** The props of a built-in step body. */
export interface StepProps {
  /** The services the body draws with. */
  readonly services: StepServices
  /** The guide's shared state. */
  readonly guide: Guide
}

/** The tone of a status line: done, needs attention, or neutral. */
export type Tone = 'done' | 'attention' | undefined

/**
 * @param store - a store.
 * @returns its current value, re-rendering on change.
 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(useCallback(listener => store.subscribe(listener), [store]), () => store.getSnapshot())
}

/**
 * @param services - the services.
 * @param name - a package.
 * @returns where it stands, re-rendering on change.
 */
export function useBundle(services: StepServices, name: string): BundleView | undefined {
  return useSyncExternalStore(
    useCallback(listener => services.bundles.views.subscribe(listener), [services.bundles]),
    () => services.bundles.views.getSnapshot()[name],
  )
}

/**
 * Read which of some bundles are installed or available once the step opens.
 * @param services - the services.
 * @param names - the packages.
 */
export function useRefresh(services: StepServices, names: readonly string[]): void {
  const { bundles } = services
  const key = names.join('\n')
  useEffect(() => { if (key !== '') bundles.refresh(key.split('\n')) }, [bundles, key])
}
