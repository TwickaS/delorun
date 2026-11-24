/**
 * The trust badge at the sidebar's foot and the panel it opens (contract C15): what this Delorun runs and how much of it
 * was checked. The badge is always shown; with no bill it reads unknown, and it reads verified only when every row is
 * verified ({@link trustBadge}). Its colour is the badge's tone; the person's own changes show beside the state as a
 * neutral count and never colour it. The panel names the four rows with their details, offers Check now on the home's own
 * computer, points to `delorun verify` for the full report, and states that a program running with the person's
 * access can change these checks.
 * @module @delorun/bundle-local/client/TrustBadge
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  CommandText, IconChevronDownOutlineRegular, IconShieldOutlineRegular, StateDot, Tooltip, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Button, Dialog } from '@delorun/brand'
import type { HostObservable, InjectFace, OwnerOf, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SecurityOverview, type OverviewTranslate } from './SecurityOverview.tsx'
import type { OverviewHostFacts } from './security-overview-api.ts'
import type { OverviewAction } from './security-overview.ts'
import type { TrustCheckState } from './trust-api.ts'
import {
  trustBadge, trustRows,
  type TrustBadge as TrustBadgeValue, type TrustBill, type TrustCheckResult, type TrustChecks, type TrustPlugin, type TrustPluginMatch, type TrustPluginSource,
  type TrustRow, type TrustRowFreshness, type TrustRowId, type TrustState, type TrustTone,
} from './trust-bill.ts'
import { en as trustCopy, type TrustLocaleKey } from './trust-locales.ts'
import { relativeTime, TRUST_TICK_MS } from './trust-time.ts'
import css from './TrustBadge.module.css'

/** The command the panel points to for the full report. */
export const VERIFY_COMMAND = 'delorun verify'

/** What the badge reads and does. */
export interface TrustBadgeInjected {
  readonly hooks: {
    /** The last bill, or `null` while none could be read. */
    readonly bill: HostObservable<TrustBill | null>
    /** How fresh each row is, or `null` while the Host reports none. */
    readonly checks: HostObservable<TrustChecks | null>
    /** The state of Check now. */
    readonly checking: HostObservable<TrustCheckState>
    /** The security overview's facts from the Host's other routes. */
    readonly overview: HostObservable<OverviewHostFacts>
    /** Whether the overview's first read has finished. */
    readonly overviewLoaded: HostObservable<boolean>
  }
  /** Run Check now; `null` on a remote session, where the Host refuses it. */
  readonly check: (() => void) | null
  /**
   * Read the overview's facts while the panel is open.
   * @returns the disposer, which stops reading.
   */
  readonly watchOverview: () => () => void
  /**
   * Run an overview row's action other than Check now: open a settings section, or turn change protection on.
   * @param action - the action.
   * @returns whether it succeeded; opening a section always does.
   */
  readonly act: (action: Exclude<OverviewAction, { readonly kind: 'check-now' }>) => Promise<boolean>
}

/** The badge's props: the foot's width, the trust copy and the bill. */
export type TrustBadgeProps = OwnerOf<'sidebar.footer.action'> & PropsLocale<'delorunTrust'> & InjectFace<TrustBadgeInjected>

/** The trust copy's translate function. */
type Translate = TrustBadgeProps['t']

/**
 * Whether a key is in the trust copy, which holds the overview's copy too.
 * @param key - the key.
 * @returns whether the trust dictionary defines it.
 */
function isTrustKey(key: string): key is TrustLocaleKey {
  return Object.hasOwn(trustCopy, key)
}

/**
 * The overview's translate function over the trust copy: the overview builds its keys from a row's cause, so a key
 * the dictionary lacks shows as itself, which the copy's spec rules out.
 * @param t - the trust copy's translate function.
 * @returns the overview's translate function.
 */
function overviewTranslate(t: Translate): OverviewTranslate {
  return (key, params) => isTrustKey(key) ? t(key, params) : key
}

/** The dot each tone shows: the theme's success, warn, error and neutral idle roles. */
const DOTS: Readonly<Record<TrustTone, StateDotState>> = {
  ok: 'done',
  amber: 'warning',
  red: 'error',
  neutral: 'idle',
}

/** The row titles. */
const ROW_TITLES = {
  release: 'row.release',
  releaseLog: 'row.releaseLog',
  plugins: 'row.plugins',
  changes: 'row.changes',
} as const satisfies Readonly<Record<TrustRowId, string>>

/** The words of a check result. */
const RESULTS = { pass: 'result.pass', fail: 'result.fail', unknown: 'result.unknown' } as const satisfies Readonly<Record<TrustCheckResult, string>>

/** The words of a plugin's source. */
const SOURCES = {
  registry: 'source.registry', git: 'source.git', link: 'source.link', file: 'source.file', tarball: 'source.tarball', unknown: 'source.unknown',
} as const satisfies Readonly<Record<TrustPluginSource, string>>

/** The words of a plugin's install match. */
const MATCHES = {
  match: 'match.match', mismatch: 'match.mismatch', unrecorded: 'match.unrecorded', unknown: 'match.unknown',
} as const satisfies Readonly<Record<TrustPluginMatch, string>>

/**
 * A state with the neutral count of the person's own changes beside it, when there are any.
 * @param t - the trust copy.
 * @param state - the state's words.
 * @param ownChanges - the person's own changes.
 * @returns the label.
 */
function withOwnChanges(t: Translate, state: string, ownChanges: number): string {
  return ownChanges === 0 ? state : t('withChanges', { state, changes: t('ownChanges', { count: ownChanges }) })
}

/**
 * The badge's state in words, without the count of the person's own changes.
 * @param t - the trust copy.
 * @param state - the badge's state.
 * @returns the state's words.
 */
function badgeStateLabel(t: Translate, state: TrustState): string {
  switch (state) {
    case 'verified': return t('badge.verified')
    case 'attention': return t('badge.attention')
    case 'failed': return t('badge.failed')
    case 'unchecked': return t('badge.unchecked')
    case 'unknown': return t('badge.unknown')
    case 'checking': return t('badge.checking')
    case 'checked-at-start': return t('badge.checked-at-start')
    case 'checked-in-studio': return t('badge.checked-in-studio')
    case 'waiting': return t('badge.waiting')
  }
}

/**
 * The badge's words: its state, and the neutral count of the person's own changes when there are any.
 * @param t - the trust copy.
 * @param badge - the badge.
 * @returns the short label.
 */
export function badgeLabel(t: Translate, badge: TrustBadgeValue): string {
  return withOwnChanges(t, badgeStateLabel(t, badge.state), badge.ownChanges)
}

/**
 * A row's state in words, with the neutral count of the person's own changes when the row counts any.
 * @param t - the trust copy.
 * @param row - the row.
 * @returns the state's label.
 */
export function rowStateLabel(t: Translate, row: TrustRow): string {
  const state = ((): string => {
    switch (row.state) {
      case 'verified': return t('state.verified')
      case 'attention': return t('state.attention')
      case 'failed': return t('state.failed')
      case 'unchecked': return t('state.unchecked')
      case 'unknown': return t('state.unknown')
      case 'checking': return t('state.checking')
      case 'checked-at-start': return t('state.checked-at-start')
      case 'checked-in-studio': return t('state.checked-in-studio')
      case 'waiting': return t('state.waiting')
    }
  })()
  return withOwnChanges(t, state, row.ownChanges)
}

/**
 * A moment in the panel's locale.
 * @param t - the trust copy, whose `time.locale` names the locale.
 * @param at - an RFC 3339 time.
 * @returns the formatted time, or the text itself when it does not parse.
 */
export function formatTime(t: Translate, at: string): string {
  const time = Date.parse(at)
  return Number.isNaN(time) ? at : new Intl.DateTimeFormat(t('time.locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time))
}

/**
 * Render the badge, which opens the panel.
 * @param props - the foot's width, the copy, the bill and Check now.
 * @returns the badge, and the panel while open.
 */
export function TrustBadge({ wide, t, useBill, useChecks, useChecking, useOverview, useOverviewLoaded, check, watchOverview, act }: TrustBadgeProps) {
  const bill = useBill(current => current)
  const checks = useChecks(current => current)
  const [open, setOpen] = useState(false)
  const rows = bill === null ? null : trustRows(bill, checks)
  const badge = trustBadge(rows)
  const label = badgeLabel(t, badge)
  const button = (
    <button
      type="button"
      className={css.badge}
      data-state={badge.state}
      data-tone={badge.tone}
      aria-label={t('badge.aria', { state: label })}
      aria-haspopup="dialog"
      onClick={() => { setOpen(true) }}
    >
      <IconShieldOutlineRegular size={16} className={css.icon} />
    </button>
  )
  return (
    <>
      <Tooltip label={label} side={wide ? 'top' : 'right'} align="end" portal delayMs={500}>{button}</Tooltip>
      {open && (
        <TrustPanel
          t={t} bill={bill} checks={checks} rows={rows} useChecking={useChecking} useOverview={useOverview} useOverviewLoaded={useOverviewLoaded}
          check={check} watchOverview={watchOverview} act={act} onClose={() => { setOpen(false) }}
        />
      )}
    </>
  )
}

/** The panel's props. */
interface TrustPanelProps {
  readonly t: Translate
  readonly bill: TrustBill | null
  readonly checks: TrustChecks | null
  readonly rows: readonly TrustRow[] | null
  readonly useChecking: TrustBadgeProps['useChecking']
  readonly useOverview: TrustBadgeProps['useOverview']
  readonly useOverviewLoaded: TrustBadgeProps['useOverviewLoaded']
  readonly check: (() => void) | null
  readonly watchOverview: TrustBadgeProps['watchOverview']
  readonly act: TrustBadgeProps['act']
  readonly onClose: () => void
}

/**
 * The panel: the security overview, whose "This copy of Delorun" row breaks down into the trust bill's four rows in the
 * advanced view, Check now, the pointer to the full report and the checks' limit.
 * @param props - the copy, the bill, its rows, the overview's facts, Check now, the rows' actions and the close action.
 * @returns the dialog.
 */
function TrustPanel({ t, bill, checks, rows, useChecking, useOverview, useOverviewLoaded, check, watchOverview, act, onClose }: TrustPanelProps) {
  const checking = useChecking(current => current)
  const facts = useOverview(current => current)
  const loaded = useOverviewLoaded(current => current)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const noteId = useId()
  const running = checking.kind === 'running'
  useEffect(() => watchOverview(), [watchOverview])
  const run = (action: OverviewAction): void => {
    setMessage(undefined)
    if (action.kind === 'check-now') {
      check?.()
      return
    }
    if (action.kind === 'open-section') onClose()
    void act(action).then((done) => { if (!done) setMessage(t('overview.protectionFailed')) })
  }
  const trustDetails = bill !== null && rows !== null && (
    <>
      <ul className={css.rows}>
        {rows.map(row => <TrustRowItem key={row.id} t={t} bill={bill} checks={checks} row={row} />)}
      </ul>
      <p className={css.note}>
        {t('panel.report')} <CommandText className={css.command} text={VERIFY_COMMAND} label={t('panel.command')} />
      </p>
    </>
  )
  const checkBlock = (
    <>
      <div className={css.check}>
        <Button
          variant="secondary"
          size="sm"
          disabled={check === null || running}
          aria-busy={running}
          aria-describedby={check === null || checking.kind === 'failed' ? noteId : undefined}
          icon={running ? <StateDot state="ongoing" size={14} /> : undefined}
          onClick={() => { check?.() }}
        >
          {running ? t('check.running') : t('check.run')}
        </Button>
        {checking.kind === 'running' && <CheckProgress t={t} startedAt={checking.startedAt} launcher={bill?.checkNow?.via === 'launcher'} />}
        {checking.kind !== 'running' && bill?.checkedBy !== undefined && <p className={css.note}>{checkedByText(t, bill.checkedBy)}</p>}
        {check === null && <p id={noteId} className={css.note}>{t('check.remote')}</p>}
        {check !== null && checking.kind === 'failed' && (
          <p id={noteId} className={css.error} role="alert">{checking.reason === 'refused' ? t('check.refused') : t('check.failed')}</p>
        )}
      </div>
      <p className={css.notice}>{t('panel.notice')}</p>
    </>
  )
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('overview.title')}
      closeLabel={t('panel.close')}
      {...(bill === null ? { description: t('panel.noBill') } : {})}
      className={css.dialog ?? ''}
      contentClassName={css.content ?? ''}
    >
      <SecurityOverview
        t={overviewTranslate(t)}
        bill={bill}
        checks={checks}
        facts={facts}
        loaded={loaded}
        act={run}
        trustDetails={trustDetails}
        checkBlock={checkBlock}
        message={message}
      />
    </Dialog>
  )
}

/**
 * What a finished Check now says about how it ran.
 * @param t - the trust copy.
 * @param checkedBy - how the check produced its bill.
 * @returns the sentence.
 */
export function checkedByText(t: Translate, checkedBy: NonNullable<TrustBill['checkedBy']>): string {
  const seconds = checkedBy.seconds.toFixed(1)
  return checkedBy.via === 'launcher' ? t('checked.launcher', { seconds }) : t(`checked.host.${checkedBy.reason}`, { seconds })
}

/**
 * The running check's progress: what it does, and the seconds since it began, counted once a second.
 * @param props - the copy and when the check began.
 * @param props.t - the trust copy.
 * @param props.startedAt - when the check began, in milliseconds since the epoch.
 * @param props.launcher - whether the bill says Check now runs through the launcher; otherwise the progress names the
 *   studio, which also covers a bill that does not say.
 * @returns the progress line.
 */
function CheckProgress({ t, startedAt, launcher }: { readonly t: Translate, readonly startedAt: number, readonly launcher: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  return (
    <p className={css.note}>
      <span role="status">{t(launcher ? 'check.progress.launcher' : 'check.progress.studio')}</span>{' '}
      <span aria-hidden="true">{t('check.elapsed', { seconds: String(Math.max(0, Math.floor((now - startedAt) / 1000))) })}</span>
    </p>
  )
}

/**
 * One row: its title and state, and its details on click.
 * @param props - the copy, the bill and the row.
 * @param props.t - the trust copy.
 * @param props.bill - the bill the details come from.
 * @param props.row - the row.
 * @returns the row.
 */
function TrustRowItem({ t, bill, checks, row }: { readonly t: Translate, readonly bill: TrustBill, readonly checks: TrustChecks | null, readonly row: TrustRow }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const note = releaseNote(t, row, checks)
  return (
    <li className={css.row} data-state={row.state} data-tone={row.tone}>
      <button type="button" className={css.rowButton} aria-expanded={open} aria-controls={detailsId} onClick={() => { setOpen(!open) }}>
        <span className={css.rowTitle}>{t(ROW_TITLES[row.id])}</span>
        <span className={css.rowState}>
          <StateDot state={DOTS[row.tone]} />
          {rowStateLabel(t, row)}
        </span>
        <IconChevronDownOutlineRegular size={14} className={open ? css.chevronOpen : css.chevron} />
      </button>
      {(checks !== null || note !== undefined) && (
        <p className={css.rowNote}>
          {checks !== null && <Freshness t={t} freshness={checks[row.id]} />}
          {note !== undefined && <span>{note}</span>}
        </p>
      )}
      <div id={detailsId} className={css.details} hidden={!open}>
        {open && <RowDetails t={t} bill={bill} id={row.id} />}
      </div>
    </li>
  )
}

/**
 * What the release row's state rests on, in one line: while the background full check waits or runs, that it will hash
 * or is hashing every file; when the release stays checked at start, why no full check can run.
 * @param t - the trust copy.
 * @param row - the row.
 * @param checks - how fresh each row is.
 * @returns the line, or `undefined` for another row or state.
 */
export function releaseNote(t: Translate, row: TrustRow, checks: TrustChecks | null): string | undefined {
  if (row.id !== 'release' || checks === null) return undefined
  const full = checks.release.full
  if (row.state === 'checking') return t(full.state === 'running' ? 'full.running' : 'full.waiting')
  if (row.state !== 'checked-at-start' || full.state !== 'unavailable') return undefined
  return t(`full.reason.${full.reason}`)
}

/**
 * How fresh a row is: "Checking…" while its check runs, otherwise when it last ran, relative and live, with the exact
 * time on hover.
 * @param props - the copy and the row's freshness.
 * @param props.t - the trust copy.
 * @param props.freshness - the row's freshness.
 * @returns the line.
 */
export function Freshness({ t, freshness }: { readonly t: Translate, readonly freshness: TrustRowFreshness }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, TRUST_TICK_MS)
    return () => { clearInterval(timer) }
  }, [])
  if (freshness.running) return <span className={css.fresh}>{t('fresh.checking')}</span>
  if (freshness.at === null) return <span className={css.fresh}>{t('fresh.never')}</span>
  const ago = relativeTime(t('time.locale'), freshness.at, now)
  if (ago === undefined) return null
  return (
    <time className={css.fresh} dateTime={freshness.at} title={formatTime(t, freshness.at)}>
      {ago.kind === 'just-now' ? t('fresh.justNow') : t('fresh.ago', { ago: ago.text })}
    </time>
  )
}

/**
 * A value that may be long, such as a digest or a path: one line, cut with an ellipsis, and the whole value on click.
 * Its accessible name is always the whole value.
 * @param props - the value.
 * @param props.value - the value.
 * @returns the value.
 */
function LongValue({ value }: { readonly value: string }) {
  const [full, setFull] = useState(false)
  return (
    <button type="button" className={full ? css.valueFull : css.value} aria-expanded={full} onClick={() => { setFull(!full) }}>
      <code>{value}</code>
    </button>
  )
}

/**
 * One label and its value.
 * @param props - the label and the value.
 * @param props.label - the label.
 * @param props.children - the value.
 * @returns the pair.
 */
function Field({ label, children }: { readonly label: string, readonly children: ReactNode }) {
  return (
    <div className={css.field}>
      <dt className={css.fieldLabel}>{label}</dt>
      <dd className={css.fieldValue}>{children}</dd>
    </div>
  )
}

/**
 * A row's details from the bill.
 * @param props - the copy, the bill and the row's id.
 * @param props.t - the trust copy.
 * @param props.bill - the bill.
 * @param props.id - the row's id.
 * @returns the details.
 */
function RowDetails({ t, bill, id }: { readonly t: Translate, readonly bill: TrustBill, readonly id: TrustRowId }) {
  switch (id) {
    case 'release': return <ReleaseDetails t={t} bill={bill} />
    case 'releaseLog': return <ReleaseLogDetails t={t} bill={bill} />
    case 'plugins': return <PluginsDetails t={t} bill={bill} />
    case 'changes': return <ChangesDetails t={t} bill={bill} />
  }
}

/** The props of one row's details. */
interface DetailsProps {
  readonly t: Translate
  readonly bill: TrustBill
}

/**
 * A value, or the words for an unknown one.
 * @param t - the trust copy.
 * @param value - the value.
 * @returns the value to show.
 */
function known(t: Translate, value: string | null): ReactNode {
  return value === null ? t('value.none') : <LongValue value={value} />
}

/**
 * The signed release's details.
 * @param props - the copy and the bill.
 * @returns the details.
 */
function ReleaseDetails({ t, bill }: DetailsProps) {
  const release = bill.release
  const start = release.startCheck
  return (
    <dl className={css.fields}>
      <Field label={t('release.version')}>{release.version ?? t('value.none')}</Field>
      <Field label={t('release.commit')}>{known(t, release.commit)}</Field>
      <Field label={t('release.manifest')}>{known(t, release.manifestSha256)}</Field>
      <Field label={t('release.fileList')}>{known(t, release.fileListSha256)}</Field>
      <Field label={t('release.root')}>
        {release.root === null
          ? t('value.none')
          : (
            <>
              {t('release.rootValue', { version: release.root.version, keys: release.root.keyIds.join(', ') })}
              <span className={css.meta}>{t(release.root.anchored === 'shipped' ? 'release.anchored.shipped' : 'release.anchored.stored')}</span>
            </>
          )}
      </Field>
      <Field label={t('release.launcher')}>{release.launcher.version ?? t('value.none')}</Field>
      <Field label={t('release.launcherPath')}>{known(t, release.launcher.path)}</Field>
      <Field label={t('release.lastFullHash')}>{release.lastFullHashAt === null ? t('value.none') : formatTime(t, release.lastFullHashAt)}</Field>
      <Field label={t('release.startCheck')}>
        {start === null
          ? t('release.startCheck.none')
          : start.checkedBy === 'runtime'
            ? t('release.startCheck.runtime', { time: formatTime(t, start.at), hashed: start.hashed, files: start.files })
          : start.full
            ? t('release.startCheck.full', { time: formatTime(t, start.at), files: start.files })
            : t('release.startCheck.partial', { time: formatTime(t, start.at), hashed: start.hashed, files: start.files })}
      </Field>
      <Field label={t('release.signature')}>{t(RESULTS[release.signature])}</Field>
      <Field label={t('release.files')}>{t(RESULTS[release.files])}</Field>
      {release.detail !== undefined && <Field label={t('detail')}>{release.detail}</Field>}
    </dl>
  )
}

/**
 * The release log's details.
 * @param props - the copy and the bill.
 * @returns the details.
 */
function ReleaseLogDetails({ t, bill }: DetailsProps) {
  const log = bill.releaseLog
  return (
    <dl className={css.fields}>
      <Field label={t('releaseLog.lastAttempt')}>{log.lastAttempt === null ? t('value.none') : formatTime(t, log.lastAttempt)}</Field>
      {log.uncheckedSince !== null && <Field label={t('releaseLog.uncheckedSince')}>{formatTime(t, log.uncheckedSince)}</Field>}
      {log.detail !== undefined && <Field label={t('detail')}>{log.detail}</Field>}
    </dl>
  )
}

/**
 * The plugins' details: each plugin with its source, version, integrity or commit, install match and warnings.
 * @param props - the copy and the bill.
 * @returns the details.
 */
function PluginsDetails({ t, bill }: DetailsProps) {
  const plugins = bill.plugins
  return (
    <>
      {plugins.status === 'unknown' && <Reason text={t('plugins.unknown')} reason={plugins.reason} />}
      {plugins.entries.length === 0
        ? <p className={css.line}>{t('plugins.none')}</p>
        : <ul className={css.list}>{plugins.entries.map(entry => <PluginItem key={entry.name} t={t} plugin={entry} />)}</ul>}
    </>
  )
}

/**
 * One plugin.
 * @param props - the copy and the plugin.
 * @param props.t - the trust copy.
 * @param props.plugin - the plugin.
 * @returns the plugin's item.
 */
function PluginItem({ t, plugin }: { readonly t: Translate, readonly plugin: TrustPlugin }) {
  return (
    <li className={css.item} data-match={plugin.match}>
      <span className={css.itemName}>{plugin.name}</span>
      <dl className={css.fields}>
        <Field label={t('plugin.source')}>{t(SOURCES[plugin.source])}</Field>
        <Field label={t('plugin.version')}>{plugin.version ?? t('value.none')}</Field>
        {plugin.commit === null
          ? <Field label={t('plugin.integrity')}>{known(t, plugin.integrity)}</Field>
          : <Field label={t('plugin.commit')}><LongValue value={plugin.commit} /></Field>}
        <Field label={t('plugin.match')}>{t(MATCHES[plugin.match])}</Field>
        {plugin.criticalAdvisories.length > 0 && (
          <Field label={t('plugin.advisories')}>
            <ul className={css.list}>{plugin.criticalAdvisories.map(advisory => <li key={advisory} className={css.wrap}>{advisory}</li>)}</ul>
          </Field>
        )}
        {plugin.warnings.length > 0 && (
          <Field label={t('plugin.warnings')}>
            <ul className={css.list}>{plugin.warnings.map(warning => <li key={warning} className={css.wrap}>{warning}</li>)}</ul>
          </Field>
        )}
      </dl>
    </li>
  )
}

/**
 * Why a section is unknown: the panel's sentence, and the producer's reason when it wrote one.
 * @param props - the sentence and the reason.
 * @param props.text - the panel's sentence.
 * @param props.reason - the producer's reason.
 * @returns the line.
 */
function Reason({ text, reason }: { readonly text: string, readonly reason: string | undefined }) {
  return (
    <p className={css.line}>
      {text}
      {reason !== undefined && <span className={css.meta}>{reason}</span>}
    </p>
  )
}

/**
 * A list, or the words for an empty one.
 * @param props - the copy and the items.
 * @param props.t - the trust copy.
 * @param props.items - each item's key and content.
 * @returns the list.
 */
function Items({ t, items }: { readonly t: Translate, readonly items: readonly { readonly key: string, readonly content: ReactNode }[] }) {
  if (items.length === 0) return <>{t('list.none')}</>
  return <ul className={css.list}>{items.map(item => <li key={item.key} className={css.wrap}>{item.content}</li>)}</ul>
}

/**
 * The person's changes: harness edits, approved plugin versions, patch rows and expressions, skill folders and MCP
 * servers.
 * @param props - the copy and the bill.
 * @returns the details.
 */
function ChangesDetails({ t, bill }: DetailsProps) {
  const { changes, patches, skills, mcp } = bill
  return (
    <>
      {changes.status === 'unknown' && <Reason text={t('changes.unknown')} reason={changes.reason} />}
      {patches.status === 'unknown' && <Reason text={t('changes.patchesUnknown')} reason={patches.reason} />}
      {mcp.status === 'unknown' && <Reason text={t('changes.mcpUnknown')} reason={mcp.reason} />}
      <dl className={css.fields}>
        <Field label={t('changes.notReviewed')}>{changes.notReviewed}</Field>
        <Field label={t('changes.harnessEdits')}>
          <Items t={t} items={changes.harnessEdits.map(edit => ({ key: edit.file, content: <LongValue value={edit.file} /> }))} />
        </Field>
        <Field label={t('changes.approvedPlugins')}>
          <Items t={t} items={changes.approvedPlugins.map(entry => ({
            key: `${entry.plugin}@${entry.version ?? ''}`,
            content: <>{entry.plugin} {entry.version ?? t('value.none')}<span className={css.meta}>{entry.source}</span></>,
          }))} />
        </Field>
        <Field label={t('changes.patchRows')}>
          <Items t={t} items={patches.rows.map((row, index) => ({
            key: `${row.layer}#${String(index)}`,
            content: <>{row.id ?? row.name ?? t('value.none')}<span className={css.meta}><LongValue value={row.layer} /></span></>,
          }))} />
        </Field>
        <Field label={t('changes.jsValues')}>{patches.jsValues}</Field>
        <Field label={t('changes.skills')}>
          <Items t={t} items={skills.roots.map(root => ({
            key: `${root.source}:${root.path}`,
            content: <><LongValue value={root.path} /><span className={css.meta}>{root.source}</span></>,
          }))} />
        </Field>
        <Field label={t('changes.mcp')}>
          <Items t={t} items={mcp.servers.map(server => ({
            key: server.name,
            content: <>{server.name}{server.transport !== null && <span className={css.meta}>{server.transport}</span>}</>,
          }))} />
        </Field>
      </dl>
    </>
  )
}
