/**
 * The message box's focus ring under the Delorun look. Upstream's composer editor sets `outline: none` and its card
 * shows no focus state, so a keyboard user cannot see where typing goes; this style outlines the card while its editor
 * holds keyboard focus, with upstream's focus-ring tokens, which read in light and dark.
 * @module @delorun/plugin-theme/client/focus
 */

/**
 * The composer's focus style.
 * @returns the CSS text.
 */
export function composerFocusCss(): string {
  return '[data-composer-card]:has([data-composer-input]:focus-visible){'
    + 'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}'
}
