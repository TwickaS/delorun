/**
 * The drawn studio's sidebar, slimmed: the workspace, the new-session control, the chats and Settings. It draws no
 * control of its own: the drawn studio takes no press.
 * @module @delorun/website/replica/screens/Sidebar
 */
import type { ReplicaStrings } from '../strings.ts'
import css from './studio.module.css'

/** The props of {@link Sidebar}. */
export interface SidebarProps {
  readonly workspace: string
  /** The open chat's title first, then older chats. */
  readonly chats: readonly string[]
  readonly strings: ReplicaStrings
  /** Whether Settings is open, which marks Settings instead of the open chat. */
  readonly settings: boolean
}

/**
 * Render the sidebar.
 * @param props - see {@link SidebarProps}.
 * @returns the sidebar.
 */
export function Sidebar({ workspace, chats, strings, settings }: SidebarProps) {
  return <div className={css.sidebar}>
    <div className={css.workspace}><span className={css.badge}>{workspace.slice(0, 1).toUpperCase()}</span>{workspace}</div>
    <div className={css.newChat}>{strings.sidebar['session.new.label']}</div>
    <ul className={css.chats} aria-label={strings.sidebar['navigation.label']}>
      {chats.map((title, index) => <li key={title} className={css.chat} data-current={!settings && index === 0 ? '' : undefined}>{title}</li>)}
    </ul>
    <div className={css.settingsItem} data-current={settings ? '' : undefined}>{strings.settings.title}</div>
  </div>
}
