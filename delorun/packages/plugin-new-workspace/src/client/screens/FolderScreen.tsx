/**
 * Screen 2a: a folder on this computer, and the place picker the other screens' Change button opens. A search field and
 * suggested folders on top, the crumbs of the listed folder, and a two-column browser: the folders on the left, and on
 * the right a preview of the selected folder. On a phone the browser shows one column at a time.
 */
import {
  Button, IconChevronLeftOutlineRegular, IconFolderCloseRegular, IconSearchOutlineRegular, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { isFolderName } from '../../clone-address.ts'
import { MAX_SEARCH_RESULTS, type PreviewAnswer, type SearchAnswer, type SuggestedPlace } from '../../wire.ts'
import type { ApiFailure, NewWorkspaceApi } from '../api.ts'
import { DialogFooter } from '../footer.tsx'
import { problemOfFailure } from '../create.ts'
import type { Problem } from '../flow.ts'
import type { Translate } from '../locales.ts'
import { baseName, displayPath } from '../paths.ts'
import { problemText } from '../problems.ts'
import css from './screens.module.css'

/** The folders of one folder as the studio lists them; the studio's directory listing is assignable to it. */
export interface FolderListing {
  /** The listed folder. */
  readonly path: string
  /** The folder's ancestors from the filesystem root, ending with the folder itself. */
  readonly crumbs: readonly { readonly name: string, readonly path: string }[]
  /** The child folders. */
  readonly entries: readonly { readonly name: string, readonly path: string, readonly hidden: boolean }[]
  /** Whether the list was cut. */
  readonly truncated: boolean
}

/** Listing and making folders through the studio's workspace navigation. */
export interface FolderBrowse {
  /**
   * List the child folders of a folder.
   * @param path - the folder; absent lists the home folder.
   * @param signal - cancels a listing a newer one supersedes.
   * @returns the listing.
   */
  list(path?: string, signal?: AbortSignal): Promise<FolderListing>
  /**
   * Make a child folder.
   * @param parent - an existing folder.
   * @param name - the new folder's name.
   * @returns the new folder's path.
   */
  create(parent: string, name: string): Promise<string>
}

/** The props of the folder screen. */
export interface FolderScreenProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The Host client, for the search and the preview. */
  readonly api: NewWorkspaceApi
  /** The studio's folder navigation, for the listing and new folders. */
  readonly browse: FolderBrowse
  /** The home folder, which paths show as `~`. */
  readonly home: string
  /** The folders offered as places to look. */
  readonly suggested: readonly SuggestedPlace[]
  /** Where the browser opens; the home folder when absent or when it cannot be listed. */
  readonly startPath: string | undefined
  /** Whether the screen picks a place for another screen instead of a workspace. */
  readonly picking: boolean
  /** Whether a request is running. */
  readonly busy: boolean
  /** The reason the last attempt to add the folder failed. */
  readonly problem: Problem | undefined
  /** Go back. */
  readonly onBack: () => void
  /**
   * Use the folder.
   * @param path - the selected folder.
   */
  readonly onUse: (path: string) => void
}

/** How long typing pauses before a search runs, in milliseconds. */
const SEARCH_DELAY_MS = 250

/** How long moving through the list pauses before the folder is previewed, in milliseconds. */
const PREVIEW_DELAY_MS = 150

/** How each key moves the selection in a list: a step, or to the first or last item. */
const LIST_KEYS: Readonly<Record<string, -1 | 1 | 'first' | 'last'>> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' }

/** What the preview column shows. */
type PreviewState =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'answer', readonly answer: PreviewAnswer }
  | { readonly status: 'failed', readonly reason: ApiFailure }

/** What the search shows. */
type SearchState =
  | { readonly status: 'idle' }
  | { readonly status: 'looking' }
  | { readonly status: 'done', readonly answer: SearchAnswer }
  | { readonly status: 'failed', readonly reason: ApiFailure }

/** One row of a list. */
interface Row {
  readonly path: string
  readonly name: string
}

/**
 * The folder screen.
 * @param props - the services, where to start and what the screen returns.
 * @returns the screen.
 */
export function FolderScreen({ t, api, browse, home, suggested, startPath, picking, busy, problem, onBack, onUse }: FolderScreenProps): ReactNode {
  const nameId = useId()
  const [listing, setListing] = useState<FolderListing | undefined>()
  const [listFailed, setListFailed] = useState(false)
  const [requested, setRequested] = useState<string | undefined>(startPath)
  const [selected, setSelected] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>({ status: 'idle' })
  const [preview, setPreview] = useState<PreviewState>({ status: 'none' })
  const [naming, setNaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFailed, setNewFailed] = useState(false)
  const [newInvalid, setNewInvalid] = useState(false)
  const [phoneView, setPhoneView] = useState<'list' | 'preview'>('list')
  const list = useRef<HTMLUListElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  /** Whether the list takes focus once the next level shows. */
  const refocus = useRef(false)
  /** The listing in flight, aborted when a newer one starts or the screen closes. */
  const pending = useRef<AbortController | undefined>(undefined)

  /**
   * List a folder and show it.
   * @param path - the folder; absent lists the home folder.
   * @param options - the folder to select once it shows, and whether the list takes focus.
   * @returns whether the listing was read; false when it failed (a superseded listing counts as read).
   */
  const open = useCallback(async (path: string | undefined, options: { readonly select?: string, readonly focusList?: boolean } = {}): Promise<boolean> => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    refocus.current = options.focusList ?? list.current?.contains(document.activeElement) === true
    setRequested(path)
    setListFailed(false)
    try {
      const next = await browse.list(path, controller.signal)
      if (controller.signal.aborted) return true
      setListing(next)
      setSelected(options.select)
      setPhoneView('list')
      return true
    } catch (error) {
      if (controller.signal.aborted) return true
      console.warn('delorun new workspace: a folder was not listed', error)
      setListFailed(true)
      return false
    }
  }, [browse])

  // The browser opens where it was asked to, or at the home folder when that folder cannot be listed.
  useEffect(() => {
    void open(startPath).then((read) => { if (!read && startPath !== undefined) void open(undefined) })
    return () => { pending.current?.abort() }
  }, [open, startPath])

  // After a move made from the list, or a folder created, the new level's selected folder or else its first takes focus.
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    // The list always renders, so it is mounted when an effect runs.
    const options = [...(list.current as HTMLUListElement).querySelectorAll<HTMLElement>('[role="option"]')]
    const target = options.find(option => option.getAttribute('aria-selected') === 'true') ?? options[0]
    target?.focus()
  }, [listing])

  // The new folder's name field takes focus when it opens.
  useEffect(() => { if (naming) nameInput.current?.focus() }, [naming])

  const text = query.trim()
  // A search runs once typing pauses; a newer search or an empty field cancels the one in flight.
  useEffect(() => {
    if (text === '') {
      setSearch({ status: 'idle' })
      return undefined
    }
    const controller = new AbortController()
    setSearch({ status: 'looking' })
    const timer = setTimeout(() => {
      void api.search(text, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        setSearch(result.ok ? { status: 'done', answer: result.value } : { status: 'failed', reason: result.reason })
      })
    }, SEARCH_DELAY_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, text])

  const folders = listing?.entries.filter(entry => !entry.hidden) ?? []
  // The folder the screen would use: the one selected, else the one listed, but never the home folder on its own.
  const target = selected ?? (listing !== undefined && listing.path !== home ? listing.path : undefined)

  // The target's preview, once the selection rests.
  useEffect(() => {
    if (target === undefined) {
      setPreview({ status: 'none' })
      return undefined
    }
    const controller = new AbortController()
    setPreview({ status: 'loading' })
    const timer = setTimeout(() => {
      void api.preview(target, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        setPreview(result.ok ? { status: 'answer', answer: result.value } : { status: 'failed', reason: result.reason })
      })
    }, PREVIEW_DELAY_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, target])

  const select = (path: string): void => {
    setSelected(path)
    setPhoneView('preview')
  }
  const searching = text !== ''
  const found: readonly SuggestedPlace[] = search.status === 'done' ? search.answer.results : []
  const rows: readonly Row[] = searching ? found : folders
  const parent = listing?.crumbs.at(-2)?.path

  const onListKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
    const from = options.indexOf(event.target as HTMLElement)
    if (from < 0) return
    const row = rows[from] as Row
    const move = LIST_KEYS[event.key]
    if (move !== undefined) {
      event.preventDefault()
      const to = move === 'first' ? 0 : move === 'last' ? options.length - 1 : Math.min(options.length - 1, Math.max(0, from + move))
      ;(options[to] as HTMLElement).focus()
      select((rows[to] as Row).path)
    } else if (event.key === ' ') {
      event.preventDefault()
      select(row.path)
    } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
      event.preventDefault()
      // A search result is selected; a listed folder is opened.
      if (searching) select(row.path)
      else void open(row.path)
    } else if (event.key === 'ArrowLeft' && !searching && parent !== undefined) {
      event.preventDefault()
      void open(parent)
    }
  }
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    const first = found[0]
    if (event.key === 'Enter' && first !== undefined) {
      event.preventDefault()
      select(first.path)
    } else if (event.key === 'ArrowDown' && first !== undefined) {
      event.preventDefault()
      list.current?.querySelector<HTMLElement>('[role="option"]')?.focus()
    }
  }

  const createFolder = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const folder = newName.trim()
    if (folder === '' || listing === undefined) return
    if (!isFolderName(folder)) {
      setNewInvalid(true)
      return
    }
    setNewInvalid(false)
    setNewFailed(false)
    browse.create(listing.path, folder).then((path) => {
      setNaming(false)
      setNewName('')
      void open(listing.path, { select: path, focusList: true })
    }, (error: unknown) => {
      console.warn('delorun new workspace: a folder was not created', error)
      setNewFailed(true)
    })
  }

  const refused = preview.status === 'answer' && (preview.answer.result === 'refused' || preview.answer.result === 'unreadable')
  const crumbs = crumbsOf(listing, home)
  const name = target === undefined ? undefined : baseName(target)
  const homeChip: SuggestedPlace = { path: home, name: t('folder.home') }
  const chips = [homeChip, ...suggested]

  return (
    <div className={css.screen}>
      <div className={css.searchRow}>
        <Input className={css.input as string} icon={<IconSearchOutlineRegular />} value={query} aria-label={t('folder.search')} placeholder={t('folder.searchHint')}
          autoComplete="off" spellCheck={false} data-modal-autofocus
          onChange={(event) => { setQuery(event.target.value) }} onKeyDown={onSearchKey} />
        <Button variant="outline" size="sm" disabled={listing === undefined || naming || searching} onClick={() => { setNaming(true); setNewFailed(false); setNewInvalid(false) }}>
          {t('folder.newFolder')}
        </Button>
      </div>
      <div className={css.chips} role="group" aria-label={t('folder.suggested')}>
        {chips.map(chip => (
          <button key={chip.path} type="button" className={css.chip} onClick={() => { setQuery(''); void open(chip.path, { focusList: true }) }}>
            {chip.path === home ? chip.name : displayPath(chip.path, home)}
          </button>
        ))}
      </div>
      <nav className={css.crumbs} aria-label={t('folder.crumbs')}>
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className={css.crumbItem}>
            {index > 0 && <span className={css.crumbSeparator} aria-hidden="true">/</span>}
            <button type="button" className={css.crumb} aria-current={index === crumbs.length - 1 ? 'location' : undefined}
              onClick={() => { setQuery(''); void open(crumb.path) }}>{crumb.name}</button>
          </span>
        ))}
      </nav>
      <div className={css.columns} data-view={phoneView}>
        <div className={css.listColumn}>
          {naming && !searching && (
            <form className={css.newFolderForm} onSubmit={createFolder}>
              <label htmlFor={nameId} className={css.visuallyHidden}>{t('folder.newName')}</label>
              <Input ref={nameInput} className={css.input as string} id={nameId} value={newName} autoComplete="off" spellCheck={false}
                onChange={(event) => { setNewName(event.target.value); setNewInvalid(false) }} />
              <Button type="submit" variant="outline" size="sm" disabled={newName.trim() === ''}>{t('folder.newCreate')}</Button>
              <Button variant="ghost" size="sm" onClick={() => { setNaming(false); setNewName(''); setNewFailed(false); setNewInvalid(false) }}>{t('folder.newCancel')}</Button>
            </form>
          )}
          {newInvalid && <p className={css.failure} role="alert">{t('folder.newInvalid')}</p>}
          {newFailed && <p className={css.failure} role="alert">{t('folder.newFailed')}</p>}
          <ul ref={list} className={css.folders} role="listbox" aria-busy={listing === undefined}
            aria-label={searching ? t('folder.results') : t('folder.list', { folder: listing?.crumbs.at(-1)?.name ?? '' })} onKeyDown={onListKey}>
            {rows.map((row, index) => (
              <li key={row.path} role="option" aria-selected={row.path === selected} className={css.folder}
                tabIndex={row.path === selected || (selected === undefined && index === 0) ? 0 : -1}
                onClick={() => { select(row.path) }} onDoubleClick={searching ? undefined : () => { void open(row.path, { focusList: true }) }}>
                <span className={css.folderIcon}><IconFolderCloseRegular size={16} /></span>
                <span className={css.folderName}>{row.name}</span>
                {searching && <span className={css.folderPath}>{displayPath(row.path, home)}</span>}
              </li>
            ))}
          </ul>
          {searching ? <SearchNote t={t} search={search} count={found.length} /> : (
            <>
              {listing !== undefined && folders.length === 0 && <p className={css.hint}>{t('folder.empty')}</p>}
              {listing?.truncated === true && <p className={css.hint}>{t('folder.truncated')}</p>}
            </>
          )}
          {listFailed && (
            <div className={css.row}>
              <p className={css.failure} role="alert">{t('folder.listFailed')}</p>
              <Button variant="outline" size="sm" onClick={() => { void open(requested) }}>{t('retry')}</Button>
            </div>
          )}
        </div>
        <section className={css.previewColumn} aria-label={name === undefined ? t('folder.none') : t('preview.title', { name })}>
          <div className={css.previewHeader}>
            <button type="button" className={css.phoneBack} aria-label={t('folder.backToList')} onClick={() => { setPhoneView('list') }}>
              <IconChevronLeftOutlineRegular size={16} />
            </button>
            <h4 className={css.previewName}>{name ?? t('folder.none')}</h4>
            {selected !== undefined && !searching && (
              <Button variant="outline" size="sm" onClick={() => { void open(selected, { focusList: true }) }}>{t('folder.open')}</Button>
            )}
          </div>
          <PreviewBody t={t} preview={preview} />
        </section>
      </div>
      {target !== undefined && <div role="group" aria-label={t('folder.selected')}><p className={css.selectedPath}>{displayPath(target, home)}</p></div>}
      {problem !== undefined && <p className={css.failure} role="alert">{problemText(t, problem)}</p>}
      <DialogFooter back={{ label: t('back'), onClick: onBack, disabled: busy }}
        primary={{
          label: target === undefined ? t('folder.useNone') : picking ? t('folder.choosePlace') : t('folder.use', { name: name ?? '' }),
          onClick: () => { if (target !== undefined) onUse(target) },
          disabled: busy || target === undefined || refused,
        }} />
    </div>
  )
}

/**
 * The crumbs of the listed folder, from the home folder when it lies inside it.
 * @param listing - the listed folder.
 * @param home - the home folder.
 * @returns the crumbs, the home folder written as `~`; nothing about the computer above the home folder.
 */
function crumbsOf(listing: FolderListing | undefined, home: string): readonly { readonly name: string, readonly path: string }[] {
  if (listing === undefined) return []
  const at = listing.crumbs.findIndex(crumb => crumb.path === home)
  return at < 0 ? listing.crumbs : [{ name: displayPath(home, home), path: home }, ...listing.crumbs.slice(at + 1)]
}

/**
 * The line under the search results: still looking, nothing found, or why the list stops short.
 * @param props - the copy, the search and how many folders it found.
 * @returns the line, or nothing.
 */
function SearchNote({ t, search, count }: { readonly t: Translate, readonly search: SearchState, readonly count: number }): ReactNode {
  switch (search.status) {
    case 'idle': return null
    case 'looking': return <p className={css.hint} role="status">{t('folder.looking')}</p>
    case 'failed': return <p className={css.failure} role="alert">{t('folder.searchFailed')}</p>
    case 'done':
      if (count === 0) return <p className={css.hint}>{t('folder.noResults')}</p>
      if (search.answer.stopped === 'limit') return <p className={css.hint}>{t('folder.limit', { n: MAX_SEARCH_RESULTS })}</p>
      return search.answer.stopped === 'time' ? <p className={css.hint}>{t('folder.timeUp')}</p> : null
    default: return search satisfies never
  }
}

/**
 * What the preview column says about the folder.
 * @param props - the copy and the preview state.
 * @returns the body.
 */
function PreviewBody({ t, preview }: { readonly t: Translate, readonly preview: PreviewState }): ReactNode {
  switch (preview.status) {
    case 'none': return null
    case 'loading': return <p className={css.hint} role="status">{t('preview.loading')}</p>
    case 'failed': return <p className={css.failure} role="alert">{problemText(t, problemOfFailure(preview.reason))}</p>
    case 'answer': {
      const { answer } = preview
      if (answer.result === 'refused') return <p className={css.failure} role="alert">{problemText(t, { kind: 'place', problem: answer.problem })}</p>
      if (answer.result === 'unreadable') return <p className={css.failure} role="alert">{t('preview.unreadable')}</p>
      const facts = [t(`preview.kind.${answer.kind}`), ...answer.git ? [t('preview.git')] : [], ...answer.branch === undefined ? [] : [answer.branch]]
      return (
        <div className={css.previewBody}>
          <p className={css.previewFacts}>{facts.join(' · ')}</p>
          {answer.agentsFile && <p className={css.previewFacts}>{t('preview.agents')}</p>}
          <ul className={css.previewNames}>
            {answer.entries.map(entry => <li key={entry.name} data-folder={entry.folder ? '' : undefined}>{entry.name}</li>)}
          </ul>
          {answer.more && <p className={css.hint}>{t('preview.more')}</p>}
        </div>
      )
    }
    default: return preview satisfies never
  }
}
