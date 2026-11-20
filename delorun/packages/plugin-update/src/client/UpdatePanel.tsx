/**
 * Settings → Updates: the release that runs, when it was last checked with Check now, the newer release if one is
 * known with its kind and the plugins it turns off, and Update now…, which opens the report dialog. Go back is the
 * rollback panel's. Each control reads the state's `access`: one that stays at the computer is
 * disabled with a hover text; one that needs an unlock stays enabled, and the route's refusal opens the unlock dialog.
 * The progress and outcome cards are frame-wide (see `UpdateOverlay`), so they show here and wherever the person is.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Checkbox, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RollbackBody } from '../wire.ts'
import type { Outcome, UpdateLoad } from './controller.ts'
import css from './UpdatePanel.module.css'
import { controlUse, pluralKey, refusalText, type T } from './parts.tsx'
import { RollbackPanel } from './RollbackPanel.tsx'

/** What the panel reads and does. */
export interface UpdatePanelInjected {
  readonly hooks: { readonly load: HostObservable<UpdateLoad> }
  readonly reload: () => Promise<void>
  readonly check: () => Promise<Outcome<unknown>>
  readonly openDialog: () => void
  readonly rollback: (body: RollbackBody) => Promise<Outcome<unknown>>
  /** The plugin's stored settings. */
  readonly settings: ConfigForm<UpdateSettings>
}

/** The studio's update settings. */
export interface UpdateSettings {
  /** Whether chats stopped for an update continue by themselves afterwards. */
  continueStoppedChats: boolean
}

/** Props of the `settings.section` entry. */
export type UpdatePanelProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunUpdate'> & InjectFace<UpdatePanelInjected>

/**
 * Render the section.
 * @param props - the hooks, the actions and the dictionary.
 * @returns the section.
 */
export function UpdatePanel(props: UpdatePanelProps) {
  const { t, reload } = props
  const load = props.useLoad(value => value)
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState<string | undefined>()
  useEffect(() => { void reload() }, [reload])
  if (load.status !== 'ready') {
    return <div className={css.panel}>
      <p className={css.body} role="status">{t(load.status === 'loading' ? 'loading' : 'load.failed')}</p>
      {load.status === 'error' ? <div><Button variant="outline" size="sm" onClick={() => { void reload() }}>{t('load.retry')}</Button></div> : null}
    </div>
  }
  const { state } = load
  const check = state.check
  const notice = check.notice
  const checkUse = controlUse(state, 'update-check', t)
  const beginUse = controlUse(state, 'update-begin', t)
  const busy = state.progress.kind !== 'idle'
  const runCheck = (): void => {
    setChecking(true)
    setNote(undefined)
    void props.check().then((outcome) => { if (!outcome.ok) setNote(refusalText(outcome.refusal, t)) }).finally(() => { setChecking(false) })
  }
  const kind = notice === undefined ? '' : t(notice.release.security ? 'kind.security' : `kind.${notice.kind}`)
  const plugins = notice === undefined ? '' : notice.disables === 0 ? t('plugins.none') : t(pluralKey('plugins', notice.disables), { count: notice.disables })
  return <div className={css.panel} data-update-panel>
    <p className={css.intro}>{t('intro')}</p>
    {state.available ? null : <p className={css.body} role="note" data-update-unavailable>{t('unavailable')}</p>}
    <div className={css.card}>
      <div className={css.cardRow}>
        <div className={css.main}>
          <p className={css.title}>{t('running', { version: state.release.delorun })}</p>
          <p className={css.meta}>
            {!check.enabled ? t('check.off') : check.failed === true ? t('check.failed') : check.checkedAt === undefined ? t('check.never') : t('check.when', { time: new Date(check.checkedAt).toLocaleString() })}
          </p>
          {note === undefined ? null : <p className={css.meta} role="alert">{note}</p>}
        </div>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={!check.enabled || checking || checkUse.disabled} title={checkUse.title} onClick={runCheck}>{t(checking ? 'check.checking' : 'check.now')}</Button>
        </div>
      </div>
    </div>
    {notice === undefined
      ? (check.enabled && check.checkedAt !== undefined && check.failed !== true ? <p className={css.meta}><StateDot state="done" /> {t('check.upToDate')}</p> : null)
      : <div className={`${css.card} ${css.warn}`} data-update-available={notice.release.delorun}>
        <div className={css.cardRow}>
          <div className={css.main}>
            <p className={css.title}>{t('available.title', { version: notice.release.delorun })}</p>
            <p className={css.meta}><span className={notice.release.security ? css.security : undefined}>{kind}</span>{t('separator')}{plugins}</p>
          </div>
          <div className={css.actions}>
            {beginUse.disabled
              ? <span className={css.meta}>{t('needs.computer')}</span>
              : <Button variant="primary" size="sm" disabled={!state.available || busy} title={beginUse.title} onClick={props.openDialog}>{t('now')}</Button>}
          </div>
        </div>
      </div>}
    <ContinueSetting settings={props.settings} t={t} />
    <RollbackPanel state={state} t={t} rollback={props.rollback} />
  </div>
}

/**
 * The setting that decides whether stopped chats continue after an update.
 * @param props - the settings form and the dictionary.
 * @returns the row.
 */
function ContinueSetting({ settings, t }: { readonly settings: ConfigForm<UpdateSettings>, readonly t: T }) {
  const snapshot = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const [failed, setFailed] = useState(false)
  const value = snapshot.value?.continueStoppedChats ?? true
  return <div className={css.card} data-update-continue-setting>
    <Checkbox checked={value} disabled={!snapshot.writable} label={t('continue.setting')}
      onChange={() => { setFailed(false); void settings.set('continueStoppedChats', !value).then((saved) => { setFailed(!saved) }, () => { setFailed(true) }) }} />
    <p className={css.meta}>{t('continue.setting.lead')}</p>
    {failed ? <p className={css.meta} role="alert">{t('settings.failed')}</p> : null}
  </div>
}
