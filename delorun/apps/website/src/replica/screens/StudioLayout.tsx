/**
 * The drawn studio's frame: the sidebar at desktop width, a header naming what is open, and the screens stacked so a
 * real section keeps its state while another screen shows. The still and the live replica both draw it.
 * @module @delorun/website/replica/screens/StudioLayout
 */
import type { ReactNode } from 'react'
import { REPLICA_COPY } from '../copy.ts'
import type { ChapterFile, StudioScreen } from '../model.ts'
import type { ReplicaStrings } from '../strings.ts'
import { Sidebar } from './Sidebar.tsx'
import css from './studio.module.css'

/** The two widths the replica draws. */
export type ReplicaWidth = 'desktop' | 'phone'

/** The props of {@link StudioLayout}. */
export interface StudioLayoutProps {
  readonly file: ChapterFile
  readonly width: ReplicaWidth
  readonly screen: StudioScreen
  readonly strings: ReplicaStrings
  /** Each screen's content. */
  readonly screens: Readonly<Record<StudioScreen, ReactNode>>
}

/**
 * The header's text for a screen.
 * @param screen - the screen.
 * @param file - the session, for the chat's title.
 * @param strings - the product text.
 * @returns the text.
 */
function heading(screen: StudioScreen, file: ChapterFile, strings: ReplicaStrings): string {
  switch (screen) {
    case 'chat': return file.chats[0] ?? ''
    case 'changes': return `${strings.settings.title} › ${strings.layout['page.changes']}`
    case 'versions': return `${strings.settings.title} › ${strings.layout['page.setupVersions']}`
  }
}

/**
 * Render the frame.
 * @param props - see {@link StudioLayoutProps}.
 * @returns the drawn studio's layout.
 */
export function StudioLayout({ file, width, screen, strings, screens }: StudioLayoutProps) {
  const settings = screen === 'changes' || screen === 'versions'
  return <div className={css.layout} data-width={width}>
    {width === 'desktop' ? <Sidebar workspace={file.workspace} chats={file.chats} strings={strings} settings={settings} /> : null}
    <div className={css.main}>
      <div className={css.header}>{heading(screen, file, strings)}</div>
      <div className={css.screens}>
        {(Object.keys(screens) as StudioScreen[]).map(name => <div key={name} className={css.screen} data-screen={name} data-active={name === screen ? '' : undefined}>{screens[name]}</div>)}
      </div>
    </div>
  </div>
}
