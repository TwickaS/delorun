/**
 * The device unlock the gate notices open and read the minutes from. The plugin installs its unlock store here while it
 * is loaded, so a notice inside any section reaches the same dialog without each section's injected face carrying it.
 * @module @delorun/bundle-local/client/gate-unlock
 */
import { useSyncExternalStore } from 'react'
import type { UnlockSource, UnlockView } from './unlock.ts'

let installed: UnlockSource | undefined

/**
 * Make an unlock store the one the gate notices use.
 * @param unlock - the plugin's unlock store.
 * @returns the disposer, which removes it again.
 */
export function installGateUnlock(unlock: UnlockSource): () => void {
  installed = unlock
  return () => { if (installed === unlock) installed = undefined }
}

const NEVER = (): (() => void) => () => {}
const NOTHING = (): undefined => undefined

/** What a gate notice needs from the unlock: the configured minutes and how to open the dialog. */
export interface GateUnlock {
  /** The unlock length in minutes; undefined where the home has not said or the device is already unlocked. */
  readonly minutes: number | undefined
  /** Open the unlock dialog; undefined where no unlock applies (the computer itself, or no store installed). */
  readonly open: (() => void) | undefined
}

/**
 * Tell the device's unlock that an action which needs it just succeeded: the home slides the unlock's end after each such
 * action, so the end is read again instead of kept.
 */
export function noteUnlockedAction(): void {
  if (installed !== undefined) void installed.refresh()
}

/**
 * Read the unlock now, outside rendering, for a sentence built where a hook cannot run.
 * @returns the minutes and the opener; both undefined where there is no unlock to offer.
 */
export function currentGateUnlock(): GateUnlock {
  const view = installed?.hooks.unlock.getSnapshot()
  if (installed === undefined || view === undefined || view.place !== 'device') return { minutes: undefined, open: undefined }
  return { minutes: view.state.kind === 'elevated' ? undefined : view.state.unlockMinutes, open: installed.open }
}

/**
 * Read the unlock for a gate notice.
 * @returns the minutes and the opener; both undefined where there is no unlock to offer.
 */
export function useGateUnlock(): GateUnlock {
  const source = installed
  const view: UnlockView | undefined = useSyncExternalStore(source?.hooks.unlock.subscribe ?? NEVER, source === undefined ? NOTHING : source.hooks.unlock.getSnapshot)
  if (source === undefined || view === undefined || view.place !== 'device') return { minutes: undefined, open: undefined }
  return { minutes: view.state.kind === 'elevated' ? undefined : view.state.unlockMinutes, open: source.open }
}
