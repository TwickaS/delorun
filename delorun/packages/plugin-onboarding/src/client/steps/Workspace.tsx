/**
 * The Workspace step: where the first chat opens. The default workspace when Delorun has one, a folder on this computer
 * the person chooses or creates, or a repository cloned from Git into a new folder. A clone runs in the harness as the
 * person, never asks for a sign-in, and shows its progress and, when it fails, why.
 */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { isCloneAddress, isFolderName, suggestedName } from '@delorun/plugin-new-workspace/clone-address'
import type { CloneProblem } from '../../wire.ts'
import { Card } from '../ui/Card.tsx'
import { ChipGroup } from '@delorun/brand'
import { StateLine } from '../ui/StateLine.tsx'
import { Explain } from '../ui/Explain.tsx'
import { FolderChooser, problemText, type FolderProblem } from '../FolderChooser.tsx'
import type { CloneView, Store, WorkspaceMode } from '../guide.ts'
import type { StepProps } from './shared.ts'
import type { FolderChoice, StartTarget, StepServices } from '../types.ts'
import css from './steps.module.css'

/**
 * @param store - a store.
 * @returns its current value, re-rendering on change.
 */
function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(useCallback(listener => store.subscribe(listener), [store]), () => store.getSnapshot())
}

/** The kinds of folder the default workspace's explanation gives as examples. */
const WORKSPACE_KINDS = ['code', 'files', 'empty'] as const

/** The location problems a clone shares with adding a folder; the rest have their own copy. */
const CLONE_ONLY: ReadonlySet<CloneProblem> = new Set(['url-form', 'url-credentials', 'name-form', 'not-empty', 'busy'])

/**
 * The sentence that says why a clone did not start.
 * @param t - this plugin's copy.
 * @param problem - why it was refused.
 * @returns the sentence.
 */
export function cloneProblemText(t: StepServices['t'], problem: CloneProblem): string {
  return CLONE_ONLY.has(problem) ? t(`clone.problem.${problem as 'url-form' | 'url-credentials' | 'name-form' | 'not-empty' | 'busy'}`) : problemText(t, problem as FolderProblem)
}

/**
 * The folder the first chat opens in, once one is chosen, with what it holds.
 * @param props - the services and the guide.
 * @returns the line, or nothing.
 */
function Chosen({ services, guide, focus = false }: StepProps & { readonly focus?: boolean }): ReactNode {
  const { t } = services
  const workspace = useStore(guide.workspace)
  if (workspace?.kind !== 'added') return null
  return <FolderCard path={workspace.path} note={t(`workspace.kind.${workspace.folder}`)} t={t} focus={focus} />
}

/**
 * The chosen folder as a card: its name once, then its path, then a plain description of what it holds. It names no
 * state; the choice is the state.
 * @param props - the path, the description, an optional name for a folder without one, whether the card takes focus when it appears and this plugin's copy.
 * @returns the card.
 */
function FolderCard({ path, note, name: given, focus = false, t }: { readonly path: string; readonly note?: string; readonly name?: string; readonly focus?: boolean; readonly t: StepServices['t'] }): ReactNode {
  const name = given ?? path.split(/[\\/]/).filter(part => part !== '').pop() ?? path
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focus) box.current?.focus({ preventScroll: true }) }, [focus])
  return (
    <div ref={box} tabIndex={-1} className={css.focusable}>
      <Card title={name} labels={{ more: t('more'), less: t('less') }}>
        <span className={css.path}>{path}</span>
        {note !== undefined && <span className={css.hint}>{note}</span>}
      </Card>
    </div>
  )
}

/** What the folder choice shows below its button. */
type FolderView = { readonly kind: 'idle' } | { readonly kind: 'browse' } | { readonly kind: 'problem'; readonly problem: FolderProblem } | { readonly kind: 'unavailable' }

/**
 * A folder on this computer: the host's own chooser where it has one, else this step's, which also creates a folder.
 * @param props - the services and the guide.
 * @returns the choice.
 */
function FolderMode({ services, guide }: StepProps): ReactNode {
  const { t, start } = services
  const [view, setView] = useState<FolderView>({ kind: 'idle' })
  const [choosing, setChoosing] = useState(false)
  // Set once the person adds a folder, so the chosen-folder card takes focus when it appears.
  const [added, setAdded] = useState(false)
  const settle = (choice: FolderChoice): void => {
    switch (choice.kind) {
      case 'cancelled': return
      case 'chosen':
        setView({ kind: 'idle' })
        setAdded(true)
        guide.chooseWorkspace({ kind: 'added', workspaceId: choice.workspaceId, path: choice.path, folder: choice.folder })
        return
      case 'in-step': setView({ kind: 'browse' }); return
      case 'refused': setView({ kind: 'problem', problem: choice.problem }); return
      case 'failed': setView({ kind: 'problem', problem: 'failed' }); return
      case 'unavailable': setView({ kind: 'unavailable' }); return
      /* v8 ignore next 2 -- closed-union default only defends a future widening of FolderChoice */
      default: assertNever(choice)
    }
  }
  const choose = (): void => {
    setChoosing(true)
    void start.chooseFolder().then((choice) => {
      setChoosing(false)
      settle(choice)
    })
  }
  return (
    <div className={css.stack}>
      <Chosen services={services} guide={guide} focus={added} />
      {view.kind !== 'browse' && (
        <Button variant="outline" size="sm" className={`${css.alignStart} ${css.inline}`} disabled={choosing} onClick={choose}>{t('workspace.folder.choose')}</Button>
      )}
      {view.kind === 'problem' && <StateLine tone="error">{problemText(t, view.problem)}</StateLine>}
      {view.kind === 'unavailable' && <p className={css.hint}>{t('workspace.folder.unavailable')}</p>}
      {view.kind === 'browse' && (
        <FolderChooser services={services} onHold={(gate) => { guide.setGate('folder', gate) }} onAdded={(folder) => {
          setView({ kind: 'idle' })
          setAdded(true)
          guide.chooseWorkspace({ kind: 'added', workspaceId: folder.workspaceId, path: folder.path, folder: folder.folder })
        }} />
      )}
    </div>
  )
}

/**
 * Where a clone stands, read aloud as it changes.
 * @param props - the clone and this plugin's copy.
 * @returns the line.
 */
function CloneProgress({ clone, t }: { readonly clone: CloneView; readonly t: StepServices['t'] }): ReactNode {
  switch (clone.state) {
    case 'idle': return null
    case 'starting': return <StateLine tone="loading">{t('clone.starting')}</StateLine>
    case 'running':
      return (
        <div className={css.cloneProgress}>
          <span className={css.status}>{clone.percent === undefined ? t('clone.running') : t('clone.percent', { percent: String(clone.percent) })}</span>
          <progress className={css.meter} max={100} {...clone.percent === undefined ? {} : { value: clone.percent }} aria-label={t('clone.running')} />
        </div>
      )
    case 'refused': return <StateLine tone="error">{cloneProblemText(t, clone.problem)}</StateLine>
    case 'failed': return <StateLine tone="error">{t(`clone.failure.${clone.failure}`)}</StateLine>
    /* v8 ignore next 2 -- closed-union default only defends a future widening of CloneView */
    default: return assertNever(clone)
  }
}

/**
 * A repository cloned from Git: its address, the folder to clone into, chosen with this step's chooser, and the new
 * folder's name, which follows the address until the person changes it.
 * @param props - the services and the guide.
 * @returns the form.
 */
function CloneMode({ services, guide }: StepProps): ReactNode {
  const { t } = services
  const clone = useStore(guide.clone)
  const id = useId()
  const [url, setUrl] = useState('')
  const [checked, setChecked] = useState(false)
  const [parent, setParent] = useState<string | undefined>()
  const [picking, setPicking] = useState(false)
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const busy = clone.state === 'starting' || clone.state === 'running'
  const urlOk = isCloneAddress(url.trim())
  const folder = named ? name : suggestedName(url.trim())
  const nameOk = folder !== '' && isFolderName(folder)
  /** Whether this form started a clone; a finished clone becomes the chosen workspace and the clone returns to idle. */
  const started = useRef(false)
  /** Validate and start the clone; whether one was started. */
  const start = (): boolean => {
    setChecked(true)
    if (!urlOk || !nameOk || parent === undefined) return false
    started.current = true
    guide.startClone({ url: url.trim(), parent, name: folder })
    return true
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    start()
  }
  // Continue clones, and goes on once the clone has finished and become the chosen workspace.
  const latest = useRef(start)
  latest.current = start
  const finished = started.current && clone.state === 'idle'
  useEffect(() => {
    guide.setGate('clone', () => {
      const state = guide.clone.getSnapshot().state
      if (started.current && state === 'idle') return true
      if (state !== 'starting' && state !== 'running') latest.current()
      return false
    })
    return () => { guide.setGate('clone', undefined) }
  }, [guide])
  useEffect(() => {
    guide.setContinueLabel(finished ? undefined : t('clone.continue'))
    return () => { guide.setContinueLabel(undefined) }
  }, [guide, finished, t])
  return (
    <form className={css.stack} onSubmit={submit} noValidate>
      <Chosen services={services} guide={guide} />
      <div className={css.field}>
        <label htmlFor={`${id}-url`} className={css.label}>{t('clone.url')}</label>
        <Input id={`${id}-url`} value={url} autoComplete="off" spellCheck={false} inputMode="url" placeholder="https://github.com/owner/repo.git"
          disabled={busy} aria-invalid={checked && !urlOk} aria-describedby={`${id}-url-hint`}
          onChange={(event) => { setUrl(event.target.value) }} onBlur={() => { if (url !== '') setChecked(true) }} />
        <span id={`${id}-url-hint`} className={checked && !urlOk ? css.failure : css.hint}>{t(checked && !urlOk ? 'clone.problem.url-form' : 'clone.url.hint')}</span>
      </div>
      <div className={css.field}>
        <span className={css.label}>{t('clone.parent')}</span>
        <span className={css.commandRow}>
          <span className={css.path}>{parent ?? t('clone.parent.none')}</span>
          {!picking && <Button variant="outline" size="sm" className={css.inline} disabled={busy} onClick={() => { setPicking(true) }}>{t('clone.parent.choose')}</Button>}
        </span>
        {checked && parent === undefined && !picking && <span className={css.failure}>{t('clone.parent.missing')}</span>}
        {picking && (
          <FolderChooser services={services} pick={{ label: t('clone.parent.here'), onPick: (path) => { setParent(path); setPicking(false) } }} />
        )}
      </div>
      <div className={css.field}>
        <label htmlFor={`${id}-name`} className={css.label}>{t('clone.name')}</label>
        <Input id={`${id}-name`} value={folder} autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={checked && !nameOk}
          onChange={(event) => { setNamed(true); setName(event.target.value) }} />
        {checked && !nameOk && <span className={css.failure}>{t('clone.problem.name-form')}</span>}
      </div>
      <p className={css.hint}>{t('clone.signIn')}</p>
      <div aria-live="polite"><CloneProgress clone={clone} t={t} /></div>
    </form>
  )
}

/**
 * The Workspace step body.
 * @param props - the services, the guide and where the chat opens without a choice.
 * @returns the step body.
 */
export function WorkspaceStep({ services, guide, target, keepCurrent }: StepProps & { readonly target: StartTarget; readonly keepCurrent: boolean }): ReactNode {
  const { t } = services
  const mode = useStore(guide.mode)
  const workspace = useStore(guide.workspace)
  const shown: WorkspaceMode = mode === 'default' && target.kind !== 'default' ? 'folder' : mode
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('workspace.lead')}</p>
      {target.kind === 'checking' && <StateLine tone="loading">{t('start.lead.checking')}</StateLine>}
      {target.kind === 'none' && <StateLine tone="warning">{t('start.lead.none')}</StateLine>}
      {target.kind === 'other' && workspace === undefined && <StateLine tone="info">{t('workspace.other')}</StateLine>}
      <ChipGroup label={t('workspace.how')} value={shown} onChange={(next) => {
        guide.setMode(next)
        if (next === 'default' && target.kind === 'default') guide.chooseWorkspace({ kind: 'default', workspaceId: target.workspaceId, path: target.path })
      }} options={[
        ...target.kind === 'default' ? [{ value: 'default' as WorkspaceMode, label: t('workspace.mode.default') }] : [],
        { value: 'folder' as WorkspaceMode, label: t('workspace.mode.folder') },
        { value: 'clone' as WorkspaceMode, label: t('workspace.mode.clone') },
      ]} />
      {shown === 'default' && target.kind === 'default' && (
        <>
          <FolderCard path={target.path} name={t('workspace.default')} note={t('workspace.default.note')} t={t} />
          <Explain heading={t('workspace.about')} cards={WORKSPACE_KINDS.map(kind => ({ key: kind, title: t(`workspace.about.${kind}.title`), text: t(`workspace.about.${kind}.text`), sample: t(`workspace.about.${kind}.sample`) }))} />
          {keepCurrent && workspace === undefined && (
            <>
              <p className={css.hint}>{t('workspace.keep')}</p>
              <Button variant="outline" size="sm" className={`${css.alignStart} ${css.inline}`}
                onClick={() => { guide.chooseWorkspace({ kind: 'default', workspaceId: target.workspaceId, path: target.path }) }}>{t('workspace.useDefault')}</Button>
            </>
          )}
        </>
      )}
      {shown === 'folder' && <FolderMode services={services} guide={guide} />}
      {shown === 'clone' && <CloneMode services={services} guide={guide} />}
    </div>
  )
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when a closed union widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled value ${JSON.stringify(value)}`)
}
