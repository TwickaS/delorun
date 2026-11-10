/**
 * Settings → Tools → Tool settings (V4.5 decision K33): every official plugin
 * with its own settings page, by its plain name, each opening that page on the
 * Plugins panel and closing Settings. The list is upstream's `plugins.item`
 * ledger, so a tool that gains settings appears without a change here.
 * @module @delo/plugin-settings-layout/client/ToolSettingsSection
 */
import { useSyncExternalStore } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ToolSettingsSection.module.css'

/** One tool with a settings page. */
export interface ToolSettingsEntry {
  /** The `plugins.item` id. */
  readonly id: string
  /** Its name in the active language. */
  readonly label: string
}

/** What the section reads and does. */
export interface ToolSettingsInjected {
  /** The tools with settings pages, in the Plugins page's order. */
  readonly tools: {
    readonly getSnapshot: () => readonly ToolSettingsEntry[]
    readonly subscribe: (listener: () => void) => () => void
  }
  /**
   * Open a tool's settings page on the Plugins panel.
   * @param id - the tool's `plugins.item` id.
   */
  readonly open: (id: string) => void
}

/** The section's props: its copy, Settings' close and its injected services. */
export type ToolSettingsSectionProps = PropsLocale<'settings.deloLayout'> & InjectFace<ToolSettingsInjected> & { readonly close: () => void }

/**
 * Render the tool list, or nothing while no tool has a settings page.
 * @param props - the copy, the services and Settings' close.
 * @returns the card.
 */
export function ToolSettingsSection({ t, tools, open, close }: ToolSettingsSectionProps) {
  const entries = useSyncExternalStore(listener => tools.subscribe(listener), () => tools.getSnapshot())
  if (entries.length === 0) return null
  return (
    <section className={css.section} aria-labelledby="delo-tool-settings">
      <div className={css.heading}>
        <h3 className={css.title} id="delo-tool-settings">{t('tools.settings')}</h3>
        <p className={css.lead}>{t('tools.settings.lead')}</p>
      </div>
      <ul className={css.card}>
        {entries.map(entry => (
          <li key={entry.id}>
            <button type="button" className={css.row} onClick={() => { open(entry.id); close() }}>
              <span className={css.name}>{entry.label}</span>
              <span className={css.action}>
                {t('tools.settings.open')}
                <IconChevronRightOutlineRegular size={14} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
