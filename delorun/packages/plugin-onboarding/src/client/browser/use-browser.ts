/**
 * Browser's state for the Settings page and the guide's Browser step: the home's choice, where adding the pack stands,
 * and whether the pack is ready. Browser is on until the person turns it off, so an unchosen home that has not added the
 * pack adds it when the page or the step opens; a home that chose off, here or in Plugins, is left alone.
 * @module @delorun/plugin-onboarding/client/browser/use-browser
 */
import { BROWSER_BUNDLE, browserAdded, browserPageState, REAL_BROWSER_BUNDLE, resolveBrowserSwitch, type BrowserPageState, type BrowserReadiness, type BrowserSwitch } from '@delorun/browser-setup'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { TurnOffOutcome } from '../browser-pack.ts'
import type { BundleView } from '../bundles.ts'
import { useBundle, useRefresh } from '../steps/shared.ts'
import type { StepServices } from '../types.ts'

/** What the hook reads from the services. */
export type BrowserServices = Pick<StepServices, 'bundles' | 'browser' | 'remote'>

/** What turning Browser off or on is doing: nothing, working, or how the last turn ended. */
export type SwitchResult = { readonly kind: 'idle' } | { readonly kind: 'working' } | { readonly kind: 'done'; readonly outcome: TurnOffOutcome | 'on' } | { readonly kind: 'failed' }

/** What {@link useBrowser} returns. */
export interface BrowserView {
  /** The home's choice. */
  readonly choice: BrowserSwitch
  /** What the page shows for the built-in browser. */
  readonly state: BrowserPageState
  /** The built-in pack's view from the installer. */
  readonly view: BundleView | undefined
  /** What the Host's requirement check says about the built-in pack. */
  readonly readiness: BrowserReadiness
  /** Whether the pack is added, loaded or about to be. */
  readonly on: boolean
  /** The own-Chrome pack's view from the installer. */
  readonly ownView: BundleView | undefined
  /** What the Host's requirement check says about the own-Chrome pack. */
  readonly ownReadiness: BrowserReadiness
  /** How the last switch ended. */
  readonly result: SwitchResult
  /** Whether a switch is being applied, so the controls wait. */
  readonly working: boolean
  /** Read the built-in pack's requirement check again. */
  readonly recheck: () => void
  /**
   * Turn Browser on: record the choice; the pack is then added, as it is for any home that never chose.
   * @returns when the attempt settled; it never rejects.
   */
  readonly turnOn: () => Promise<void>
  /** Add the pack again after an add that failed, and read the check again. */
  readonly retry: () => void
  /**
   * Turn Browser off: turn the pack off when it is on, then record the choice.
   * @returns when the attempt settled; it never rejects.
   */
  readonly turnOff: () => Promise<void>
}

/**
 * Read and change the home's Browser choice.
 * @param services - the installer, the Browser face and whether the studio is a phone.
 * @returns the state and the two actions.
 */
export function useBrowser(services: BrowserServices): BrowserView {
  const { browser, bundles, remote } = services
  const recorded = useSyncExternalStore(browser.choice.subscribe, browser.choice.getSnapshot)
  const readiness = useSyncExternalStore(browser.setup.subscribe, browser.setup.getSnapshot)
  const ownReadiness = useSyncExternalStore(browser.ownSetup.subscribe, browser.ownSetup.getSnapshot)
  const view = useBundle(services, BROWSER_BUNDLE)
  const ownView = useBundle(services, REAL_BROWSER_BUNDLE)
  useRefresh(services, [BROWSER_BUNDLE, REAL_BROWSER_BUNDLE])
  const [result, setResult] = useState<SwitchResult>({ kind: 'idle' })
  const choice = resolveBrowserSwitch(recorded, view?.held === true)
  const packState = view?.state
  // Read when the page opens, when the pack's state changes (it was just added or turned off), and when the window
  // regains focus, so a need the person met in a terminal clears without leaving the page.
  useEffect(() => {
    void browser.setup.refresh()
    void browser.ownSetup.refresh()
    const again = (): void => { void browser.setup.refresh(); void browser.ownSetup.refresh() }
    window.addEventListener('focus', again)
    return () => { window.removeEventListener('focus', again) }
  }, [browser, packState, ownView?.state])
  // On until the person turns it off: an unchosen home that has not added the pack adds it. A phone cannot install.
  useEffect(() => {
    if (choice === 'on' && !remote && packState === 'available' && view?.held !== true) void bundles.install(BROWSER_BUNDLE)
  }, [choice, remote, packState, view?.held, bundles])
  const adding = packState === 'installing' || packState === 'slow'
  const on = adding || packState === 'installed' || packState === 'restart' || browserAdded(readiness)
  const state = browserPageState({
    choice,
    pack: packState ?? 'checking',
    packReason: view?.reason ?? view?.packsReason,
    readiness,
  })
  const turnOn = useCallback(async (): Promise<void> => {
    setResult({ kind: 'working' })
    try {
      const accepted = await browser.choice.record('on')
      if (!accepted) { setResult({ kind: 'failed' }); return }
      setResult({ kind: 'done', outcome: 'on' })
    } catch (error) {
      console.warn('delorun browser: Browser was not turned on', error)
      setResult({ kind: 'failed' })
    }
    bundles.refresh([BROWSER_BUNDLE])
  }, [browser, bundles])
  const turnOff = useCallback(async (): Promise<void> => {
    setResult({ kind: 'working' })
    try {
      const outcome: TurnOffOutcome = on ? await browser.turnOff() : 'off'
      // A pack that stays on is still the choice in effect, so nothing is recorded.
      if (outcome === 'failed') { setResult({ kind: 'failed' }); return }
      const accepted = await browser.choice.record('off')
      setResult(accepted ? { kind: 'done', outcome } : { kind: 'failed' })
    } catch (error) {
      console.warn('delorun browser: Browser was not turned off', error)
      setResult({ kind: 'failed' })
    }
    bundles.refresh([BROWSER_BUNDLE])
  }, [browser, bundles, on])
  const recheck = useCallback((): void => { void browser.setup.refresh() }, [browser])
  const retry = useCallback((): void => {
    void bundles.install(BROWSER_BUNDLE)
    void browser.setup.refresh()
  }, [browser, bundles])
  return { choice, state, view, readiness, on, ownView, ownReadiness, result, working: result.kind === 'working', recheck, retry, turnOn, turnOff }
}
