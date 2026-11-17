/**
 * The replica's still: the first state of a session's first chapter, drawn on the server with the brand's pieces and the
 * product's text, in the page's look. It stands in the frame until the live studio arrives, and with scripts off. It
 * holds no picture, so it never becomes the page's largest paint. Assistive technology skips it: the rail and the captions
 * describe the session, and an empty chat with a disabled send button says nothing.
 * @module @delorun/website/replica/Still
 */
import strings from 'virtual:replica-strings'
import type { ChapterFile } from './model.ts'
import { ChatScreen } from './screens/ChatScreen.tsx'
import { StudioLayout, type ReplicaWidth } from './screens/StudioLayout.tsx'
import css from './screens/studio.module.css'
import { WRAPPER_PROPS } from './wrapper.ts'

/**
 * Render the still.
 * @param props - the session's chapters and the width.
 * @returns the still.
 */
export function Still({ file, width }: { readonly file: ChapterFile, readonly width: ReplicaWidth }) {
  return <div {...WRAPPER_PROPS} className={css.root} aria-hidden="true">
    <StudioLayout file={file} width={width} screen={file.start.screen} strings={strings} screens={{
      chat: <ChatScreen events={[]} shown={0} draft="" typing={false} strings={strings} />,
      changes: null,
      versions: null,
    }} />
  </div>
}
