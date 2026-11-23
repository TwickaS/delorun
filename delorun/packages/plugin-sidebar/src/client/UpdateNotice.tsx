/**
 * The update notice at the bottom of the chat list: a newer Delorun release exists, what kind of update it is, how
 * many of the person's plugins it would turn off, its summary under a "Release note" label, so the release's own text
 * never reads as the studio's instruction, and Update now…, which opens the update dialog of `@delorun/plugin-update`
 * (the command that applies it where the studio has no such dialog, or a remote page the Host does not let begin one). It applies nothing itself. Every page has a close button that hides the notice for that release in that browser only. It sits below
 * the list's scrolling region, so it never covers or moves a row, and takes no focus. It is the studio's alert card
 * (`Alert`, inline): its root is the polite live region, so the announcement is the card's text.
 * @module @delorun/plugin-sidebar/client/UpdateNotice
 */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { Alert } from '@delorun/brand/alert'
import { UPDATE_COMMAND, type UpdateNotice } from '@delorun/contract-update-report'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import css from './UpdateNotice.module.css'

/** What the notice reads and does. */
export interface UpdateNoticeFace {
  /** The notice to show, or null. */
  readonly notice: HostObservable<UpdateNotice | null>
  /**
   * Read the verified release notes of the notice's release.
   * @param signal - aborts the read.
   * @returns the plain-text notes and the release they belong to, or null when there are none.
   */
  readonly notes: (signal: AbortSignal) => Promise<{ readonly version: SemanticVersion, readonly notes: string } | null>
  /** Open the studio's update dialog (`@delorun/plugin-update`); null where the studio has none. */
  readonly open: (() => void) | null
  /** Whether the Host's state lets this page begin an update; Update now… shows only while it is true, otherwise the terminal line. */
  readonly canOpen: HostObservable<boolean>
  /**
   * Hide the notice for one release in this browser. It writes a display preference to the page's own storage and calls no
   * Host route, so the computer's page and a remote page both have it; a newer release shows again.
   */
  readonly dismiss: (release: SemanticVersion) => void
  /** Whether this page is a remote session's (a phone): the title, What's new and the close button share one row. */
  readonly remote: boolean
}

/** The notice's props: what it reads and does, and the sidebar's copy. */
export type UpdateNoticeCardProps = { readonly face: UpdateNoticeFace } & PropsLocale<'delorunSidebar'>

/** Stands in for an inserted value while the sentence around it is translated, so the value renders in its own element. */
const MARK = '\u0000'

/**
 * Render the notice while a newer release is known and not dismissed.
 * @param props - what the notice reads and does, and the copy.
 * @returns the notice, or nothing.
 */
export function UpdateNoticeCard({ face, t }: UpdateNoticeCardProps) {
  const notice = useSyncExternalStore(listener => face.notice.subscribe(listener), () => face.notice.getSnapshot())
  const canOpen = useSyncExternalStore(listener => face.canOpen.subscribe(listener), () => face.canOpen.getSnapshot())
  const [expanded, setExpanded] = useState(false)
  // Remote pages only: whether the details under What's new are open.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  const [notesOpen, setNotesOpen] = useState(false)
  // undefined while reading, null when there are no notes to show.
  const [notes, setNotes] = useState<string | null | undefined>(undefined)
  const shownVersion = notice?.release.delorun
  useEffect(() => {
    if (!notesOpen) return undefined
    const controller = new AbortController()
    setNotes(undefined)
    // Notes of another release than the card's are not shown.
    void face.notes(controller.signal).then(found => { if (!controller.signal.aborted) setNotes(found !== null && found.version === shownVersion ? found.notes : null) })
    return () => { controller.abort() }
  }, [notesOpen, face, shownVersion])
  if (notice === null) return null
  const { release, running } = notice
  const { remote, dismiss } = face
  const kind = t(release.security ? 'update.kind.security' : `update.kind.${notice.kind}`)
  const plugins = notice.disables === 0
    ? t('update.plugins.none')
    : t(notice.disables === 1 ? 'update.plugins.one' : 'update.plugins.other', { count: notice.disables })
  const title = release.dsh === running.dsh
    ? t('update.title', { version: release.delorun })
    : t('update.title.base', { version: release.delorun, dsh: release.dsh })
  const [before = '', after = ''] = t(remote ? 'update.run.remote' : 'update.run', { command: MARK }).split(MARK)
  const [noteBefore = '', noteAfter = ''] = t('update.summary', { summary: MARK }).split(MARK)
  const note = release.summary === undefined
    ? null
    : <><span className={css.summaryLabel}>{noteBefore}</span>{release.summary}{noteAfter}</>
  const facts = (
    <span className={css.facts} data-update-facts>
      <span className={release.security ? css.security : undefined}>{kind}</span>
      {t('update.separator')}
      {plugins}
    </span>
  )
  const summary = note === null
    ? null
    : remote
      ? <span className={css.summary}>{note}</span>
      : (
        <button type="button" className={css.summaryToggle} aria-expanded={expanded} data-expanded={expanded}
          onClick={() => { setExpanded(value => !value) }}>
          {note}
        </button>
      )
  const whatsNew = release.notes === undefined
    ? null
    : <Button variant="ghost" className={css.whatsNew} onClick={() => { setNotesOpen(true) }}>{t(remote ? 'update.releaseNotes' : 'update.whatsNew')}</Button>
  const run = face.open === null || !canOpen
    ? <span className={css.run}>{before}<code className={css.command}>{UPDATE_COMMAND}</code>{after}</span>
    : <Button variant="primary" size="sm" className={css.updateNow} data-update-now onClick={face.open}>{t('update.now')}</Button>
  const close = { label: t('update.dismiss'), onClick: () => { dismiss(release.delorun) } }
  const notesDialog = notesOpen && (
    <Modal open onClose={() => { setNotesOpen(false) }} closeLabel={t('update.whatsNewClose')}
      title={t('update.whatsNewTitle', { version: release.delorun })}>
      {/* The notes are signed plain text: rendered as text in a pre, never as markup. */}
      {notes === undefined
        ? <p>{t('update.whatsNewLoading')}</p>
        : notes === null
          ? <p>{t('update.whatsNewUnavailable')}</p>
          : <pre className={css.notes} data-update-notes>{notes}</pre>}
    </Modal>
  )
  // A remote page is a phone's: the short title, and the details open under What's new.
  if (remote) {
    return (
      <>
        <Alert kind="info" className={css.notice} data-update-notice={release.delorun} data-remote="true"
          title={t('update.title.short', { version: release.delorun })} close={close}
          line={(
            <>
              <Button variant="ghost" className={css.whatsNew} aria-expanded={detailsOpen} aria-controls={detailsId}
                onClick={() => { setDetailsOpen(value => !value) }}>{t('update.whatsNew')}</Button>
              {detailsOpen && (
                <span className={css.details} id={detailsId} data-update-details>
                  <span className={css.detailTitle}>{title}</span>
                  {facts}
                  {summary}
                  {whatsNew}
                  {run}
                </span>
              )}
            </>
          )} />
        {notesDialog}
      </>
    )
  }
  return (
    <>
      <Alert kind="info" className={css.notice} data-update-notice={release.delorun} data-remote="false"
        title={title} close={close}
        line={<>{facts}{summary}{whatsNew}{run}</>} />
      {notesDialog}
    </>
  )
}
