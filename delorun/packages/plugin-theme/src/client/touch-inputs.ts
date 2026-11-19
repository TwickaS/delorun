/**
 * Keeps iOS Safari from zooming the page when a field takes focus. Safari zooms on focus whenever the field's text is
 * under 16px and does not zoom back out, so on touch screens every text field, text area, selector and editable region
 * is at least 16px, whatever its component sets. The rule needs `!important` because component styles name the size on
 * a class, which outranks an element selector. `1em` in `font-size` is the parent's size, so a field in larger text keeps it.
 * Pinch zoom stays available: the viewport tag is left alone.
 * @module @delorun/plugin-theme/client/touch-inputs
 */

/** Marks the style element, so a test or a later instance can find it. */
export const TOUCH_INPUTS_ATTRIBUTE = 'data-delorun-touch-inputs'

/** The controls that take typed text; a checkbox, radio, slider, file or colour input has no text to zoom for. */
const FIELDS = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]):not([type="image"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
]

/** The rule: the fields' text is never under 16px where the main pointer is a finger. */
export const TOUCH_INPUTS_RULE = `@media (pointer: coarse) { ${FIELDS.join(', ')} { font-size: max(16px, 1em) !important; } }`

/**
 * Add the rule to the page.
 * @param doc - the studio's document.
 * @returns a function that removes it.
 */
export function installTouchInputs(doc: Document): () => void {
  const sheet = doc.createElement('style')
  sheet.setAttribute(TOUCH_INPUTS_ATTRIBUTE, '')
  sheet.textContent = TOUCH_INPUTS_RULE
  doc.head.appendChild(sheet)
  return () => { sheet.remove() }
}
