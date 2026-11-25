/**
 * The security overview the trust badge opens (A628, L197): five rows that answer what the agent can do, whether a
 * change can be undone, who can reach the studio, what was added and whether this copy is genuine.
 *
 * The basic view opens by default and answers at a glance: when every row is green it shows one calm line and the rows
 * folded behind a disclosure; otherwise it lists the five rows, each with its status, its one sentence and, where it has
 * one, the action that fixes it, so the whole answer fits without scrolling. The advanced view, a toggle the studio
 * remembers, adds what a row means, why it has its colour, whether it is the person's choice or a fault, when each check
 * last ran, and the lists behind each row. Colour is never the only signal: each status has an icon and words.
 * @module @delorun/bundle-local/client/SecurityOverview
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconInfoOutlineRegular,
  IconWarningOutlineRegular, SegmentedControl,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { OverviewHostFacts } from './security-overview-api.ts'
import {
  overviewHeadline, overviewRows,
  type OverviewAction, type OverviewHeadline, type OverviewFacts, type OverviewRow, type OverviewRowId, type OverviewStatus,
} from './security-overview.ts'
import type { TrustBill, TrustChecks, TrustRowFreshness } from './trust-bill.ts'
import { relativeTime } from './trust-time.ts'
import css from './SecurityOverview.module.css'

/** Where the studio remembers the chosen view. */
export const OVERVIEW_VIEW_KEY = 'delorun.security.view'

/** The two views. */
export type OverviewView = 'basic' | 'advanced'

/** The docs page on how Delorun keeps a person's work safe. */
export const SECURITY_PAGE_URL = 'https://docs.delorun.com/guide/safety-and-updates/trust'

/** The overview's translate function: the trust panel's copy. */
export type OverviewTranslate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The icon of each status, beside its words and colour. */
const ICONS: Readonly<Record<OverviewStatus, ReactNode>> = {
  green: <IconCheckOutlineRegular size={14} />,
  chosen: <IconInfoOutlineRegular size={14} />,
  look: <IconWarningOutlineRegular size={14} />,
  red: <IconCloseOutlineRegular size={14} />,
}

/** The headline's icon: a row status's, or the info glyph while this copy's files are still being checked. */
const HEADLINE_ICONS: Readonly<Record<OverviewHeadline, ReactNode>> = { ...ICONS, checking: <IconInfoOutlineRegular size={14} /> }

/**
 * The remembered view.
 * @returns the view the person last chose, `basic` by default or when storage cannot be read.
 */
export function readOverviewView(): OverviewView {
  try {
    return globalThis.localStorage?.getItem(OVERVIEW_VIEW_KEY) === 'advanced' ? 'advanced' : 'basic'
  } catch (_unreadable) {
    // Storage switched off: the basic view.
    return 'basic'
  }
}

/**
 * Remember the view.
 * @param view - the view.
 */
function rememberView(view: OverviewView): void {
  try {
    globalThis.localStorage?.setItem(OVERVIEW_VIEW_KEY, view)
  } catch (_unwritable) {
    // Storage switched off: the choice lasts while the panel is open.
  }
}

/** The overview's props. */
export interface SecurityOverviewProps {
  readonly t: OverviewTranslate
  /** The trust bill and its freshness, from the badge's store. */
  readonly bill: TrustBill | null
  readonly checks: TrustChecks | null
  /** The facts from the Host's other routes, and whether the first read finished. */
  readonly facts: OverviewHostFacts
  readonly loaded: boolean
  /** Run an action of a row. */
  readonly act: (action: OverviewAction) => void
  /** The trust bill's own rows with their details and Check now, shown under "This copy of Delorun" in the advanced view. */
  readonly trustDetails: ReactNode
  /** Check now and its progress. */
  readonly checkBlock: ReactNode
  /** A message under the rows, such as an action that failed. */
  readonly message?: string | undefined
}

/**
 * The overview's content, inside the panel's dialog.
 * @param props - the copy, the facts and the actions.
 * @returns the content.
 */
export function SecurityOverview({ t, bill, checks, facts, loaded, act, trustDetails, checkBlock, message }: SecurityOverviewProps) {
  const [view, setView] = useState<OverviewView>(readOverviewView)
  const [listOpen, setListOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const viewId = useId()
  const listId = useId()
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 15_000)
    return () => { clearInterval(timer) }
  }, [])
  const all: OverviewFacts = { ...facts, bill, checks, now }
  const rows = overviewRows(all)
  const headline = overviewHeadline(rows)
  const calm = headline === 'green' && view === 'basic'
  const change = (next: OverviewView): void => {
    setView(next)
    rememberView(next)
  }
  return (
    <div className={css.overview} data-view={view}>
      <div className={css.headline} data-status={headline} aria-live="polite">
        <span className={css.headlineIcon} aria-hidden="true">{HEADLINE_ICONS[headline]}</span>
        <div className={css.headlineText}>
          <p className={css.headlineTitle}>{loaded ? t(`overview.headline.${headline}`) : t('overview.loading')}</p>
          {/* The headline is the answer; the sentence under it explains it, so it belongs to the advanced view. */}
          {loaded && !calm && view === 'advanced' && <p className={css.headlineDetail}>{t(`overview.headline.${headline}.detail`)}</p>}
        </div>
      </div>
      <SegmentedControl
        id={viewId}
        className={css.views}
        value={view}
        label={t('overview.view.label')}
        options={[{ value: 'basic', label: t('overview.view.basic') }, { value: 'advanced', label: t('overview.view.advanced') }]}
        onChange={change}
      />
      <div id={`${viewId}-${view}-panel`} role="tabpanel" aria-labelledby={`${viewId}-${view}`}>
        {calm
          ? (
            <>
              <button type="button" className={css.disclosure} aria-expanded={listOpen} aria-controls={listId} onClick={() => { setListOpen(!listOpen) }}>
                {t(listOpen ? 'overview.list.hide' : 'overview.list.show')}
                <IconChevronDownOutlineRegular size={14} className={listOpen ? css.chevronOpen : css.chevron} />
              </button>
              <ul id={listId} className={css.rows} hidden={!listOpen}>
                {rows.map(entry => <OverviewRowItem key={entry.id} t={t} row={entry} all={all} view={view} act={act} trustDetails={trustDetails} />)}
              </ul>
            </>
          )
          : (
            <ul className={css.rows}>
              {rows.map(entry => <OverviewRowItem key={entry.id} t={t} row={entry} all={all} view={view} act={act} trustDetails={trustDetails} />)}
            </ul>
          )}
        {message !== undefined && <p className={css.error} role="alert">{message}</p>}
        {/* Check now, the colours' meanings and the checks' limit explain the answer rather than give it, so they are
            the advanced view's; the basic view holds the headline and the five rows and nothing else. */}
        {view === 'advanced' && (
          <>
            <p className={css.note}>{t('overview.states')}</p>
            {checkBlock}
          </>
        )}
        <p className={css.note}>
          <a className={css.link} href={SECURITY_PAGE_URL} target="_blank" rel="noreferrer">{t('overview.learn')}</a>
        </p>
      </div>
    </div>
  )
}

/** One row's props. */
interface RowProps {
  readonly t: OverviewTranslate
  readonly row: OverviewRow
  readonly all: OverviewFacts
  readonly view: OverviewView
  readonly act: (action: OverviewAction) => void
  readonly trustDetails: ReactNode
}

/**
 * One row. The basic view shows its status (icon, words and colour), its one sentence and, where it has one, the action
 * that fixes it, so five rows answer at a glance without scrolling. The advanced view adds what the row means, why it has
 * its colour, when its check last ran and the lists behind it.
 * @param props - the copy, the row, the facts, the view and the actions.
 * @returns the row.
 */
function OverviewRowItem({ t, row, all, view, act, trustDetails }: RowProps) {
  const advanced = view === 'advanced'
  const fresh = freshnessOf(row.id, all.checks)
  return (
    <li className={css.row} data-status={row.status}>
      <div className={css.rowHead}>
        <span className={css.rowIcon} aria-hidden="true">{ICONS[row.status]}</span>
        <div className={css.rowText}>
          <p className={css.rowTitle}>
            {t(`overview.row.${row.id}`)}
            <span className={css.status}>{t(`overview.status.${row.status}`)}</span>
          </p>
          <p className={css.sentence}>{t(`overview.${row.cause}`, wordsOf(t, row))}</p>
          {advanced && fresh !== undefined && <Freshness t={t} freshness={fresh} now={all.now} />}
        </div>
        {row.action !== undefined && (
          <button type="button" className={css.action} onClick={() => { if (row.action !== undefined) act(row.action) }}>
            {t(`overview.${row.cause}.action`)}
          </button>
        )}
      </div>
      {advanced && row.status !== 'green' && (
        <div className={css.explain}>
          <dl className={css.fields}>
            <div className={css.field}>
              <dt>{t('overview.meaning')}</dt>
              <dd>{t(`overview.${row.cause}.meaning`, wordsOf(t, row))}</dd>
            </div>
            <div className={css.field}>
              <dt>{t('overview.reason')}</dt>
              <dd>
                {t(`overview.${row.cause}.reason`, wordsOf(t, row))}
                {row.kind !== undefined && <>{' '}{t(row.kind === 'choice' ? 'overview.kind.choice' : 'overview.kind.fault')}</>}
                {row.chosenAt !== undefined && <>{' '}{t('overview.chosenAt', { time: exactTime(t, row.chosenAt) })}</>}
              </dd>
            </div>
          </dl>
        </div>
      )}
      {advanced && <Breakdown t={t} row={row} all={all} trustDetails={trustDetails} />}
    </li>
  )
}

/**
 * The words a row's sentences use: its params, with PIN mode's state worded.
 * @param t - the copy.
 * @param row - the row.
 * @returns the params.
 */
function wordsOf(t: OverviewTranslate, row: OverviewRow): Readonly<Record<string, string | number>> {
  const pin = row.params['pin']
  return pin === undefined ? row.params : { ...row.params, pin: t(`overview.pin.${String(pin)}`) }
}

/**
 * A time in the panel's locale.
 * @param t - the copy, whose `time.locale` names the locale.
 * @param at - milliseconds since the epoch.
 * @returns the formatted time.
 */
function exactTime(t: OverviewTranslate, at: number): string {
  return new Intl.DateTimeFormat(t('time.locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

/**
 * Which freshness a row shows: the release's for this copy, the plugins' for add-ons, none for rows read from settings.
 * @param id - the row.
 * @param checks - how fresh each trust row is.
 * @returns the freshness, or `undefined`.
 */
function freshnessOf(id: OverviewRowId, checks: TrustChecks | null): TrustRowFreshness | undefined {
  if (checks === null) return undefined
  if (id === 'copy') return checks.release
  if (id === 'addons') return checks.plugins
  return undefined
}

/**
 * "Checking…" while a check runs, otherwise how long ago it ran, with the exact time on hover.
 * @param props - the copy, the freshness and the clock.
 * @param props.t - the copy.
 * @param props.freshness - the freshness.
 * @param props.now - the clock, in milliseconds since the epoch.
 * @returns the line.
 */
function Freshness({ t, freshness, now }: { readonly t: OverviewTranslate, readonly freshness: TrustRowFreshness, readonly now: number }) {
  if (freshness.running) return <p className={css.fresh}>{t('fresh.checking')}</p>
  if (freshness.at === null) return <p className={css.fresh}>{t('fresh.never')}</p>
  const ago = relativeTime(t('time.locale'), freshness.at, now)
  if (ago === undefined) return null
  return (
    <p className={css.fresh}>
      <time dateTime={freshness.at} title={exactTime(t, Date.parse(freshness.at))}>
        {ago.kind === 'just-now' ? t('fresh.justNow') : t('fresh.ago', { ago: ago.text })}
      </time>
    </p>
  )
}

/**
 * The advanced view's breakdown of a row: what is checked, and the lists behind it.
 * @param props - the copy, the row, the facts and the trust bill's own details.
 * @param props.t - the copy.
 * @param props.row - the row.
 * @param props.all - the facts.
 * @param props.trustDetails - the trust bill's rows with their details.
 * @returns the breakdown.
 */
function Breakdown({ t, row, all, trustDetails }: { readonly t: OverviewTranslate, readonly row: OverviewRow, readonly all: OverviewFacts, readonly trustDetails: ReactNode }) {
  return (
    <div className={css.breakdown}>
      <p className={css.subhead}>{t('overview.advanced.checked')}</p>
      <p className={css.line}>{t(`overview.${row.id}.checked`)}</p>
      {row.id === 'reach' && <Devices t={t} all={all} />}
      {row.id === 'addons' && <Addons t={t} all={all} />}
      {row.id === 'copy' && trustDetails}
    </div>
  )
}

/**
 * The paired devices with when each was last seen.
 * @param props - the copy and the facts.
 * @param props.t - the copy.
 * @param props.all - the facts.
 * @returns the list.
 */
function Devices({ t, all }: { readonly t: OverviewTranslate, readonly all: OverviewFacts }) {
  return (
    <>
      <p className={css.subhead}>{t('overview.advanced.devices')}</p>
      {all.devices === null
        ? <p className={css.line}>{t('overview.advanced.unread')}</p>
        : all.devices.length === 0
          ? <p className={css.line}>{t('overview.advanced.none')}</p>
          : (
            <ul className={css.list}>
              {all.devices.map((device) => {
                const ago = device.lastSignInAt === null ? undefined : relativeTime(t('time.locale'), new Date(device.lastSignInAt).toISOString(), all.now)
                return (
                  <li key={device.id}>
                    {ago === undefined
                      ? t('overview.advanced.deviceNever', { device: device.label })
                      : t('overview.advanced.device', { device: device.label, ago: ago.kind === 'just-now' ? t('fresh.justNowShort') : ago.text })}
                  </li>
                )
              })}
            </ul>
          )}
    </>
  )
}

/**
 * The plugins, MCP servers and external agents.
 * @param props - the copy and the facts.
 * @param props.t - the copy.
 * @param props.all - the facts.
 * @returns the lists.
 */
function Addons({ t, all }: { readonly t: OverviewTranslate, readonly all: OverviewFacts }) {
  const plugins = all.bill?.plugins.entries
  const servers = all.bill?.mcp.servers
  const names = (items: readonly string[] | undefined): ReactNode => items === undefined
    ? <p className={css.line}>{t('overview.advanced.unread')}</p>
    : items.length === 0 ? <p className={css.line}>{t('overview.advanced.none')}</p> : <ul className={css.list}>{items.map(item => <li key={item}>{item}</li>)}</ul>
  return (
    <>
      <p className={css.subhead}>{t('overview.advanced.plugins')}</p>
      {names(plugins?.map(entry => `${entry.name} ${entry.version ?? ''}`.trim()))}
      <p className={css.subhead}>{t('overview.advanced.mcp')}</p>
      {names(servers?.map(server => server.name))}
      <p className={css.subhead}>{t('overview.advanced.agents')}</p>
      {names(all.agentLevels?.map(entry => t('overview.advanced.agent', { agent: entry.provider, level: entry.level })))}
    </>
  )
}
