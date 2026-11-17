/**
 * The replica's still: what the frame shows until the live studio arrives, and with scripts off. The server draws it
 * from the session's fixture (`StillScene.tsx`) and the live replica keeps the markup the server sent; without that
 * markup it is the session's first screen with nothing on it. It holds no picture, so it never becomes the page's
 * largest paint. Assistive technology and the keyboard skip it (`aria-hidden` and `inert`): the rail and the captions describe the session, and
 * the controls drawn in it do nothing.
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
  // The outer element hides the still from the keyboard and assistive technology; only the inner one carries the studio's
  // wrapper attribute, which the live studio's own wrapper alone is selected by together with `inert`.
  return <div {...{ [STILL_ATTRIBUTE]: width }} className={css.root} aria-hidden="true" inert>
    {markup !== undefined
      ? <div {...WRAPPER_PROPS} className={css.root} dangerouslySetInnerHTML={{ __html: markup }} />
      : <div {...WRAPPER_PROPS} className={css.root}>
          <StudioLayout file={file} width={width} screen={file.start.screen} strings={strings} screens={{
            chat: <ChatScreen events={[]} shown={0} draft="" typing={false} strings={strings} />,
            changes: null,
            versions: null,
          }} />
        </div>}
  </div>
}
