/**
 * The foot's Settings button, T3 Code's `SidebarUtilityMenu`
 * (`apps/web/src/components/sidebar/SidebarChrome.tsx`, MIT, © 2026 T3 Tools
 * Inc.), in upstream's `settings.launcher` seat: a 32px icon button that opens
 * Settings, in the wide sidebar and on the folded rail.
 */
import { IconSettingsOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'settings.launcher' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './Foot.module.css'

/** The button's props: what it reads of the launcher seat, and the copy. */
export type FootLauncherProps = Pick<PropsRuntime<'settings.launcher'>, 'settingsOpen' | 'settingsShortcut' | 'openSettings'> & PropsLocale<'deloSidebar'>

/**
 * Render the Settings button.
 * @param props - whether Settings is open, its shortcut and opener, and the copy.
 * @returns the button.
 */
export function FootLauncher({ settingsOpen, settingsShortcut, openSettings, t }: FootLauncherProps) {
  return (
    <div className={css.utility}>
      <Tooltip label={t('foot.settings')} side="top" delayMs={500} shortcutKeys={settingsShortcut?.keys} disabled={settingsOpen}>
        <button type="button" className={css.utilityButton} aria-label={t('foot.settings')} aria-haspopup="dialog" aria-expanded={settingsOpen}
          aria-keyshortcuts={settingsShortcut?.aria} onClick={openSettings}>
          <IconSettingsOutlineRegular size={16} className={css.utilityIcon} />
        </button>
      </Tooltip>
    </div>
  )
}
