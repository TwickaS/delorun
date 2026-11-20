/**
 * The phone pager's position dots, drawn above each page's reply box. The dots are a contribution to the chat's `conversation.input.dock`
 * list, which sits directly above the composer card, so they appear in the chat itself, and only while the pager shows that chat.
 */
import { useSyncExternalStore } from 'react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconShareOutlineRegular, IconStopFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PaneId } from '../layout/index.ts'
import type { PANES_NS } from '../panes/locales.ts'
import { PageDots } from '../phone/index.ts'
import css from './Panel.module.css'

/** What the dots show while the pager is mounted. */
export interface PhoneDotsState {
  /** The pages' ids in order. */
  readonly ids: readonly PaneId[]
  /** The shown page. */
  readonly active: PaneId
  /**
   * Show another page.
   * @param id - the page.
   */
  readonly select: (id: PaneId) => void
  /** The main chat's page: it has no Open full chat or Stop buttons. */
  readonly main: PaneId
  /**
   * Open a page's chat in the main view.
   * @param id - the chat.
   */
  readonly open: (id: PaneId) => void
  /**
   * Stop a page's chat.
   * @param id - the chat.
   */
  readonly stop: (id: PaneId) => void
}

/** What the dock entry is injected with. */
export interface DotsInjected {
  /** The pager's position, or undefined while no pager is mounted. */
  readonly dots: HostObservable<PhoneDotsState | undefined>
}

/** Where the mounted pager publishes its position. */
export type PhoneDotsStore = SnapshotStore<PhoneDotsState | undefined>

/**
 * Make an empty store for the pager's position.
 * @returns the store.
 */
export function createPhoneDots(): PhoneDotsStore {
  return createSnapshotStore<PhoneDotsState | undefined>(undefined)
}

/** Props of the dots entry. */
export type DotsDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof PANES_NS> & InjectFace<DotsInjected>

/**
 * Draw a phone page's Open full chat and Stop buttons and the position dots, above the page's reply box.
 * @param props - the chat, its run state and the pager's position.
 * @returns the buttons and dots, or null when the pager does not show this chat.
 */
export function DotsDock({ sessionId, dots, useSession, t }: DotsDockProps) {
  const state = useSyncExternalStore(listener => dots.subscribe(listener), () => dots.getSnapshot())
  const stoppable = useSession(session => session.running && (session.subagent === null || session.subagent.address.mode === 'continuable'))
  if (state === undefined || !state.ids.includes(sessionId)) return null
  const buttons = sessionId === state.main ? null : (
    <div className={css.pageButtons}>
      <button type="button" className={css.pageButton} onClick={() => { state.open(sessionId) }}>
        <IconShareOutlineRegular size={16} />{t('action.open')}
      </button>
      {stoppable === true && (
        <button type="button" className={css.pageButton} data-danger="" onClick={() => { state.stop(sessionId) }}>
          <IconStopFillRegular size={16} />{t('action.stop')}
        </button>
      )}
    </div>
  )
  return <>{buttons}<PageDots ids={state.ids} active={state.active} onSelect={state.select} /></>
}
