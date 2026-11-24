/**
 * The "How Delorun runs" settings section: how much Delorun asks, running in the background, the studio's port and phone
 * access, each changed here with the terminal command that makes the same change shown beneath it. Dangerous mode, the
 * port and phone access are changed at the home's own computer; any other studio shows what it may change and a line that
 * says where the rest is answered. The home refuses what the studio did not check, so the page's own checks are for the
 * person, not the defence.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button } from '@delorun/brand'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { RadioList, SettingsCard, type RadioRow } from '@delorun/settings-controls'
import { GateFailure } from './GateNotice.tsx'
import type { HostFetch, Loaded } from './host-api.ts'
import { readRunState, restartHome, setBackground, setPort, setPrompts, type PromptsChoice, type RunState } from './run-settings-api.ts'
import { DangerousDialog, runFailureText, type RunTranslate } from './RunDangerous.tsx'
import { ReachRow } from './RunReach.tsx'
import css from './SettingsSection.module.css'
import rowCss from './SettingsRow.module.css'
import commandCss from './SetupCommandsSection.module.css'

/** The commands the rows show, by row. */
export const SETUP_COMMANDS = {
  prompts: 'delorun setup prompts',
  background: 'delorun setup background',
  profile: 'delorun setup profile',
  reach: 'delorun setup reach',
} as const

/** The rows in screen order. */
const ROWS = ['prompts', 'background', 'profile', 'reach'] as const

/** The request function and what the section opens. */
export interface SetupCommandsSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Whether this studio runs on the home's own computer, where dangerous mode, the port and phone access are changed. */
  atComputer: () => boolean
  /** Opens the PIN mode section. */
  openPin: () => void
}

/** Props the renderer binds for the section. */
export type SetupCommandsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunSetupCommands'> & InjectFace<SetupCommandsSectionInjected>

/** The ports a studio may use without privileges, as the home checks them. */
const PORT = /^\d{4,5}$/u

/**
 * Whether a typed port is one the home accepts.
 * @param text - what the person typed.
 * @returns whether it is a whole number from 1024 to 65535.
 */
export function isUsablePort(text: string): boolean {
  const port = Number(text.trim())
  return PORT.test(text.trim()) && port >= 1024 && port <= 65_535
}

/**
 * Render the section.
 * @param props - the section's copy, the request function and where the studio runs.
 * @returns the section.
 */
export function SetupCommandsSection({ t, fetch, atComputer, openPin }: SetupCommandsSectionProps): ReactNode {
  const [state, setState] = useState<Loaded<RunState>>({ kind: 'loading' })
  const [restart, setRestart] = useState(false)
  const computer = atComputer()
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState({ kind: 'ready', value: await readRunState(fetch) })
    } catch (error) {
      setState({ kind: 'failed', text: runFailureText(t, error) })
    }
  }, [fetch, t])
  useEffect(() => { void refresh() }, [refresh])
  const loaded = state.kind === 'ready' ? state.value : undefined
  return <div className={css.section}>
    <h2 className={css.title}>{t('title')}</h2>
    <p className={css.intro}>{t('intro')}</p>
    {computer ? null : <p className={css.intro} data-run-away>{t('atComputer')}</p>}
    {state.kind === 'failed' ? <p className={commandCss.failed} role="alert">{state.text}</p> : null}
    {loaded !== undefined && !loaded.recorded ? <p className={css.intro} role="status" data-run-not-set-up>{t('notSetUp')}</p> : null}
    <SettingsCard title={t('heading')} group="setup-commands">
      {ROWS.map(row => <div key={row} className={rowCss.row} data-setup-row={row}>
        <div className={rowCss.text}>
          <div className={rowCss.title}>{t(`${row}.title`)}</div>
          <div className={rowCss.description}>{t(`${row}.body`)}</div>
          {loaded === undefined ? null : <Controls row={row} t={t} fetch={fetch} state={loaded} computer={computer} openPin={openPin}
            onChanged={() => { void refresh() }} onRestart={() => { setRestart(true) }} />}
          <code className={commandCss.command} aria-label={t('command')}>{SETUP_COMMANDS[row]}</code>
        </div>
      </div>)}
    </SettingsCard>
    {restart ? <RestartNote t={t} fetch={fetch} /> : null}
  </div>
}

/** What one row shows under its text. */
interface ControlsProps {
  readonly row: (typeof ROWS)[number]
  readonly t: RunTranslate
  readonly fetch: HostFetch
  readonly state: RunState
  readonly computer: boolean
  readonly openPin: () => void
  readonly onChanged: () => void
  readonly onRestart: () => void
}

/**
 * Dispatch a row to its control.
 * @param props - see {@link ControlsProps}.
 * @returns the row's control.
 */
function Controls({ row, t, fetch, state, computer, openPin, onChanged, onRestart }: ControlsProps): ReactNode {
  switch (row) {
    case 'prompts': return <PromptsControl t={t} fetch={fetch} state={state} computer={computer} onChanged={onChanged} onRestart={onRestart} />
    case 'background': return <BackgroundControl t={t} fetch={fetch} state={state} onChanged={onChanged} onRestart={onRestart} />
    case 'profile': return <PortControl t={t} fetch={fetch} state={state} computer={computer} onChanged={onChanged} onRestart={onRestart} />
    case 'reach': return <ReachRow t={t} fetch={fetch} state={state} computer={computer} openPin={openPin} onChanged={onChanged} />
    /* v8 ignore next 2 -- ROWS is a closed list, so the default holds no reachable statement. */
    default: return row satisfies never
  }
}

/**
 * How much Delorun asks: the three answers, and the dialog that turns dangerous mode on at the computer.
 * @param props - the copy, the request function, the state and what runs after a change.
 * @returns the control.
 */
function PromptsControl({ t, fetch, state, computer, onChanged, onRestart }: Pick<ControlsProps, 't' | 'fetch' | 'state' | 'computer' | 'onChanged' | 'onRestart'>): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [dialog, setDialog] = useState(false)
  const [away, setAway] = useState(false)
  const rows: readonly RadioRow<PromptsChoice>[] = (['safer', 'stock', 'dangerous'] as const).map(value => ({ value, label: t(`prompts.${value}`), detail: <span className={rowCss.description}>{t(`prompts.${value}.body`)}</span> }))
  const choose = async (next: PromptsChoice): Promise<void> => {
    setFailure(undefined)
    setAway(false)
    if (next === 'dangerous') {
      if (computer) setDialog(true)
      else setAway(true)
      return
    }
    setBusy(true)
    try {
      if ((await setPrompts(fetch, next)).restartNeeded) onRestart()
      onChanged()
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  return <div className={commandCss.controls}>
    <RadioList label={t('prompts.label')} value={state.prompts} rows={rows} disabled={busy || !state.recorded} onChange={(next) => { void choose(next) }} />
    {state.dangerous === 'on' ? <p className={commandCss.note} role="status">{t('dangerous.on')}</p> : null}
    {state.dangerous === 'inactive' ? <p className={commandCss.failed} role="status">{t('dangerous.inactive')}</p> : null}
    {away ? <p className={commandCss.note} role="status">{t('prompts.dangerous.away')}</p> : null}
    {failure === undefined ? null : <GateFailure t={t} error={failure} text={runFailureText(t, failure)} className={commandCss.failed} />}
    {dialog ? <DangerousDialog t={t} fetch={fetch} onClose={() => { setDialog(false) }} onDone={(restartNeeded) => { setDialog(false); if (restartNeeded) onRestart(); onChanged() }} /> : null}
  </div>
}

/**
 * The background switch.
 * @param props - the copy, the request function, the state and what runs after a change.
 * @returns the control.
 */
function BackgroundControl({ t, fetch, state, onChanged, onRestart }: Pick<ControlsProps, 't' | 'fetch' | 'state' | 'onChanged' | 'onRestart'>): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [changed, setChanged] = useState(false)
  const turn = async (next: boolean): Promise<void> => {
    setFailure(undefined)
    setBusy(true)
    try {
      if ((await setBackground(fetch, next)).restartNeeded) onRestart()
      setChanged(true)
      onChanged()
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  return <div className={commandCss.controls}>
    <Switch checked={state.background} label={t('background.switch')} disabled={busy || !state.recorded} onChange={(next) => { void turn(next) }} />
    {changed ? <p className={commandCss.note} role="status">{t('background.next')}</p> : null}
    {failure === undefined ? null : <GateFailure t={t} error={failure} text={runFailureText(t, failure)} className={commandCss.failed} />}
  </div>
}

/**
 * The studio's port: what it is now and next, and the field that changes it at the computer.
 * @param props - the copy, the request function, the state and what runs after a change.
 * @returns the control.
 */
function PortControl({ t, fetch, state, computer, onChanged, onRestart }: Pick<ControlsProps, 't' | 'fetch' | 'state' | 'computer' | 'onChanged' | 'onRestart'>): ReactNode {
  const [typed, setTyped] = useState(String(state.port.chosen))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [saved, setSaved] = useState<number | undefined>()
  const change = async (): Promise<void> => {
    setFailure(undefined)
    setBusy(true)
    try {
      const written = await setPort(fetch, Number(typed.trim()))
      setSaved(written.port)
      if (written.restartNeeded) onRestart()
      onChanged()
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  return <div className={commandCss.controls}>
    {state.port.running === null ? null : <p className={commandCss.note}>{t('port.now', { port: String(state.port.running) })}</p>}
    <p className={commandCss.note}>{t('port.next', { port: String(state.port.chosen) })}</p>
    {computer
      ? <form className={commandCss.inline} onSubmit={(event) => { event.preventDefault(); if (isUsablePort(typed)) void change() }}>
        <Input value={typed} inputMode="numeric" aria-label={t('port.label')} autoComplete="off" maxLength={5} onChange={(event) => { setTyped(event.target.value) }} />
        <Button variant="secondary" size="sm" type="submit" disabled={busy || !state.recorded || !isUsablePort(typed)}>{t('port.action')}</Button>
      </form>
      : null}
    {computer && typed !== '' && !isUsablePort(typed) ? <p className={commandCss.note}>{t('port.invalid')}</p> : null}
    {saved === undefined ? null : <p className={commandCss.note} role="status">{t('port.saved', { port: String(saved) })}</p>}
    {failure === undefined ? null : <p className={commandCss.failed} role="alert">{runFailureText(t, failure)}</p>}
  </div>
}

/**
 * The line that says Delorun restarts to apply a change, and the button that restarts it.
 * @param props - the copy and the request function.
 * @returns the note.
 */
function RestartNote({ t, fetch }: { readonly t: RunTranslate; readonly fetch: HostFetch }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState<number | undefined>()
  const [failure, setFailure] = useState<unknown>()
  const restart = async (): Promise<void> => {
    setFailure(undefined)
    setBusy(true)
    try {
      setWaiting(await restartHome(fetch))
    } catch (error) {
      setFailure(error)
      setBusy(false)
    }
  }
  return <div className={commandCss.panel} data-run-restart>
    <p>{t('restart.hint')}</p>
    <div className={commandCss.inline}>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => { void restart() }}>{t(busy ? 'restart.busy' : 'restart.action')}</Button>
    </div>
    {waiting === undefined ? null : <p className={commandCss.note} role="status">{waiting === 0 ? t('restart.begun') : t('restart.chats', { count: String(waiting) })}</p>}
    {failure === undefined ? null : <p className={commandCss.failed} role="alert">{runFailureText(t, failure)}</p>}
  </div>
}
