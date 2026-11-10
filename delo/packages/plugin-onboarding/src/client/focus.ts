/**
 * Where focus goes when the guide closes and nothing behind it took focus back: the page's message box, as upstream's
 * composer restores its own keyboard position, and otherwise the page's first control.
 * @module @delo/plugin-onboarding/client/focus
 */
import { focusWithoutRing, isMobileDevice } from '@deepseek-ai/dsh-client-ui-primitives'

/** The controls upstream's modal layer treats as focusable. */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

/**
 * Move focus into the page after the guide closed, when focus was left on the document body. On a phone or tablet the
 * message box's card takes focus, so the on-screen keyboard stays down, as upstream's composer does after a read-only
 * phase; elsewhere the message box itself does. Without a message box the page's first control takes focus.
 * @param root - the page's root, no longer inert.
 */
export function landFocus(root: HTMLElement): void {
  const active = root.ownerDocument.activeElement
  if (active !== null && active !== root.ownerDocument.body) return
  const composer = isMobileDevice()
    ? root.querySelector<HTMLElement>('[data-composer-card]')
    : root.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
  const target = composer ?? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find(each => each.closest('[inert], [hidden]') === null)
  if (target !== undefined) focusWithoutRing(target, { preventScroll: true })
}
