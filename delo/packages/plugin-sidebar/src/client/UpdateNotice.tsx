/**
 * The update notice at the bottom of the chat list: a newer Delorun release exists, what kind of update it is, how
 * many of the person's plugins it would turn off, its summary, and the command that applies it. It applies nothing
 * itself. It sits below the list's scrolling region, so it never covers or moves a row, and takes no focus.
 * @module @delo/plugin-sidebar/client/UpdateNotice
 */
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { UPDATE_COMMAND, type UpdateNotice } from '@delo/contract-update-report'
import { useState, useSyncExternalStore } from 'react'
import css from './UpdateNotice.module.css'

/** What the notice reads and does. */
export interface UpdateNoticeFace {
  /** The notice to show, or null. */
  readonly notice: HostObservable<UpdateNotice | null>
  /** Hide the notice for one release; null on a remote session, whose notice offers no action. */
  readonly dismiss: ((release: SemanticVersion) => void) | null
}

/** The notice's props: what it reads and does, and the sidebar's copy. */
export type UpdateNoticeCardProps = { readonly face: UpdateNoticeFace } & PropsLocale<'deloSidebar'>

/** Stands in for the command while the sentence around it is translated, so the command renders as code. */
const COMMAND_MARK = '\u0000'

/**
 * Render the notice while a newer release is known and not dismissed.
 * @param props - what the notice reads and does, and the copy.
 * @returns the notice, or nothing.
 */
export function UpdateNoticeCard({ face, t }: UpdateNoticeCardProps) {
  const notice = useSyncExternalStore(listener => face.notice.subscribe(listener), () => face.notice.getSnapshot())
  const [expanded, setExpanded] = useState(false)
  if (notice === null) return null
  const { release, running } = notice
  const remote = face.dismiss === null
  const kind = t(release.security ? 'update.kind.security' : `update.kind.${notice.kind}`)
  const plugins = notice.disables === 0
    ? t('update.plugins.none')
    : t(notice.disables === 1 ? 'update.plugins.one' : 'update.plugins.other', { count: notice.disables })
  const title = release.dsh === running.dsh
    ? t('update.title', { version: release.delo })
    : t('update.title.base', { version: release.delo, dsh: release.dsh })
  const [before = '', after = ''] = t(remote ? 'update.run.remote' : 'update.run', { command: COMMAND_MARK }).split(COMMAND_MARK)
  const dismiss = face.dismiss
  return (
    <div className={css.notice} role="status" data-update-notice={release.delo}>
      <div className={css.head}>
        <p className={css.title}>{title}</p>
        {dismiss !== null && (
          <button type="button" className={css.dismiss} aria-label={t('update.dismiss')} title={t('update.dismiss')}
            onClick={() => { dismiss(release.delo) }}>
            <IconCloseOutlineRegular size={14} className={css.dismissIcon} />
          </button>
        )}
      </div>
      <p className={css.facts}>
        <span className={release.security ? css.security : undefined}>{kind}</span>
        {t('update.separator')}
        {plugins}
      </p>
      {release.summary !== undefined && (remote
        ? <p className={css.summary}>{release.summary}</p>
        : (
          <button type="button" className={css.summaryToggle} aria-expanded={expanded} data-expanded={expanded}
            onClick={() => { setExpanded(value => !value) }}>
            {release.summary}
          </button>
        ))}
      <p className={css.run}>{before}<code className={css.command}>{UPDATE_COMMAND}</code>{after}</p>
    </div>
  )
}
