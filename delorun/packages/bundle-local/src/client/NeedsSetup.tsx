/**
 * The "Needs setup · <reason>" state of a Plugins row, with the action that fixes it: a command with a copy button, a link
 * to a settings section, or a link to the docs. It renders for the row slot of the bundle's list and for a row's own page,
 * shows nothing while the row's needs are met, and on a bundle's page reports a declaration the Host could not read.
 * The state is the Host's latest check; it re-reads when the component mounts and when the window regains focus.
 * @module @delorun/bundle-local/client/NeedsSetup
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'plugins.row.state' and 'plugins.detail.section' SlotMap entries.
import type { PluginDetailProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
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

/** The fix's control. */
function Fix({ fix, t, openSettings, copy }: { readonly fix: RequirementFix, readonly t: Translate } & Pick<NeedsSetupInjected, 'openSettings' | 'copy'>): ReactNode {
  switch (fix.kind) {
    case 'command': return <CommandFix command={fix.command} t={t} copy={copy} />
    case 'settings':
      return <Button variant="outline" onClick={() => { openSettings(fix.section) }}>{t('openSettings')}</Button>
    case 'docs':
      return <a className={css.link} href={fix.url} target="_blank" rel="noreferrer noopener">{t('openDocs')}</a>
  }
}

/**
 * Render the state of one row, or a bundle's unreadable declaration.
 * @param props - the subject, the copy and the page's check.
 * @returns the state, or nothing when the subject's needs are met.
 */
export function NeedsSetup({ subject, t, store, openSettings, copy }: NeedsSetupProps): ReactNode {
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
      <Fix fix={row.fix} t={t} openSettings={openSettings} copy={copy} />
    </div>
  )
}
