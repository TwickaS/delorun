/**
 * The onboarding dialog in upstream's `settings.onboarding` seat: a modal over the studio with the step's name and
 * progress pinned at its top, the current step scrolling beneath with Complete setup later beside it, and Skip step, Back and Continue pinned under it. It shows on a
 * profile that has not finished onboarding, or whenever Settings opens it explicitly, and finishing is kept
 * on the profile. Skip step leaves one step and goes on; Complete setup later closes the guide, keeps the place and keeps the pause in the home; Escape closes it for this page only, and the Finish setup chip near the message box brings it back for the rest of the visit. Starting the first chat from Ready also completes upstream's DeepSeek key step, since Welcome offered
 * the Models section; skipping leaves that step to show. The dialog owns the page's inert root while it shows, as
 * upstream's steps do.
 */
import { Modal, usePhone } from '@deepseek-ai/dsh-client-ui-primitives'
import { OnboardingDownloadsRow } from '@delorun/plugin-downloads/row'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { OnboardingSettings } from '../config.ts'
import type { DeferrableStep, SetupRecord } from '../wire.ts'
import type { HostFetch } from '@delorun/bundle-local/host-api'
import { readPinState } from '@delorun/bundle-local/pin-api'
import { browserAdded } from '@delorun/browser-setup'
import { buildSteps, STEPS, withSteps, type FlowStep } from './flow.tsx'
import { landFocus } from './focus.ts'
import { createGuide, type Guide } from './guide.ts'
import type { OnboardingInjected, ReachState, StepServices } from './types.ts'
import { DIALOG_CLASS, StepFrame } from './frame/StepFrame.tsx'
import { StepFooter } from './frame/StepFooter.tsx'

/** The entry's props: the owner props it reads, this plugin's copy and the dialog's services. */
export type OnboardingStepEntryProps = Pick<PropsRuntime<'settings.onboarding'>, 'complete' | 'explicit' | 'renderSection' | 'completeStep'> & PropsLocale<'delorunOnboarding'> & InjectFace<OnboardingInjected>

/** Upstream's DeepSeek key step, which Welcome's Models section covers once the first chat starts. */
export const UPSTREAM_KEY_STEP = 'deepseek-official'

/**
 * Show the dialog while onboarding is unfinished or was opened explicitly, and complete upstream's step otherwise.
 * @param props - upstream's owner props, this plugin's copy and the services.
 * @returns the dialog, or nothing.
 */
export function OnboardingStepEntry(props: OnboardingStepEntryProps): ReactNode {
  const { progress, complete, explicit = false, aside, deferredOnly } = props
  const snapshot = useSyncExternalStore(useCallback(listener => progress.subscribe(listener), [progress]), () => progress.getSnapshot())
  const settings = snapshot.status === 'ready' ? snapshot.value : undefined
  const show = settings !== undefined && (!settings.done || explicit)
  const decided = snapshot.status !== 'loading'
  // A finished profile, or one whose progress cannot be read, lets upstream's flow go on at once.
  useEffect(() => { if (decided && !show) complete() }, [decided, show, complete])
  // "Complete setup later" hides the dialog for this visit and leaves `done` unset, so it shows again on the next load.
  const later = useSyncExternalStore(aside.subscribe, aside.getSnapshot)
  const leave = useCallback((): void => { aside.set(true); deferredOnly.set(false); complete() }, [aside, deferredOnly, complete])
  // Escape closes the guide for this page only: it keeps no pause in the home, so the guide shows again on the next load.
  const dismiss = useCallback((): void => { aside.set(true, false); deferredOnly.set(false); complete() }, [aside, deferredOnly, complete])
  return show && !later ? <Dialog {...props} settings={settings} explicit={explicit} later={leave} dismiss={dismiss} /> : null
}

/** Whether the Workspace step told the person there is no default workspace; the flow sets it. */
interface Told { current: boolean }

/**
 * Keep the workspace UI's default-workspace notice back while the dialog shows. On close the notice is dropped when the
 * Workspace step told the person there is no default workspace, and shows otherwise.
 * @param start - the workspace face.
 * @returns the flag the flow sets.
 */
function useNoticeHold(start: OnboardingInjected['services']['start']): Told {
  const [told] = useState<Told>(() => ({ current: false }))
  useEffect(() => {
    const release = start.holdNotice()
    return () => { release(told.current) }
  }, [start, told])
  return told
}

/** What the dialog reads before it shows its steps. */
interface Loaded {
  readonly record: SetupRecord
  readonly reach: ReachState
  /** The studio's address over Tailscale, read where reach is set up. */
  readonly deviceAddress: string | undefined
  /** Whether PIN mode is on, read where reach is set up or the studio is on a phone, where the PIN step then leaves out. */
  readonly pinOn: boolean
  /** Whether the Browser plugin pack is in the profile and loaded, which shows its step where the guide does not offer the pack. */
  readonly browserAdded: boolean
}

/**
 * Read whether PIN mode is on, as a paired phone may.
 * @param fetch - the request function.
 * @returns true when the home says it is on; false when it is off or cannot be read.
 */
async function readPinOn(fetch: HostFetch): Promise<boolean> {
  try {
    return (await readPinState(fetch))?.kind === 'on'
  } catch (error) {
    // The PIN step then shows, which is safe: deferring it only leaves a reminder at the computer.
    console.warn('delorun onboarding: PIN mode was not read', error)
    return false
  }
}

/** Load what the terminal setup recorded and whether reach is set up, start the guide's reads, then show the flow. */
function Dialog(props: OnboardingStepEntryProps & { readonly settings: OnboardingSettings; readonly explicit: boolean; readonly later: () => void; readonly dismiss: () => void }): ReactNode {
  const { loadRecord, services } = props
  const told = useNoticeHold(services.start)
  const [loaded, setLoaded] = useState<Loaded | undefined>()
  const [guide] = useState<Guide>(() => createGuide(services.host))
  useEffect(() => {
    let live = true
    void Promise.all([loadRecord(), services.host.reach(), services.browser.setup.refresh()]).then(async ([record, reach, browser]) => {
      // The computer reads it too: a first open leaves the PIN step out where PIN mode is already on.
      const pinOn = reach !== 'off' && reach !== 'absent' && await readPinOn(services.pin.fetch)
      const deviceAddress = reach === 'set-up' ? await services.host.reachAddress() : undefined
      if (live) setLoaded({ record, reach, deviceAddress, pinOn, browserAdded: browserAdded(browser) })
    })
    return () => { live = false }
  }, [loadRecord, services.host, services.pin, services.browser])
  return loaded === undefined ? null : <Flow {...props} {...loaded} told={told} guide={guide} />
}

/**
 * Keep the page's root inert behind the dialog. When the dialog closes and nothing behind it took focus back, focus
 * lands in the page ({@link landFocus}) instead of staying on the document body.
 */
function useInertRoot(): void {
  // A layout effect, so that on close the root stops being inert before the modal layer, a child, puts focus back in
  // its own layout cleanup; React runs a removed parent's layout cleanup before its children's.
  useLayoutEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const previous = appRoot.inert
    appRoot.inert = true
    return () => { appRoot.inert = previous }
  }, [])
  // After every layout cleanup, so the modal layer has put focus back where it could.
  useEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    return () => { landFocus(appRoot) }
  }, [])
}

/** The steps, the current one and the buttons. */
function Flow(props: OnboardingStepEntryProps & Loaded & { readonly settings: OnboardingSettings; readonly explicit: boolean; readonly told: Told; readonly guide: Guide; readonly later: () => void; readonly dismiss: () => void }): ReactNode {
  const { t, later, dismiss, progress, extra, services: fixed, startChat, complete, completeStep, renderSection, settings, explicit, record, reach, deviceAddress, pinOn, browserAdded: browserIsAdded, told, guide, deferredOnly } = props
  const { start } = fixed
  useInertRoot()
  const addedSteps = useSyncExternalStore(useCallback(listener => extra.subscribe(listener), [extra]), () => extra.getSnapshot())
  const target = useSyncExternalStore(start.target.subscribe, start.target.getSnapshot)
  const phone = useSyncExternalStore(useCallback(listener => guide.phone.subscribe(listener), [guide]), () => guide.phone.getSnapshot())
  const workspace = useSyncExternalStore(useCallback(listener => guide.workspace.subscribe(listener), [guide]), () => guide.workspace.getSnapshot())
  // The phone step's button reads the Tailscale checks, so the flow follows them.
  useSyncExternalStore(useCallback(listener => guide.readiness.subscribe(listener), [guide]), () => guide.readiness.getSnapshot())
  // The default workspace is looked up when the dialog opens, and chosen once it resolves unless the person chose another.
  useEffect(() => { start.resolve() }, [start])
  // A re-run keeps the workspace the studio already holds until the person chooses another; with none, as on a first run, Skip takes the default.
  const [keepCurrent] = useState(() => explicit && start.hasWorkspace())
  useEffect(() => {
    if (!keepCurrent && target.kind === 'default' && guide.workspace.getSnapshot() === undefined) guide.chooseWorkspace({ kind: 'default', workspaceId: target.workspaceId, path: target.path })
    if (target.kind === 'none') told.current = true
  }, [target, guide, told, keepCurrent])
  const { plugins, optionalRows } = settings
  const services = useMemo<StepServices>(() => ({ ...fixed, t, remote: reach === 'remote', plugins, optionalRows, renderSection }), [fixed, t, reach, plugins, optionalRows, renderSection])

  const save = useCallback((field: keyof OnboardingSettings, value: unknown): void => {
    progress.set(field, value).catch((error: unknown) => { console.warn('delorun onboarding: progress was not saved', error) })
  }, [progress])
  const finish = useCallback((): Promise<unknown> => {
    const saved = Promise.allSettled([progress.set('done', true), progress.set('step', '')])
    complete()
    return saved
  }, [progress, complete])

  // The notice is decided once: acknowledging it must not remove it from under Back.
  const [notice] = useState(() => (!explicit && fixed.notice !== undefined && !fixed.notice.acknowledged() ? fixed.notice : undefined))
  // The notice is on screen in the Welcome step, so setting the guide aside has shown it; the separate notice step must not show it again.
  const finishLater = (): void => { notice?.acknowledge(); later() }
  // The Finish setup entry at the computer shows only the steps a phone deferred; they are read once, so finishing one does not remove it from under the person.
  const [only] = useState<readonly DeferrableStep[] | undefined>(() => (deferredOnly.getSnapshot() ? withSteps(record.deferred ?? []) : undefined))
  const steps = useMemo(
    () => buildSteps({ services, guide, record, extra: addedSteps, reach, phone, deviceAddress, target, notice, keepCurrent, first: !explicit, pinOn, browserAdded: browserIsAdded, ...only === undefined ? {} : { only } }),
    [services, guide, record, addedSteps, reach, phone, deviceAddress, target, notice, keepCurrent, explicit, pinOn, browserIsAdded, only],
  )
  const [index, setIndex] = useState(() => (notice === undefined ? Math.max(0, steps.findIndex(each => each.id === settings.step)) : 0))
  const current = Math.min(index, steps.length - 1)
  // The list is never empty: Welcome and Ready are always built.
  const step = steps[current] as FlowStep
  const providersPhase = useSyncExternalStore(useCallback(listener => guide.providersPhase.subscribe(listener), [guide]), () => guide.providersPhase.getSnapshot())
  const stockScreen = useSyncExternalStore(useCallback(listener => guide.stockScreen.subscribe(listener), [guide]), () => guide.stockScreen.getSnapshot())
  // The providers step's landing and walk have their own buttons; its summary uses the dialog's Continue.
  const ownButtons = (step.id === STEPS.providers.id && providersPhase !== 'summary') || (step.id === STEPS.look.id && stockScreen)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [step.id])

  const go = (to: number): void => {
    setIndex(to)
    // The deferred steps are not the guide's saved place.
    if (only === undefined) save('step', (steps[to] as FlowStep).id)
  }
  const last = current === steps.length - 1
  // With no workspace chosen and none to fall back on, the last button goes back to the Workspace step; a first open has that step only without a default workspace.
  const needsFolder = only === undefined && last && workspace === undefined && target.kind !== 'other' && !(keepCurrent && target.kind === 'default') && steps.some(each => each.id === STEPS.workspace.id)
  const advance = (): void => {
    step.onContinue?.()
    if (!last) {
      go(current + 1)
      return
    }
    // The last deferred step closes the dialog; no chat starts and the guide's progress stays as it was.
    if (only !== undefined) {
      later()
      return
    }
    if (needsFolder) {
      go(steps.findIndex(each => each.id === STEPS.workspace.id))
      return
    }
    const saved = finish()
    completeStep(UPSTREAM_KEY_STEP)
    const started = startChat(workspace?.workspaceId, keepCurrent)
    // The original look unloads this dialog's plugin, so it is written last, after the progress and the first chat.
    if (guide.stock.getSnapshot()) {
      void Promise.allSettled([saved, started]).then(() => fixed.look.useStockLook()).then((ok) => { if (!ok) console.warn('delorun onboarding: the original look was not saved') }, (error: unknown) => { console.warn('delorun onboarding: the original look was not saved', error) })
    }
  }
  // A step with something unfinished (a highlighted folder, an open Add question) holds Continue until it is settled.
  const next = (): void => {
    void guide.passGates().then((open) => { if (open) advance() })
  }
  const onPhone = usePhone()
  const title = step.title()
  // The last step has nothing left to skip, and Welcome offers no Skip while the preview notice is owed.
  const showSkip = !last && (notice === undefined || step.id !== STEPS.welcome.id)
  const footer = ownButtons
    ? null
    : (
      <StepFooter
        {...showSkip ? { skip: { label: step.skipLabel?.() ?? t('skip'), onClick: () => { step.onSkip?.(); go(current + 1) } } } : {}}
        {...current > 0 ? { back: { label: t('back'), onClick: () => { go(current - 1) } } } : {}}
        next={{ label: needsFolder ? t('chooseFolder') : last ? t(only === undefined ? 'start' : 'continue') : step.continueLabel?.() ?? t('continue'), onClick: next }} />
    )
  return (
    <Modal open title={title} onClose={dismiss} headless className={DIALOG_CLASS}>
      <StepFrame title={title} headingRef={heading} count={t('count', { n: String(current + 1), total: String(steps.length) })}
        place={current + 1} total={steps.length} steps={steps.map(each => each.title())} stepsLabel={t('steps')} stepKey={step.id} {...last && only === undefined ? {} : { later: { label: t('later'), onClick: finishLater } }} footer={footer} above={onPhone ? <OnboardingDownloadsRow /> : undefined}>
        {step.render(next, () => { go(current - 1) })}
      </StepFrame>
    </Modal>
  )
}
