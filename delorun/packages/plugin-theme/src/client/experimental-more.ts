/**
 * The Experimental plugins group's More control under the Delorun look. Upstream draws it as a quiet text link beside the
 * group's heading, so a person scanning the Plugins screen reads a small word rather than a control, and cannot tell how
 * many bundles sit behind it. These rules give it the studio's secondary-button shape and state the count the page
 * carries in `data-plugin-more-count`, read through `attr()`, so nothing is read from the Host and no observer runs.
 *
 * The count is drawn as a pseudo-element, which the accessible name computation includes, so a screen reader says
 * "Show experimental · 11" once: the attribute itself is never announced. The chevron takes `order: 1` so the count
 * sits between the words and the chevron rather than after it. A page that sets no attribute, such as an older
 * upstream, matches no count rule at all, so the control keeps its shape and shows neither a separator nor a count.
 *
 * The rules reach upstream's stable surfaces only: the group's `data-plugin-group="extensions"` and the `.groupMore`
 * class, which CSS Modules hash, so it is matched by the suffix they keep. The stock look drops the whole sheet, so
 * upstream's text link returns.
 * @module @delorun/plugin-theme/client/experimental-more
 */

/** The group that holds the Experimental plugins heading and its More control. */
export const EXPERIMENTAL_GROUP = '[data-plugin-group="extensions"]'

/** Upstream's class on the More control, matched by the suffix CSS Modules keep after the hash. */
export const MORE_CONTROL = 'button[class*="groupMore"]'

/** The attribute the page sets to the number of bundles the More list holds. */
export const MORE_COUNT_ATTRIBUTE = 'data-plugin-more-count'

/**
 * The More control's rules.
 * @returns the CSS text.
 */
export function experimentalMoreCss(): string {
  const control = `${EXPERIMENTAL_GROUP} ${MORE_CONTROL}`
  const shape = [
    // The secondary button's shape: upstream's own outline hairline, the small control's radius and padding.
    'border:0',
    'box-shadow:inset 0 0 0 var(--dsh-hairline-width,0.5px) var(--dsw-alias-border-l3)',
    'border-radius:var(--dsw-radius-sm)',
    'padding:0 var(--delorun-space-3,12px)',
    // Upstream's negative margin aligns a text link with the cards; a control keeps its own edge.
    'margin-inline-end:0',
    'color:var(--dsw-alias-label-primary)', // us-spelling: quoted output
    'font-weight:500',
  ].join(';')
  const count = [
    `content:" · " attr(${MORE_COUNT_ATTRIBUTE})`,
    'font-variant-numeric:tabular-nums',
    'color:var(--dsw-alias-label-tertiary)', // us-spelling: quoted output
  ].join(';')
  return `${control}{${shape}}`
    // The chevron follows the count, so the count reads as part of the words.
    + `${control}>svg{order:1}`
    // The count, drawn only where the page states one.
    + `${control}[${MORE_COUNT_ATTRIBUTE}]::after{${count}}`
    + `@media (hover:hover){${control}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}`
}
