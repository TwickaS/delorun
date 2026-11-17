/** Screen 1: how to start. Three large cards in one row, and the recent workspaces below them. */
import { IconBranchOutlineRegular, IconCodeOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { FolderKind, PlacesAnswer, RecentPlace } from '../../wire.ts'
import { DialogFooter } from '../footer.tsx'
import { assertNever, type Method, type Problem } from '../flow.ts'
import type { Translate } from '../locales.ts'
import { displayPath, relativeTime } from '../paths.ts'
import { problemText } from '../problems.ts'
import css from './screens.module.css'

/** The places as the dialog has them: still loading, read, or why they could not be. */
export type PlacesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready', readonly places: PlacesAnswer }
  | { readonly status: 'failed', readonly problem: Problem }

/** The props of the first screen. */
export interface HowScreenProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The places the Host listed. */
  readonly places: PlacesState
  /** The card chosen. */
  readonly method: Method | undefined
  /** Whether a request is running, which holds every choice. */
  readonly busy: boolean
  /** The reason the last attempt to use a recent workspace failed. */
  readonly problem: Problem | undefined
  /** The current time in milliseconds, for the recent rows. */
  readonly now: number
  /**
   * Choose a card.
   * @param method - the way to start.
   */
  readonly onMethod: (method: Method) => void
  /** Go on with the card chosen. */
  readonly onContinue: () => void
  /**
   * Use a recent workspace's folder.
   * @param path - the folder.
   */
  readonly onRecent: (path: string) => void
  /** Read the places again after a failure. */
  readonly onRetry: () => void
  /** Close the dialog. */
  readonly onCancel: () => void
}

/** The cards, in order. */
const CARDS: readonly { readonly method: Method, readonly icon: ReactNode }[] = [
  { method: 'new-folder', icon: <IconPlusOutlineRegular size={24} /> },
  { method: 'folder', icon: <IconFolderOpenOutlineRegular size={24} /> },
  { method: 'clone', icon: <IconBranchOutlineRegular size={24} /> },
]

/**
 * The icon for what a folder holds.
 * @param kind - what the folder holds.
 * @returns the icon.
 */
function kindIcon(kind: FolderKind): ReactNode {
  switch (kind) {
    case 'code': return <IconCodeOutlineRegular size={16} />
    case 'files': return <IconFolderCloseRegular size={16} />
    case 'empty': return <IconFolderOpenOutlineRegular size={16} />
    default: return assertNever(kind)
  }
}

/**
 * The first screen.
 * @param props - the choices and what they do.
 * @returns the screen.
 */
export function HowScreen({ t, places, method, busy, problem, now, onMethod, onContinue, onRecent, onRetry, onCancel }: HowScreenProps): ReactNode {
  const ready = places.status === 'ready' ? places.places : undefined
  const recent: readonly RecentPlace[] = ready?.recent ?? []
  return (
    <div className={css.screen}>
      <h3 className={css.question} data-modal-autofocus tabIndex={-1}>{t('how.title')}</h3>
      <div className={css.cards} role="group" aria-label={t('how.title')}>
        {CARDS.map(card => (
          <button key={card.method} type="button" className={css.card} aria-pressed={method === card.method} disabled={busy}
            onClick={() => { onMethod(card.method) }}>
            <span className={css.cardIcon}>{card.icon}</span>
            <span className={css.cardTitle}>{t(`how.${cardKey(card.method)}.title`)}</span>
            <span className={css.cardBody}>{t(`how.${cardKey(card.method)}.body`)}</span>
          </button>
        ))}
      </div>
      {places.status === 'failed' && (
        <div className={css.row}>
          <p className={css.failure} role="alert">{problemText(t, places.problem)}</p>
          <button type="button" className={css.link} onClick={onRetry}>{t('retry')}</button>
        </div>
      )}
      {problem !== undefined && <p className={css.failure} role="alert">{problemText(t, problem)}</p>}
      {recent.length > 0 && ready !== undefined && (
        <section className={css.recent} aria-label={t('how.recent')}>
          <h4 className={css.sectionTitle}>{t('how.recent')}</h4>
          <ul className={css.recentList}>
            {recent.map(place => (
              <li key={place.path}>
                <button type="button" className={css.recentRow} disabled={busy} onClick={() => { onRecent(place.path) }}>
                  <span className={css.kindIcon}>{kindIcon(place.kind)}</span>
                  <span className={css.recentName}>{place.name}</span>
                  <span className={css.recentPath}>{displayPath(place.path, ready.home)}</span>
                  <span className={css.recentTime}>{relativeTime(place.usedAt, now, t)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <DialogFooter back={{ label: t('cancel'), onClick: onCancel }}
        primary={{ label: t('continue'), onClick: onContinue, disabled: busy || method === undefined || ready === undefined }} />
    </div>
  )
}

/**
 * The copy key of a way to start.
 * @param method - the way.
 * @returns the key's middle part.
 */
function cardKey(method: Method): 'new' | 'folder' | 'clone' {
  switch (method) {
    case 'new-folder': return 'new'
    case 'folder': return 'folder'
    case 'clone': return 'clone'
    default: return assertNever(method)
  }
}
