/**
 * The replica's still: what the frame shows until the live studio arrives, and with scripts off. The server draws it
 * from the session's fixture (`StillScene.tsx`) and the live replica keeps the markup the server sent; without that
 * markup it is the session's first screen with nothing on it. It holds no picture, so it never becomes the page's
 * largest paint. Assistive technology skips it: the rail and the captions describe the session.
 * @module @delorun/website/replica/Still
 */
import strings from 'virtual:replica-strings'
import type { ChapterFile } from './model.ts'
import { ChatScreen } from './screens/ChatScreen.tsx'
import { StudioLayout, type ReplicaWidth } from './screens/StudioLayout.tsx'
import css from './screens/studio.module.css'
import { STILL_ATTRIBUTE, WRAPPER_PROPS } from './wrapper.ts'

/**
 * Render the still.
 * @param props - the session's chapters, the width, and the still's markup as the server drew it.
 * @returns the still.
 */
export function Still({ file, width, markup }: { readonly file: ChapterFile, readonly width: ReplicaWidth, readonly markup?: string | undefined }) {
  const marks = { ...WRAPPER_PROPS, [STILL_ATTRIBUTE]: width }
  if (markup !== undefined) return <div {...marks} className={css.root} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />
  return <div {...marks} className={css.root} aria-hidden="true">
    <StudioLayout file={file} width={width} screen={file.start.screen} strings={strings} screens={{
      chat: <ChatScreen events={[]} shown={0} draft="" typing={false} strings={strings} />,
      changes: null,
      versions: null,
    }} />
  </div>
}
