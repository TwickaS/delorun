/**
 * The new-workspace dialog: a large modal that walks the flow's screens, with a pinned header, one scrolling body and a
 * pinned footer. It holds the flow's state ({@link reduce}), asks the Host for the places and the studio for the model
 * catalogue, and finishes by adding the chosen folder, making the new one or following the clone to its end, then
 * setting the workspace up ({@link setUpWorkspace}). Closing it never cancels a running clone: the clone keeps running
 * on the Host.
 */
import { IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { browserAdded } from '@delorun/browser-setup'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { BrowserChoice, FolderKind } from '../wire.ts'
import type { NewWorkspaceApi } from './api.ts'
import { createChosen, problemOfFailure, setUpWorkspace, type CreateOptions, type FullAccessAsk, type SetupNote, type SetupPlan } from './create.ts'
import { FooterContext } from './footer.tsx'
import { assertNever, canCreateNow, INITIAL, reduce, STEP_TOTAL, stepNumber, type Choice, type Method, type Step } from './flow.ts'
import { parseHosts } from './hosts.ts'
import type { Translate } from './locales.ts'
import { modelToStore, type ModelCatalogView, type ModelsState } from './models.ts'
import { baseName } from './paths.ts'
import { BrowserScreen, type BrowserFace } from './screens/BrowserScreen.tsx'
import { CloneScreen, type CloneEdit } from './screens/CloneScreen.tsx'
import { DoneScreen } from './screens/DoneScreen.tsx'
import { FolderScreen, type FolderBrowse } from './screens/FolderScreen.tsx'
import { HowScreen, type PlacesState } from './screens/HowScreen.tsx'
import { ModelScreen } from './screens/ModelScreen.tsx'
import { NewFolderScreen } from './screens/NewFolderScreen.tsx'
import { SafetyScreen } from './screens/SafetyScreen.tsx'
import css from './NewWorkspaceDialog.module.css'

/** The workspace the flow made. */
export interface CreatedWorkspace {
  /** The workspace's id as the registry gives it. */
  readonly workspaceId: string
  /** The workspace's folder. */
  readonly path: string
  /** What the folder holds. */
  readonly folder: FolderKind
}

/** The props of the dialog. */
export interface NewWorkspaceDialogProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The Host client. */
  readonly api: NewWorkspaceApi
  /** The studio's folder navigation. */
  readonly browse: FolderBrowse
  /**
   * Read the model catalogue and the home's default model.
   * @returns the catalogue, or undefined when it cannot be read.
   */
  readonly readModels: () => Promise<ModelCatalogView | undefined>
  /** The Full access consent, asked when the person chose Full access. */
  readonly fullAccess: FullAccessAsk
  /** Whether Browser is ready and the Settings opener, for the browser screen. */
  readonly browser: BrowserFace
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
  readonly phase: 'starting' | 'creating' | 'cloning' | 'setup'
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
    case 'browser': return t('title.screen', { screen: t('screen.browser') })
    case 'model': return t('title.screen', { screen: t('screen.model') })
    case 'safety': return t('title.screen', { screen: t('screen.safety') })
    default: return assertNever(step)
  }
}

/**
 * The dialog.
 * @param props - the copy, the services and what closing and finishing do.
 * @returns the dialog.
 */
export function NewWorkspaceDialog({ t, api, browse, readModels, fullAccess, browser, from, onClose, onCreated, wait, now = Date.now }: NewWorkspaceDialogProps): ReactNode {
  const [state, dispatch] = useReducer(reduce, INITIAL)
  const [places, setPlaces] = useState<PlacesState>({ status: 'loading' })
  const [running, setRunning] = useState<Running | undefined>()
  const [models, setModels] = useState<ModelsState>({ status: 'loading' })
  const [done, setDone] = useState<{ readonly workspace: CreatedWorkspace, readonly notes: readonly SetupNote[] } | undefined>()
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

  /** The catalogue read, which finishing waits for so the workspace keeps the model it showed. */
  const catalogRead = useRef<Promise<ModelCatalogView | undefined>>(Promise.resolve(undefined))
  useEffect(() => {
    const read = readModels()
    catalogRead.current = read
    void read.then((catalog) => {
      if (lifetime.current?.signal.aborted !== false) return
      setModels(catalog === undefined ? { status: 'unavailable' } : { status: 'ready', catalog })
    })
  }, [readModels])

  const ready = places.status === 'ready' ? places.places : undefined
  const readiness = useSyncExternalStore(browser.setup.subscribe, browser.setup.getSnapshot)
  /** The person's pick; until then the choice follows whether Browser is on in the home as it is read. */
  const browserChoice: BrowserChoice = state.browser ?? (browserAdded(readiness) ? 'isolated' : 'none')

  /**
   * What setting the workspace up stores and asks, from the choices made so far.
   * @returns the plan; the model is the catalogue's choice once it has been read.
   */
  const planOf = async (): Promise<SetupPlan> => {
    const { access, hosts, permission } = state.safety
    const parsed = parseHosts(hosts)
    return {
      model: modelToStore(await catalogRead.current, state.model),
      browser: browserChoice,
      permission,
      network: { access, hosts: access === 'allowlist' && 'hosts' in parsed ? [...parsed.hosts] : [] },
    }
  }

  /**
   * Finish the flow for a choice and report how it came out.
   * @param choice - what was chosen; a clone has its job.
   * @param setUp - whether to set the workspace up from the screens' choices; false for a recent workspace, which keeps what it has.
   */
  const finish = async (choice: Choice, setUp: boolean): Promise<void> => {
    const name = nameOf(choice)
    setRunning({ phase: choice.kind === 'clone' ? 'cloning' : 'creating', name })
    dispatch({ type: 'problem', problem: undefined })
    const signal = lifetime.current?.signal
    const result = await createChosen(api, choice, (percent) => { if (alive()) setRunning({ phase: 'cloning', name, percent }) }, {
      ...signal === undefined ? {} : { signal }, ...wait === undefined ? {} : { wait },
    })
    if (!alive()) return
    if (result.ok) {
      const workspace = { workspaceId: result.workspaceId, path: result.path, folder: result.folder }
      if (!setUp) {
        onCreated(workspace)
        return
      }
      setRunning({ phase: 'setup', name })
      const notes = await setUpWorkspace(api, result.path, await planOf(), fullAccess)
      if (!alive()) return
      if (notes.length === 0) {
        onCreated(workspace)
        return
      }
      setRunning(undefined)
      setDone({ workspace, notes })
      return
    }
    setRunning(undefined)
    if ('cancelled' in result) return
    if (result.problem.kind === 'clone-failed') dispatch({ type: 'clone-failed', failure: result.problem.failure })
    else dispatch({ type: 'finish-failed', problem: result.problem })
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
      setRunning(undefined)
      dispatch({ type: 'clone-started', job: started.value.job })
      dispatch({ type: 'continue' })
    }
  }

  const note = running === undefined ? undefined
    : running.phase === 'starting' ? t('clone.starting')
      : running.phase === 'creating' ? t('creating')
        : running.phase === 'setup' ? t('setup.working')
        : running.percent === undefined ? t('clone.progressUnknown', { name: running.name }) : t('clone.progress', { name: running.name, percent: running.percent })
  const target = useMemo(() => ({ element: footer, note }), [footer, note])
  const busy = running !== undefined
  const { choice, step, picking, problem } = state
  const heading = headingOf(t, step, picking !== undefined)
  const home = ready?.home ?? ''
  /** Create the workspace with the choices made so far; the safe ones when a screen was not visited. */
  const createNow = (): void => { if (choice !== undefined) void finish(choice, true) }

  let screen: ReactNode = null
  switch (step) {
    case 'how':
      screen = (
        <HowScreen t={t} places={places} method={state.method} busy={busy} problem={problem} now={now()}
          onMethod={(method: Method) => { dispatch({ type: 'method', method, parent: ready?.defaultParent ?? '' }) }}
          onContinue={() => { dispatch({ type: 'continue' }) }}
          onRecent={(path) => { dispatch({ type: 'existing', path }); void finish({ kind: 'existing', path }, false) }}
          onRetry={loadPlaces} onCancel={onClose} />
      )
      break
    case 'folder':
      screen = (
        <FolderScreen t={t} api={api} browse={browse} home={home} suggested={ready?.suggested ?? []}
          startPath={picking === undefined || choice === undefined || choice.kind === 'existing' ? undefined : choice.parent}
          picking={picking !== undefined} busy={busy} problem={problem} onBack={() => { dispatch({ type: 'back' }) }}
          onUse={(path) => {
            if (picking === undefined) { dispatch({ type: 'existing', path }); dispatch({ type: 'continue' }) } else dispatch({ type: 'place-picked', path })
          }} />
      )
      break
    case 'new-folder':
      if (choice?.kind === 'new') {
        screen = (
          <NewFolderScreen t={t} home={home} choice={choice} busy={busy} problem={problem}
            onEdit={(change) => { dispatch({ type: 'edit-new', change }) }} onChangePlace={() => { dispatch({ type: 'pick-place' }) }}
            onSubmit={() => { dispatch({ type: 'continue' }) }} onBack={() => { dispatch({ type: 'back' }) }} />
        )
      }
      break
    case 'clone':
      if (choice?.kind === 'clone') {
        screen = (
          <CloneScreen t={t} home={home} choice={choice} busy={busy} problem={problem}
            onEdit={(change: CloneEdit) => { dispatch({ type: 'edit-clone', change }) }} onChangePlace={() => { dispatch({ type: 'pick-place' }) }}
            onSubmit={() => { if (choice.job === undefined) void startClone(choice); else dispatch({ type: 'continue' }) }} onBack={() => { dispatch({ type: 'back' }) }} />
        )
      }
      break
    case 'browser':
      screen = (
        <BrowserScreen t={t} browser={browser} choice={browserChoice} busy={busy} problem={problem} canCreateNow={canCreateNow(state)}
          onChoice={(next) => { dispatch({ type: 'browser', choice: next }) }} onContinue={() => { dispatch({ type: 'continue' }) }}
          onCreateNow={createNow} onBack={() => { dispatch({ type: 'back' }) }} />
      )
      break
    case 'model':
      screen = (
        <ModelScreen t={t} models={models} pick={state.model} busy={busy} problem={problem} canCreateNow={canCreateNow(state)}
          onPick={(pick) => { dispatch({ type: 'model', pick }) }} onContinue={() => { dispatch({ type: 'continue' }) }}
          onCreateNow={createNow} onBack={() => { dispatch({ type: 'back' }) }} />
      )
      break
    case 'safety':
      screen = (
        <SafetyScreen t={t} safety={state.safety} busy={busy} problem={problem}
          onChange={(change) => { dispatch({ type: 'safety', change }) }} onCreate={createNow} onBack={() => { dispatch({ type: 'back' }) }} />
      )
      break
    default: assertNever(step)
  }
  if (done !== undefined) screen = <DoneScreen t={t} notes={done.notes} onOpen={() => { onCreated(done.workspace) }} />
  // The workspace exists once the done view shows, so closing it opens the workspace rather than dropping it.
  const close = done === undefined ? onClose : () => { onCreated(done.workspace) }

  return (
    <Modal open title={heading} onClose={close} headless className={css.dialog as string}>
      <FooterContext.Provider value={target}>
        <div className={css.frame} data-from={from}>
          <header className={css.header}>
            <h2 className={css.heading}>{heading}</h2>
            <span className={css.count}>{t('step', { n: stepNumber(step), total: STEP_TOTAL })}</span>
            <button type="button" className={css.close} aria-label={t('close')} onClick={close}><IconCloseOutlineRegular size={16} /></button>
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
