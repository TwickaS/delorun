/**
 * The studio's read of a preview flag: a provider holds the page's store, and `usePreviewFlag` reads one flag from it.
 * @module @delorun/preview-flags/client/hooks
 */
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { PreviewFlagId } from '../flags.ts'
import { flagOn, type PreviewFlagsStore } from './store.ts'

const StoreContext = createContext<PreviewFlagsStore | null>(null)

/**
 * Give the components below a store to read flags from. A plugin creates one store and wraps the roots it renders.
 * @param props - the store and the components that read it.
 * @returns the provider.
 */
export function PreviewFlagsProvider({ store, children }: { readonly store: PreviewFlagsStore; readonly children?: ReactNode }): ReactNode {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

/**
 * Read whether a preview flag is on. The first call under a provider starts the store's one read.
 * @param id - the flag.
 * @returns true once the Host answered that the flag is declared and on; false before the answer, when the read
 *   failed, when the flag is off and when its plugin is off.
 * @throws {Error} when no {@link PreviewFlagsProvider} is above the component.
 */
export function usePreviewFlag(id: PreviewFlagId): boolean {
  const store = useContext(StoreContext)
  if (store === null) throw new Error(`usePreviewFlag("${id}") needs a PreviewFlagsProvider above it`)
  useEffect(() => { void store.load() }, [store])
  return useSyncExternalStore(store.subscribe, () => flagOn(store.getSnapshot(), id))
}
