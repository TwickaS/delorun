/**
 * "Report a problem": a dialog that shows exactly what will go into a pre-filled GitHub issue, the sidebar footer's icon
 * button that opens it, and the Settings → About row that opens it. The dialog reads the home's details route when it
 * opens and sends nothing: Open GitHub issue opens the link in a new tab, where the person reviews and sends the issue,
 * and Copy details copies the text.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { readVersions } from './versions.ts'
import { IconWarningOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button, Dialog, Notice } from '@delorun/brand'
import { hostFailureOf, type HostFetch } from './host-api.ts'
import type { PrivacyLocaleKey } from './locales.ts'
import { loadReportDetails, REPORT_DEFAULTS, type ReportDetails } from './report-api.ts'
import { buildReport, type StudioSurface } from './report-url.ts'
import css from './ReportProblem.module.css'

/** The copy lookup the report surfaces read. */
export type ReportTranslate = (key: PrivacyLocaleKey) => string

/** What a report surface needs besides its copy. */
export interface ReportFace {
  /** Where the studio runs, which the report names. */
  readonly surface: StudioSurface
  /** The request function for the details route; the browser's `fetch` when absent. */
  readonly fetchImpl?: HostFetch | undefined
  /** Opens a chat with the report skill's command pre-filled and never sent; absent hides the button. */
  readonly startChat?: (() => void) | undefined
}

/** The dialog's props. */
export interface ReportDialogProps extends ReportFace {
  readonly open: boolean
  readonly onClose: () => void
  readonly t: ReportTranslate
}

type Load = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly details: ReportDetails } | { readonly kind: 'failed' }

/**
 * Render the review dialog.
 * @param props - whether it is open, how to close it, the copy and the surface.
 * @returns the dialog.
 */
export function ReportDialog({ open, onClose, t, surface, fetchImpl, startChat }: ReportDialogProps): ReactNode {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const [includeErrors, setIncludeErrors] = useState(true)
  const request = useRef(0)
  useEffect(() => {
    if (!open) return
    const mine = ++request.current
    setCopied('idle')
    if (surface === 'approved device') {
      // The home's details route answers the computer only, so a device reports the versions the page carries.
      const versions = readVersions()
      setLoad({ kind: 'ready', details: {
        ...versions === undefined ? {} : { delorun: versions.delorun, dsh: versions.dsh },
        os: 'unknown (reported from an approved device)', platform: 'unknown', excerpt: '', ...REPORT_DEFAULTS,
      } })
      return
    }
    setLoad({ kind: 'loading' })
    loadReportDetails(fetchImpl).then(
      (details) => { if (mine === request.current) setLoad({ kind: 'ready', details }) },
      (error: unknown) => {
        console.warn('delorun report: the details were not read', hostFailureOf(error))
        if (mine === request.current) setLoad({ kind: 'failed' })
      },
    )
  }, [open, fetchImpl, surface])
  const report = load.kind === 'ready' ? buildReport(load.details, surface, includeErrors) : undefined
  const copy = (): void => {
    if (report === undefined) return
    navigator.clipboard.writeText(report.details).then(() => { setCopied('done') }, (error: unknown) => {
      console.warn('delorun report: the details were not copied', error)
      setCopied('failed')
    })
  }
  return <Dialog open={open} onClose={onClose} title={t('report.title')} closeLabel={t('report.close')} description={t('report.description')}
    actions={<>
      <Button variant="ghost" size="sm" className={css.action} onClick={onClose}>{t('report.cancel')}</Button>
      <Button size="sm" className={css.action} disabled={report === undefined} onClick={copy}>{t('report.copy')}</Button>
      <Button variant="primary" size="sm" className={css.action} disabled={report === undefined} data-modal-autofocus onClick={() => {
        if (report !== undefined) window.open(report.url, '_blank', 'noopener,noreferrer')
      }}>{t('report.open')}</Button>
    </>}>
    {load.kind === 'loading' && <p className={css.status} role="status">{t('report.loading')}</p>}
    {load.kind === 'failed' && <Notice tone="warning" role="alert" title={t('report.failedTitle')}>{t('report.failed')}</Notice>}
    {report !== undefined && <>
      <pre className={css.details} tabIndex={0} aria-label={t('report.details')}>{report.details}</pre>
      {surface === 'approved device'
        ? <p className={css.status}>{t('report.deviceNote')}</p>
        : <label className={css.include}><input type="checkbox" checked={includeErrors} onChange={(event) => { setIncludeErrors(event.target.checked) }} />{t('report.includeErrors')}</label>}
      {report.truncated && <p className={css.status}>{t('report.truncated')}</p>}
      {copied === 'done' && <p className={css.status} role="status">{t('report.copied')}</p>}
      {copied === 'failed' && <p className={css.status} role="status">{t('report.copyFailed')}</p>}
      <p className={css.status}>{t('report.nothingSent')}</p>
    </>}
    {startChat !== undefined && <div className={css.help}><Button size="sm" className={css.action} onClick={() => { onClose(); startChat() }}>{t('report.help')}</Button></div>}
  </Dialog>
}

/** The footer button's props. */
export type ReportFooterProps = ReportFace & { readonly t: ReportTranslate, readonly wide: boolean }

/**
 * Render the sidebar footer's icon button and the dialog it opens.
 * @param props - the surface and the copy.
 * @returns the button.
 */
export function ReportFooterButton({ t, wide, surface, fetchImpl, startChat }: ReportFooterProps): ReactNode {
  const [open, setOpen] = useState(false)
  return <>
    <Tooltip label={t('report.action')} side={wide ? 'top' : 'right'} align="end" portal delayMs={500}>
      <button type="button" className={css.button} aria-label={t('report.action')} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true) }}>
        <IconWarningOutlineRegular size={16} />
      </button>
    </Tooltip>
    <ReportDialog open={open} onClose={() => { setOpen(false) }} t={t} surface={surface} fetchImpl={fetchImpl} startChat={startChat} />
  </>
}
