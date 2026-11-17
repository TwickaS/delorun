/**
 * The "Needs setup · <reason>" state of a Plugins row, with the action that fixes it: a command with a copy button, a link
 * to a settings section, a link to the docs, or the steps that pair the browse extension, whose button asks the computer
 * for a one-time code and shows it until Chrome connects. It renders for the row slot of the bundle's list and for a row's own page,
 * shows nothing while the row's needs are met, and on a bundle's page reports a declaration the Host could not read.
 * The state is the Host's latest check; it re-reads when the component mounts and when the window regains focus.
 * @module @delorun/bundle-local/client/NeedsSetup
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'plugins.row.state' and 'plugins.detail.section' SlotMap entries.
import type { PluginDetailProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { BrowsePairEvent, BrowsePairRequest } from './browse-pair-api.ts'
import type { RequirementFix } from './requirements-api.ts'
import type { RequirementsStore } from './requirements-store.ts'
import css from './NeedsSetup.module.css'

/** What the plugin supplies the state. */
export interface NeedsSetupInjected {
  /** The page's copy of the Host's check. */
  readonly store: RequirementsStore
  /**
   * Open a Settings section.
   * @param section - the section's id.
   */
  readonly openSettings: (section: string) => void
  /**
   * Copy text to the clipboard.
   * @param text - the text.
   * @returns a promise that rejects when the browser refuses.
   */
  readonly copy: (text: string) => Promise<void>
  /**
   * Start pairing the browse extension for a row.
   * @param request - the bundle package and row.
   * @param signal - ends the pairing.
   * @returns the pairing's steps as the computer reports them.
   */
  readonly pairBrowse: (request: BrowsePairRequest, signal: AbortSignal) => AsyncIterable<BrowsePairEvent>
}

/** Props of the `plugins.row.state` and `plugins.detail.section` entries. */
export type NeedsSetupProps = PluginDetailProps & PropsLocale<'delorunRequirements'> & InjectFace<NeedsSetupInjected>

type Translate = NeedsSetupProps['t']

/** The command with its copy button. */
function CommandFix({ command, t, copy }: { readonly command: string, readonly t: Translate, readonly copy: NeedsSetupInjected['copy'] }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <span className={css.command}>
      <code className={css.commandText} aria-label={t('commandLabel')}>{command}</code>
      <Button
        variant="outline" aria-label={t('copyLabel', { command })}
        onClick={() => { void copy(command).then(() => { setCopied(true) }, () => { setCopied(false) }) }}
      >{copied ? t('copied') : t('copy')}</Button>
    </span>
  )
}

/** Where a pairing is: not started, waiting with its code, or finished. */
type PairState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting', readonly code: string }
  | { readonly kind: 'paired', readonly name?: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'failed', readonly message: string }
  | { readonly kind: 'computer-only' }

/** The pairing steps: the extension's store page, then a one-time code to type into the extension. */
function BrowsePairFix({ extension, request, t, pairBrowse, refresh }: { readonly extension: string, readonly request: BrowsePairRequest, readonly t: Translate, readonly refresh: () => void } & Pick<NeedsSetupInjected, 'pairBrowse'>): ReactNode {
  const [state, setState] = useState<PairState>({ kind: 'idle' })
  const [running, setRunning] = useState<AbortController | undefined>(undefined)
  useEffect(() => () => { running?.abort() }, [running])
  const start = (): void => {
    running?.abort()
    const stop = new AbortController()
    setRunning(stop)
    setState({ kind: 'starting' })
    void (async () => {
      try {
        for await (const event of pairBrowse(request, stop.signal)) {
          if (event.kind === 'code') setState({ kind: 'waiting', code: event.code })
          else setState(event)
          if (event.kind === 'paired') refresh()
        }
      } catch (error) {
        if (stop.signal.aborted) return
        const status = (error as { status?: number }).status
        setState(status === 403 ? { kind: 'computer-only' } : { kind: 'failed', message: (error as Error).message })
      }
    })()
  }
  const button = (label: 'pairStart' | 'pairAgain') => <Button variant="outline" disabled={state.kind === 'starting'} onClick={start}>{t(label)}</Button>
  return (
    <ol className={css.steps} data-browse-pair={state.kind}>
      <li>
        {t('pairStepExtension')}{' '}
        <a className={css.link} href={extension} target="_blank" rel="noreferrer noopener">{t('pairOpenStore')}</a>
      </li>
      <li>
        {state.kind === 'waiting'
          ? (
              <span className={css.pairing}>
                <span>{t('pairStepCode')}</span>
                <code className={css.code} aria-label={t('pairCodeLabel')}>{state.code}</code>
                <span className={css.waiting} role="status">{t('pairWaiting')}</span>
              </span>
            )
          : state.kind === 'paired'
            ? <span role="status">{state.name === undefined ? t('pairDoneUnnamed') : t('pairDone', { name: state.name })}</span>
            : (
                <span className={css.pairing}>
                  {state.kind === 'expired' && <span role="status">{t('pairExpired')}</span>}
                  {state.kind === 'failed' && <span className={css.problem} role="alert">{t('pairFailed', { message: state.message })}</span>}
                  {state.kind === 'computer-only'
                    ? <span role="status">{t('pairComputerOnly')}</span>
                    : button(state.kind === 'idle' || state.kind === 'starting' ? 'pairStart' : 'pairAgain')}
                </span>
              )}
      </li>
    </ol>
  )
}

/** The fix's control. */
function Fix({ fix, row, t, openSettings, copy, pairBrowse, refresh }: { readonly fix: RequirementFix, readonly row: BrowsePairRequest, readonly t: Translate, readonly refresh: () => void } & Pick<NeedsSetupInjected, 'openSettings' | 'copy' | 'pairBrowse'>): ReactNode {
  switch (fix.kind) {
    case 'command': return <CommandFix command={fix.command} t={t} copy={copy} />
    case 'settings':
      return <Button variant="outline" onClick={() => { openSettings(fix.section) }}>{t('openSettings')}</Button>
    case 'docs':
      return <a className={css.link} href={fix.url} target="_blank" rel="noreferrer noopener">{t('openDocs')}</a>
    case 'browse-pair':
      return <BrowsePairFix extension={fix.extension} request={row} t={t} pairBrowse={pairBrowse} refresh={refresh} />
  }
}

/**
 * Render the state of one row, or a bundle's unreadable declaration.
 * @param props - the subject, the copy and the page's check.
 * @returns the state, or nothing when the subject's needs are met.
 */
export function NeedsSetup({ subject, t, store, openSettings, copy, pairBrowse }: NeedsSetupProps): ReactNode {
  const { answer, failed } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    void store.refresh()
    const again = (): void => { void store.refresh() }
    window.addEventListener('focus', again)
    return () => { window.removeEventListener('focus', again) }
  }, [store])
  if (subject.kind === 'bundle') {
    const problem = answer?.problems.find(entry => entry.packageName === subject.pkg.name)
    if (failed) return <p className={css.problem} role="alert" data-needs-setup-problem>{t('checkFailed')}</p>
    return problem === undefined ? null : <p className={css.problem} role="alert" data-needs-setup-problem>{t('problem', { name: subject.pkg.name, message: problem.message })}</p>
  }
  if (subject.kind !== 'row') return null
  const row = answer?.rows.find(entry => entry.packageName === subject.pkg.name && entry.rowId === subject.row.rowId)
  if (row === undefined || row.state === 'ready') return null
  return (
    <div className={css.state} data-needs-setup={row.rowId}>
      <span className={css.reason}>{t('state', { reason: row.reason })}</span>
      <Fix fix={row.fix} row={{ packageName: row.packageName, rowId: row.rowId }} t={t} openSettings={openSettings} copy={copy} pairBrowse={pairBrowse} refresh={() => { void store.refresh() }} />
    </div>
  )
}
