/**
 * The new-workspace dialog: a large modal that walks the flow's screens, with a pinned header, one scrolling body and a
 * pinned footer. It holds the flow's state ({@link reduce}), asks the Host for the places, and finishes by adding the
 * chosen folder, making the new one or following the clone to its end. Closing it never cancels a running clone: the
 * clone keeps running on the Host.
 */
import { IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { NewWorkspaceApi } from './api.ts'
import { createChosen, problemOfFailure, type CreateOptions } from './create.ts'
import { FooterContext } from './footer.tsx'
import { assertNever, INITIAL, reduce, STEP_TOTAL, stepNumber, type Choice, type Method, type Step } from './flow.ts'
import type { Translate } from './locales.ts'
import { baseName } from './paths.ts'
import { CloneScreen, type CloneEdit } from './screens/CloneScreen.tsx'
import { FolderScreen, type FolderBrowse } from './screens/FolderScreen.tsx'
import { HowScreen, type PlacesState } from './screens/HowScreen.tsx'
import { NewFolderScreen } from './screens/NewFolderScreen.tsx'
import css from './NewWorkspaceDialog.module.css'

/** The workspace the flow made. */
export interface CreatedWorkspace {
  /** The workspace's id as the registry gives it. */
  readonly workspaceId: string
  /** The workspace's folder. */
  readonly path: string
}

/** The props of the dialog. */
export interface NewWorkspaceDialogProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The Host client. */
  readonly api: NewWorkspaceApi
  /** The studio's folder navigation. */
  readonly browse: FolderBrowse
  /** The surface that opened the flow, kept on the dialog as `data-from`. */
  readonly from: string
  /** Called when the person closes the dialog. */
  readonly onClose: () => void
  /**
   * Called when the workspace was made.
   * @param created - the workspace.
   */
  readonly onCreated: (created: CreatedWorkspace) => void
  /** Waits between two reads of a running clone; the timer when absent. */
  readonly wait?: CreateOptions['wait']
  /** The current time in milliseconds; the clock when absent. */
  readonly now?: () => number
}

/** What the footer's left side says while the flow works. */
interface Running {
  readonly phase: 'starting' | 'creating' | 'cloning'
  readonly name: string
  readonly percent?: number | undefined
}

/**
 * The name the dialog calls what is being made.
 * @param choice - what was chosen.
 * @returns the folder's name.
 */
function nameOf(choice: Choice): string {
  return choice.kind === 'existing' ? baseName(choice.path) : choice.name
}

/**
 * The screen's name in the header.
 * @param t - this plugin's copy.
 * @param step - the step on show.
 * @param picking - whether the folder step picks a place.
 * @returns the dialog's heading.
 */
function headingOf(t: Translate, step: Step, picking: boolean): string {
  switch (step) {
    case 'how': return t('title')
    case 'folder': return t('title.screen', { screen: t(picking ? 'screen.place' : 'screen.folder') })
    case 'new-folder': return t('title.screen', { screen: t('screen.newFolder') })
    case 'clone': return t('title.screen', { screen: t('screen.clone') })
    default: return assertNever(step)
  }
}

/**
 * The dialog.
 * @param props - the copy, the services and what closing and finishing do.
 * @returns the dialog.
 */
export function NewWorkspaceDialog({ t, api, browse, from, onClose, onCreated, wait, now = Date.now }: NewWorkspaceDialogProps): ReactNode {
  const [state, dispatch] = useReducer(reduce, INITIAL)
  const [places, setPlaces] = useState<PlacesState>({ status: 'loading' })
  const [running, setRunning] = useState<Running | undefined>()
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  /** Aborted when the dialog closes, which stops a clone being followed and ignores late answers. */
  const lifetime = useRef<AbortController | undefined>(undefined)
  const alive = (): boolean => lifetime.current?.signal.aborted === false

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => { controller.abort() }
  }, [])

  const loadPlaces = useCallback(() => {
    setPlaces({ status: 'loading' })
    void api.places().then((result) => {
      if (lifetime.current?.signal.aborted !== false) return
      setPlaces(result.ok ? { status: 'ready', places: result.value } : { status: 'failed', problem: problemOfFailure(result.reason) })
    })
  }, [api])
  useEffect(() => { loadPlaces() }, [loadPlaces])

  const ready = places.status === 'ready' ? places.places : undefined

  /**
   * Finish the flow for a choice and report how it came out.
   * @param choice - what was chosen; a clone has its job.
   */
  const finish = async (choice: Choice): Promise<void> => {
    const name = nameOf(choice)
    setRunning({ phase: choice.kind === 'clone' ? 'cloning' : 'creating', name })
    dispatch({ type: 'problem', problem: undefined })
    const signal = lifetime.current?.signal
    const result = await createChosen(api, choice, (percent) => { if (alive()) setRunning({ phase: 'cloning', name, percent }) }, {
      ...signal === undefined ? {} : { signal }, ...wait === undefined ? {} : { wait },
    })
    if (!alive()) return
    if (result.ok) {
      onCreated({ workspaceId: result.workspaceId, path: result.path })
      return
    }
    setRunning(undefined)
    if ('cancelled' in result) return
    if (result.problem.kind === 'clone-failed') dispatch({ type: 'clone-failed', failure: result.problem.failure })
    else dispatch({ type: 'problem', problem: result.problem })
  }

  /** Start the clone chosen on the clone screen, then follow it to the end. */
  const startClone = async (choice: Extract<Choice, { kind: 'clone' }>): Promise<void> => {
    setRunning({ phase: 'starting', name: choice.name })
    dispatch({ type: 'problem', problem: undefined })
    const started = await api.clone({ url: choice.url, parent: choice.parent, name: choice.name, ...choice.branch === '' ? {} : { branch: choice.branch } })
    if (!alive()) return
    if (!started.ok) {
      setRunning(undefined)
      dispatch({ type: 'problem', problem: problemOfFailure(started.reason) })
    } else if (started.value.result === 'refused') {
      setRunning(undefined)
      dispatch({ type: 'problem', problem: { kind: 'clone', problem: started.value.problem } })
    } else {
      dispatch({ type: 'clone-started', job: started.value.job })
      await finish({ ...choice, job: started.value.job })
    }
  }

  const note = running === undefined ? undefined
    : running.phase === 'starting' ? t('clone.starting')
      : running.phase === 'creating' ? t('creating')
        : running.percent === undefined ? t('clone.progressUnknown', { name: running.name }) : t('clone.progress', { name: running.name, percent: running.percent })
  const target = useMemo(() => ({ element: footer, note }), [footer, note])
  const busy = running !== undefined
  const { choice, step, picking, problem } = state
  const heading = headingOf(t, step, picking !== undefined)
  const home = ready?.home ?? ''

  let screen: ReactNode = null
  switch (step) {
    case 'how':
      screen = (
        <HowScreen t={t} places={places} method={state.method} busy={busy} problem={problem} now={now()}
          onMethod={(method: Method) => { dispatch({ type: 'method', method, parent: ready?.defaultParent ?? '' }) }}
          onContinue={() => { dispatch({ type: 'continue' }) }}
          onRecent={(path) => { dispatch({ type: 'existing', path }); void finish({ kind: 'existing', path }) }}
          onRetry={loadPlaces} onCancel={onClose} />
      )
      break
    case 'folder':
      screen = (
        <FolderScreen t={t} api={api} browse={browse} home={home} suggested={ready?.suggested ?? []}
          startPath={picking === undefined || choice === undefined || choice.kind === 'existing' ? undefined : choice.parent}
          picking={picking !== undefined} busy={busy} problem={problem} onBack={() => { dispatch({ type: 'back' }) }}
          onUse={(path) => {
            if (picking === undefined) { dispatch({ type: 'existing', path }); void finish({ kind: 'existing', path }) } else dispatch({ type: 'place-picked', path })
          }} />
      )
      break
    case 'new-folder':
      if (choice?.kind === 'new') {
        screen = (
          <NewFolderScreen t={t} home={home} choice={choice} busy={busy} problem={problem}
            onEdit={(change) => { dispatch({ type: 'edit-new', change }) }} onChangePlace={() => { dispatch({ type: 'pick-place' }) }}
            onSubmit={() => { void finish(choice) }} onBack={() => { dispatch({ type: 'back' }) }} />
        )
      }
      break
    case 'clone':
      if (choice?.kind === 'clone') {
        screen = (
          <CloneScreen t={t} home={home} choice={choice} busy={busy} problem={problem}
            onEdit={(change: CloneEdit) => { dispatch({ type: 'edit-clone', change }) }} onChangePlace={() => { dispatch({ type: 'pick-place' }) }}
            onSubmit={() => { void startClone(choice) }} onBack={() => { dispatch({ type: 'back' }) }} />
        )
      }
      break
    default: assertNever(step)
  }

  return (
    <Modal open title={heading} onClose={onClose} headless className={css.dialog as string}>
      <FooterContext.Provider value={target}>
        <div className={css.frame} data-from={from}>
          <header className={css.header}>
            <h2 className={css.heading}>{heading}</h2>
            <span className={css.count}>{t('step', { n: stepNumber(step), total: STEP_TOTAL })}</span>
            <button type="button" className={css.close} aria-label={t('close')} onClick={onClose}><IconCloseOutlineRegular size={16} /></button>
          </header>
          <div className={css.scroll} key={`${step}-${String(picking)}`}>
            <div className={css.body}>{screen}</div>
          </div>
          <footer className={css.footer} ref={setFooter} />
        </div>
      </FooterContext.Provider>
    </Modal>
  )
}
