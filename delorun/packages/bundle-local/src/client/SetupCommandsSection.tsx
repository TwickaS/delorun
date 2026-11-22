/**
 * The "How Delorun runs" settings section: the choices that moved out of the browser's first-run guide and are made in a
 * terminal, each with the command that changes it. Phone access also shows whether the home has it on, read from the
 * reach status; the other rows show their command only, since the home serves no read for them.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsCard } from '@delorun/settings-controls'
import { readReachStatus } from './devices-api.ts'
import type { HostFetch } from './host-api.ts'
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

/** The request function the plugin supplies. */
export interface SetupCommandsSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
}

/** Props the renderer binds for the section. */
export type SetupCommandsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunSetupCommands'> & InjectFace<SetupCommandsSectionInjected>

/**
 * Whether the home has phone access on.
 * @param fetch - the request function.
 * @returns true or false when the home reports its reach; undefined when it has none or the status cannot be read.
 */
async function readReachOn(fetch: HostFetch): Promise<boolean | undefined> {
  try {
    const status = await readReachStatus(fetch)
    return status === undefined ? undefined : status.options.some(option => option.state !== 'off')
  } catch (error) {
    // The row then shows its command alone.
    console.warn('delorun settings: the reach status was not read', error)
    return undefined
  }
}

/**
 * Render the section.
 * @param props - the section's copy and the request function.
 * @returns the section.
 */
export function SetupCommandsSection({ t, fetch }: SetupCommandsSectionProps): ReactNode {
  const [reachOn, setReachOn] = useState<boolean | undefined>()
  useEffect(() => {
    let current = true
    void readReachOn(fetch).then((value) => { if (current) setReachOn(value) })
    return () => { current = false }
  }, [fetch])
  return <div className={css.section}>
    <h2 className={css.title}>{t('title')}</h2>
    <p className={css.intro}>{t('intro')}</p>
    <SettingsCard title={t('heading')} group="setup-commands">
      {ROWS.map(row => <div key={row} className={rowCss.row} data-setup-row={row}>
        <div className={rowCss.text}>
          <div className={rowCss.title}>{t(`${row}.title`)}</div>
          <div className={rowCss.description}>{t(`${row}.body`)}</div>
          {row === 'reach' && reachOn !== undefined && <div className={rowCss.description}>{t(reachOn ? 'reach.on' : 'reach.off')}</div>}
          <code className={commandCss.command} aria-label={t('command')}>{SETUP_COMMANDS[row]}</code>
        </div>
      </div>)}
    </SettingsCard>
  </div>
}
