/**
 * The Start step's own folder chooser, for a host without a native one. It lists the folders of one folder at a time,
 * starting at the home directory, lets the person enter a folder, go up and create a folder, and adds only the folder
 * the person selected: nothing is selected when it opens or after a move, so its button waits for a choice. The
 * harness's route refuses the folders Delo never adds, and the chooser says why in place.
 */
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import type { LocationProblem } from '../wire.ts'
import type { StepServices } from './types.ts'
import css from './Onboarding.module.css'

/** Why a folder was not added: a location Delo never adds, or a failure to add it. */
export type FolderProblem = LocationProblem | 'failed'

/**
 * The sentence that says why a folder was not added and what to do instead.
 * @param t - this plugin's copy.
 * @param problem - why it was not added.
 * @returns the sentence.
 */
export function problemText(t: StepServices['t'], problem: FolderProblem): string {
  return t(`problem.${problem}`)
}

/** The props of the chooser. */
export interface FolderChooserProps {
  /** The services; the chooser lists, creates and adds folders through `start`. */
  readonly services: StepServices
  /**
   * Called once the selected folder was added.
   * @param workspaceId - the new workspace.
   */
  readonly onAdded: (workspaceId: WorkspaceId) => void
}

/** One folder of a listing. */
type DirectoryEntry = DirectoryListing['entries'][number]

/** How each key moves the selection in the list: a step, or to the first or last folder. */
const LIST_KEYS: Readonly<Record<string, -1 | 1 | 'first' | 'last'>> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' }

/**
 * Render the chooser.
 * @param props - the services and what follows an added folder.
 * @returns the chooser.
 */
export function FolderChooser({ services, onAdded }: FolderChooserProps): ReactNode {
  const { t, start } = services
  const nameId = useId()
  const [listing, setListing] = useState<DirectoryListing | undefined>()
  const [listFailed, setListFailed] = useState(false)
  const [selected, setSelected] = useState<string | undefined>()
  const [problem, setProblem] = useState<FolderProblem | undefined>()
  const [adding, setAdding] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [createFailed, setCreateFailed] = useState(false)
  const [requested, setRequested] = useState<string | undefined>()
  const list = useRef<HTMLUListElement>(null)
  /** Whether the list takes focus once the next level shows. */
  const refocus = useRef(false)
  /** The listing in flight, aborted when a newer one starts or the chooser closes. */
  const pending = useRef<AbortController | undefined>(undefined)

  /**
   * List a folder and show it, with a folder selected only when one is given.
   * @param path - the folder; absent lists the home directory.
   * @param options - the folder to select once the level shows, such as one just created, and whether the new level's
   * first folder takes focus; by default it does when the list holds focus.
   */
  const open = useCallback((path: string | undefined, options: { readonly select?: string; readonly focusList?: boolean } = {}): void => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    refocus.current = options.focusList ?? list.current?.contains(document.activeElement) === true
    setRequested(path)
    setListFailed(false)
    void start.browse.list(path, controller.signal).then((next) => {
      if (controller.signal.aborted) return
      setListing(next)
      setSelected(options.select)
      setProblem(undefined)
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      console.warn('delo onboarding: the folder was not listed', error)
      setListFailed(true)
    })
  }, [start.browse])

  // The chooser opens at the home directory.
  useEffect(() => {
    open(undefined)
    return () => { pending.current?.abort() }
  }, [open])

  // After a move made from the list, or a folder created, the new level's selected folder or else its first takes focus,
  // so the keyboard stays in the list.
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    // The list always renders, so it is mounted when an effect runs.
    const options = [...(list.current as HTMLUListElement).querySelectorAll<HTMLElement>('[role="option"]')]
    const target = options.find(option => option.getAttribute('aria-selected') === 'true') ?? options[0]
    target?.focus()
  }, [listing])

  const folders = listing?.entries.filter(entry => !entry.hidden) ?? []
  const parent = listing?.crumbs.at(-2)?.path
  const here = listing?.crumbs.at(-1)?.name ?? listing?.path ?? ''
  const stop = folders.find(entry => entry.path === selected) ?? folders[0]

  const select = (entry: DirectoryEntry): void => {
    setSelected(entry.path)
    setProblem(undefined)
  }
  const onListKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
    const from = options.indexOf(event.target as HTMLElement)
    if (from < 0) return
    const entry = folders[from] as DirectoryEntry
    const move = LIST_KEYS[event.key]
    if (move !== undefined) {
      event.preventDefault()
      const to = move === 'first' ? 0 : move === 'last' ? options.length - 1 : Math.min(options.length - 1, Math.max(0, from + move))
      const option = options[to] as HTMLElement
      option.focus()
      select(folders[to] as DirectoryEntry)
    } else if (event.key === ' ') {
      event.preventDefault()
      select(entry)
    } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
      event.preventDefault()
      open(entry.path)
    } else if (event.key === 'ArrowLeft' && parent !== undefined) {
      event.preventDefault()
      open(parent)
    }
  }

  const add = (path: string): void => {
    setAdding(true)
    setProblem(undefined)
    void start.addFolder(path).then((outcome) => {
      setAdding(false)
      if (outcome.kind === 'chosen') onAdded(outcome.workspaceId)
      else setProblem(outcome.kind === 'refused' ? outcome.problem : 'failed')
    })
  }

  const create = (event: FormEvent<HTMLFormElement>, parentPath: string): void => {
    event.preventDefault()
    const folder = name.trim()
    if (folder === '') return
    setCreateFailed(false)
    void start.browse.create(parentPath, folder).then((path) => {
      setNaming(false)
      setName('')
      open(parentPath, { select: path, focusList: true })
    }, (error: unknown) => {
      console.warn('delo onboarding: the folder was not created', error)
      setCreateFailed(true)
    })
  }

  return (
    <div className={css.chooser}>
      <p className={css.text}>{t('chooser.lead')}</p>
      <div className={css.chooserBar}>
        <Button variant="outline" size="sm" disabled={parent === undefined} onClick={() => { open(parent) }}>{t('chooser.up')}</Button>
        <p className={css.location}>
          <span className={css.label}>{t('chooser.location')}</span>
          <span className={css.path}>{listing?.path}</span>
        </p>
        <Button variant="outline" size="sm" disabled={listing === undefined || naming} onClick={() => { setNaming(true); setCreateFailed(false) }}>
          {t('chooser.new')}
        </Button>
      </div>
      {naming && listing !== undefined && (
        <form className={css.newFolder} onSubmit={(event) => { create(event, listing.path) }}>
          <label htmlFor={nameId} className={css.label}>{t('chooser.newName')}</label>
          <Input id={nameId} className={css.nameInput as string} value={name} autoComplete="off" spellCheck={false}
            onChange={(event) => { setName(event.target.value) }} />
          <Button type="submit" variant="outline" size="sm" disabled={name.trim() === ''}>{t('chooser.create')}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setNaming(false); setName(''); setCreateFailed(false) }}>{t('chooser.cancel')}</Button>
        </form>
      )}
      {createFailed && <p className={css.failure} role="alert">{t('chooser.createFailed')}</p>}
      <ul ref={list} className={css.folders} role="listbox" aria-label={t('chooser.list', { folder: here })} aria-busy={listing === undefined}
        onKeyDown={onListKey}>
        {folders.map(entry => (
          <li key={entry.path} role="option" aria-selected={entry.path === selected} tabIndex={entry === stop ? 0 : -1} className={css.folder}
            onClick={() => { select(entry) }} onDoubleClick={() => { open(entry.path, { focusList: true }) }}>
            {entry.name}
          </li>
        ))}
      </ul>
      {listing !== undefined && folders.length === 0 && <p className={css.hint}>{t('chooser.empty')}</p>}
      {listing?.truncated === true && <p className={css.hint}>{t('chooser.truncated')}</p>}
      {listFailed && (
        <div className={css.chooserFailure}>
          <p className={css.failure} role="alert">{t('chooser.listFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => { open(requested) }}>{t('chooser.retry')}</Button>
        </div>
      )}
      {problem !== undefined && <p className={css.failure} role="alert">{problemText(t, problem)}</p>}
      <div className={css.chooserActions}>
        <Button variant="outline" size="sm" disabled={selected === undefined} onClick={() => { open(selected, { focusList: true }) }}>{t('chooser.open')}</Button>
        <Button variant="primary" disabled={selected === undefined || adding} onClick={selected === undefined ? undefined : () => { add(selected) }}>
          {t('chooser.add')}
        </Button>
      </div>
    </div>
  )
}
