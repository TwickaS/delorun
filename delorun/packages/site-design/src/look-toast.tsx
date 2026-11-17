/**
 * The toast that follows a change of look: what changed, and the way back by name. The library's toaster is mounted once
 * per site and shows one toast at a time.
 *
 * @module @delorun/site-design/look-toast
 */
import { showToast, Toaster } from '../../brand/src/toast.web.tsx'
import { setLook } from './look-store.ts'
import type { Look } from './looks.ts'
import type { ThemeCopy } from './shell-copy.ts'

/**
 * Says what a change did. A new theme names the theme and offers the earlier one; a switch between light and dark names
 * the scheme; "Back to how it started" says so and offers nothing, since it is itself the way back.
 * @param copy - the theme control's text.
 * @param previous - the look before.
 * @param next - the look after.
 */
export function announceLook(copy: ThemeCopy, previous: Look, next: Look): void {
  const scheme = (look: Look): string => look.scheme === 'dark' ? copy.dark : copy.light
  if (previous.look !== next.look) {
    showToast({ message: copy.toast.theme(copy.names[next.look]), action: { label: copy.toast.undo(copy.names[previous.look]), onClick: () => setLook(previous) } })
  } else if (previous.scheme !== next.scheme) {
    showToast({ message: copy.toast.scheme(scheme(next)), action: { label: copy.toast.undo(scheme(previous)), onClick: () => setLook(previous) } })
  }
}

/**
 * Says the page is back to how it started.
 * @param copy - the theme control's text.
 */
export function announceReset(copy: ThemeCopy): void {
  showToast({ message: copy.toast.reset })
}

/**
 * The toaster; mount it once at the end of the page.
 * @param props.copy - the theme control's text.
 * @returns the toaster.
 */
export function LookToaster({ copy }: { copy: ThemeCopy }) {
  return <Toaster label={copy.toast.region} />
}
