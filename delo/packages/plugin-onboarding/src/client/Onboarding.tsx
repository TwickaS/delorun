/**
 * The onboarding dialog in upstream's `settings.onboarding` seat: a modal over the studio with the steps listed at its
 * left (a progress count on a phone), the current step at its right and Back, Continue and Skip under it. It shows on a
 * profile that has not finished onboarding, or whenever Settings opens it explicitly, and finishing or skipping is kept
 * on the profile. The dialog owns the page's inert root while it shows, as upstream's steps do.
 */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { OnboardingSettings } from '../config.ts'
import type { SetupRecord } from '../wire.ts'
import { buildSteps, STEPS, type FlowStep } from './flow.tsx'
import { landFocus } from './focus.ts'
import type { FolderView, StartFolder } from './steps.tsx'
import type { FolderChoice, OnboardingInjected, StepServices } from './types.ts'
import css from './Onboarding.module.css'

/** The entry's props: the owner props it reads, this plugin's copy and the dialog's services. */
export type OnboardingStepEntryProps = Pick<PropsRuntime<'settings.onboarding'>, 'complete' | 'explicit'> & PropsLocale<'deloOnboarding'> & InjectFace<OnboardingInjected>

/** The dialog is closed by its buttons only, so Escape and the mask do nothing. */
const ignoreImplicitDismiss = (): void => {}

/** The Start step before any folder choice. */
const IDLE: FolderView = { kind: 'idle' }

/** The Start step showing its own chooser. */
const BROWSE: FolderView = { kind: 'browse' }

/**
 * Show the dialog while onboarding is unfinished or was opened explicitly, and complete upstream's step otherwise.
 * @param props - upstream's owner props, this plugin's copy and the services.
 * @returns the dialog, or nothing.
 */
export function OnboardingStepEntry(props: OnboardingStepEntryProps): ReactNode {
  const { progress, complete, explicit = false } = props
  const snapshot = useSyncExternalStore(useCallback(listener => progress.subscribe(listener), [progress]), () => progress.getSnapshot())
  const settings = snapshot.status === 'ready' ? snapshot.value : undefined
  const show = settings !== undefined && (!settings.done || explicit)
  const decided = snapshot.status !== 'loading'
  // A finished profile, or one whose progress cannot be read, lets upstream's flow go on at once.
  useEffect(() => { if (decided && !show) complete() }, [decided, show, complete])
  return show ? <Dialog {...props} settings={settings} explicit={explicit} /> : null
}

/** Whether the Start step told the person there is no default workspace; the flow sets it. */
interface Told { current: boolean }

/**
 * Keep the workspace UI's default-workspace notice back while the dialog shows. On close the notice is dropped when the
 * Start step told the person there is no default workspace, and shows otherwise.
 * @param start - the Start step's workspace face.
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

/** Load what the terminal setup recorded, then show the flow. */
function Dialog(props: OnboardingStepEntryProps & { readonly settings: OnboardingSettings; readonly explicit: boolean }): ReactNode {
  const { loadRecord } = props
  const told = useNoticeHold(props.services.start)
  const [record, setRecord] = useState<SetupRecord | undefined>()
  useEffect(() => {
    let live = true
    void loadRecord().then((loaded) => { if (live) setRecord(loaded) })
    return () => { live = false }
  }, [loadRecord])
  return record === undefined ? null : <Flow {...props} record={record} told={told} />
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
function Flow(props: OnboardingStepEntryProps & { readonly settings: OnboardingSettings; readonly explicit: boolean; readonly record: SetupRecord; readonly told: Told }): ReactNode {
  const { t, progress, extra, services: fixed, startChat, complete, settings, explicit, record, told } = props
  const { reach: reachFace, start } = fixed
  useInertRoot()
  const addedSteps = useSyncExternalStore(useCallback(listener => extra.subscribe(listener), [extra]), () => extra.getSnapshot())
  const reach = useSyncExternalStore(reachFace.subscribe, reachFace.getSnapshot)
  const target = useSyncExternalStore(start.target.subscribe, start.target.getSnapshot)
  const [choosing, setChoosing] = useState(false)
  const [folder, setFolder] = useState<FolderView>(IDLE)
  // The default workspace is looked up when the dialog opens, so the Start step already knows what its button does.
  useEffect(() => { start.resolve() }, [start])
  const { plugins } = settings
  const services = useMemo<StepServices>(() => ({ ...fixed, t, plugins }), [fixed, t, plugins])

  const save = useCallback((field: keyof OnboardingSettings, value: unknown): void => {
    progress.set(field, value).catch((error: unknown) => { console.warn('delo onboarding: progress was not saved', error) })
  }, [progress])
  const finish = useCallback((): void => {
    save('done', true)
    save('step', '')
    complete()
  }, [save, complete])
  const added = useCallback((workspaceId: WorkspaceId): void => {
    finish()
    void startChat(workspaceId)
  }, [finish, startChat])
  const startFolder = useMemo<StartFolder>(() => ({ view: folder, added }), [folder, added])

  // The notice screen is decided once: acknowledging it must not remove it from under Back.
  const [notice] = useState(() => (!explicit && fixed.notice !== undefined && !fixed.notice.acknowledged() ? fixed.notice : undefined))
  const steps = useMemo(
    () => buildSteps({ services, record, extra: addedSteps, reach, notice, folder: startFolder }),
    [services, record, addedSteps, reach, notice, startFolder],
  )
  const [index, setIndex] = useState(() => (notice === undefined ? Math.max(0, steps.findIndex(each => each.id === settings.step)) : 0))
  const current = Math.min(index, steps.length - 1)
  // The list is never empty: the last step is always built.
  const step = steps[current] as FlowStep
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [step.id])

  const go = (target: number): void => {
    setIndex(target)
    setFolder(IDLE)
    save('step', (steps[target] as FlowStep).id)
  }
  const last = current === steps.length - 1
  // Without a default workspace the last button chooses a folder first, and a closed chooser keeps the dialog open.
  const choosesFolder = last && target.kind === 'none'
  useEffect(() => { if (choosesFolder) told.current = true }, [choosesFolder, told])
  const settle = (choice: FolderChoice): void => {
    switch (choice.kind) {
      case 'cancelled':
        return
      case 'chosen':
        added(choice.workspaceId)
        return
      case 'in-step':
        setFolder(BROWSE)
        return
      case 'refused':
        setFolder({ kind: 'problem', problem: choice.problem })
        return
      case 'failed':
        setFolder({ kind: 'problem', problem: 'failed' })
        return
      case 'unavailable':
        finish()
        void startChat()
        return
      /* v8 ignore next 2 -- closed-union default only defends a future widening of FolderChoice */
      default:
        assertNever(choice)
    }
  }
  const next = (): void => {
    step.onContinue?.()
    if (!last) {
      go(current + 1)
      return
    }
    if (!choosesFolder) {
      finish()
      void startChat()
      return
    }
    setChoosing(true)
    setFolder(IDLE)
    void start.chooseFolder().then((choice) => {
      setChoosing(false)
      settle(choice)
    })
  }
  const title = (step.heading ?? step.title)()
  // While the Start step shows its own chooser, that chooser's button adds the folder.
  const primary = !(choosesFolder && folder.kind === 'browse')
  return (
    <Modal open title={title} onClose={ignoreImplicitDismiss} headless className={css.dialog as string}>
      <div className={css.frame}>
        <nav className={css.rail} aria-label={t('steps')}>
          <ol className={css.stepList}>
            {steps.map((each, position) => (
              <li key={each.id} className={css.stepItem} data-state={position < current ? 'done' : position === current ? 'current' : 'next'}
                aria-current={position === current ? 'step' : undefined}>
                <span className={css.stepDot} aria-hidden="true">{position < current ? '✓' : String(position + 1)}</span>
                <span>{each.title()}</span>
              </li>
            ))}
          </ol>
        </nav>
        <div className={css.main}>
          <div className={css.progress}>
            <span className={css.count}>{t('count', { n: String(current + 1), total: String(steps.length) })}</span>
            <span className={css.bar} aria-hidden="true"><span style={{ width: `${String(((current + 1) / steps.length) * 100)}%` }} /></span>
          </div>
          <div className={css.scroll}>
            <h2 ref={heading} tabIndex={-1} data-modal-autofocus className={css.heading}>{title}</h2>
            <div className={css.body} key={step.id}>{step.render(next)}</div>
          </div>
          <footer className={css.footer}>
            {step.id !== STEPS.notice.id && <Button variant="ghost" className={css.skip} onClick={finish}>{t('skip')}</Button>}
            <span className={css.spacer} />
            {current > 0 && <Button variant="ghost" onClick={() => { go(current - 1) }}>{t('back')}</Button>}
            {primary && <Button variant="primary" disabled={choosing} onClick={next}>{t(choosesFolder ? 'chooseFolder' : last ? 'start' : 'continue')}</Button>}
          </footer>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when FolderChoice widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled folder choice ${JSON.stringify(value)}`)
}
