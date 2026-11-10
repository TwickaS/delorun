/**
 * The onboarding dialog in upstream's `settings.onboarding` seat: a modal over the studio with the steps listed at its
 * left (a progress count on a phone), the current step at its right and Back, Continue and Skip under it. It shows on a
 * profile that has not finished onboarding, or whenever Settings opens it explicitly, and finishing or skipping is kept
 * on the profile. The dialog owns the page's inert root while it shows, as upstream's steps do.
 */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { OnboardingSettings } from '../config.ts'
import type { SetupRecord } from '../wire.ts'
import { buildSteps, STEPS, type FlowStep } from './flow.tsx'
import type { OnboardingInjected, StepServices } from './types.ts'
import css from './Onboarding.module.css'

/** The entry's props: the owner props it reads, this plugin's copy and the dialog's services. */
export type OnboardingStepEntryProps = Pick<PropsRuntime<'settings.onboarding'>, 'complete' | 'explicit'> & PropsLocale<'deloOnboarding'> & InjectFace<OnboardingInjected>

/** The dialog is closed by its buttons only, so Escape and the mask do nothing. */
const ignoreImplicitDismiss = (): void => {}

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

/** Load what the terminal setup recorded, then show the flow. */
function Dialog(props: OnboardingStepEntryProps & { readonly settings: OnboardingSettings; readonly explicit: boolean }): ReactNode {
  const { loadRecord } = props
  const [record, setRecord] = useState<SetupRecord | undefined>()
  useEffect(() => {
    let live = true
    void loadRecord().then((loaded) => { if (live) setRecord(loaded) })
    return () => { live = false }
  }, [loadRecord])
  return record === undefined ? null : <Flow {...props} record={record} />
}

/** Keep the page's root inert behind the dialog. */
function useInertRoot(): void {
  useEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const previous = appRoot.inert
    appRoot.inert = true
    return () => { appRoot.inert = previous }
  }, [])
}

/** The steps, the current one and the buttons. */
function Flow(props: OnboardingStepEntryProps & { readonly settings: OnboardingSettings; readonly explicit: boolean; readonly record: SetupRecord }): ReactNode {
  const { t, progress, extra, services: fixed, startChat, complete, settings, explicit, record } = props
  const { reach: reachFace, start } = fixed
  useInertRoot()
  const added = useSyncExternalStore(useCallback(listener => extra.subscribe(listener), [extra]), () => extra.getSnapshot())
  const reach = useSyncExternalStore(reachFace.subscribe, reachFace.getSnapshot)
  const target = useSyncExternalStore(start.target.subscribe, start.target.getSnapshot)
  const [choosing, setChoosing] = useState(false)
  // The default workspace is looked up when the dialog opens, so the Start step already knows what its button does.
  useEffect(() => { start.resolve() }, [start])
  const { plugins } = settings
  const services = useMemo<StepServices>(() => ({ ...fixed, t, plugins }), [fixed, t, plugins])
  // The notice screen is decided once: acknowledging it must not remove it from under Back.
  const [notice] = useState(() => (!explicit && fixed.notice !== undefined && !fixed.notice.acknowledged() ? fixed.notice : undefined))
  const steps = useMemo(() => buildSteps({ services, record, extra: added, reach, notice }), [services, record, added, reach, notice])
  const [index, setIndex] = useState(() => (notice === undefined ? Math.max(0, steps.findIndex(each => each.id === settings.step)) : 0))
  const current = Math.min(index, steps.length - 1)
  // The list is never empty: the last step is always built.
  const step = steps[current] as FlowStep
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [step.id])

  const save = (field: keyof OnboardingSettings, value: unknown): void => {
    progress.set(field, value).catch((error: unknown) => { console.warn('delo onboarding: progress was not saved', error) })
  }
  const go = (target: number): void => {
    setIndex(target)
    save('step', (steps[target] as FlowStep).id)
  }
  const finish = (): void => {
    save('done', true)
    save('step', '')
    complete()
  }
  const last = current === steps.length - 1
  // Without a default workspace the last button chooses a folder first, and a closed chooser keeps the dialog open.
  const choosesFolder = last && target.kind === 'none'
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
    void start.chooseFolder().then((choice) => {
      setChoosing(false)
      if (choice.kind === 'cancelled') return
      finish()
      if (choice.kind === 'in-page') start.openInPage()
      else void startChat(choice.kind === 'chosen' ? choice.workspaceId : undefined)
    })
  }
  const title = (step.heading ?? step.title)()
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
            <Button variant="primary" disabled={choosing} onClick={next}>{t(choosesFolder ? 'chooseFolder' : last ? 'start' : 'continue')}</Button>
          </footer>
        </div>
      </div>
    </Modal>
  )
}
