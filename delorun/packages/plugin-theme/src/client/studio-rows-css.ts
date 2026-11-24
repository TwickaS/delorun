/**
 * The studio plugins' switches on the `@delorun/bundle-studio` card under the Delorun look. The card is where a person
 * looking for cost tracking or the Thinking tab actually looks, so the two rows the bundle inserts disabled are listed
 * there with their own switches rather than only under Components on the bundle's own page.
 *
 * The line is drawn by the `plugins.row.state` entry of {@link StudioRows}, which upstream's page renders under every row
 * of an installed bundle. The same slot also renders under the row on the bundle's own page, where the row already has
 * its own switch, so these rules hide the line there: the page's row carries `data-plugin-row`, the card does not.
 *
 * The rules reach upstream's stable surfaces only: `data-plugin-package` on the card and `data-plugin-row` on a row of
 * the bundle's page. The stock look drops the whole sheet, so upstream's page returns.
 * @module @delorun/plugin-theme/client/studio-rows-css
 */

import { STUDIO_BUNDLE } from './studio-rows.ts'

/** The card that lists the studio plugins. */
export const STUDIO_CARD = '[data-plugin-package="' + STUDIO_BUNDLE + '"]'

/** A row of the bundle's own page, where the row already has a switch of its own. */
export const PAGE_ROW = '[data-plugin-row]'

/** The attribute the entry marks its line with, so the rules reach it and nothing else. */
export const STUDIO_ROW_ATTRIBUTE = 'data-delorun-studio-row'

/**
 * The rules that keep the studio plugins' switches on the card alone.
 * @returns the CSS text.
 */
export function studioRowsCss(): string {
  // The line sits under the card's one-liner, level with the card head's own inset.
  const line = [
    'display:flex',
    'flex-wrap:wrap',
    'align-items:center', // us-spelling: quoted output
    'gap:8px 12px',
    'margin:0 8px 8px',
    'min-width:0',
  ].join(';')
  const name = [
    'color:var(--dsw-alias-label-secondary)', // us-spelling: quoted output
    'font-size:13px',
    'line-height:20px',
    'min-width:0',
    'overflow-wrap:anywhere',
  ].join(';')
  const failed = [
    'color:var(--dsw-alias-state-error-primary)', // us-spelling: quoted output
    'font-size:13px',
    'line-height:20px',
    'overflow-wrap:anywhere',
  ].join(';')
  return STUDIO_CARD + ' [' + STUDIO_ROW_ATTRIBUTE + ']{' + line + '}'
    + STUDIO_CARD + ' [' + STUDIO_ROW_ATTRIBUTE + '] [data-delorun-studio-row-name]{' + name + '}'
    + STUDIO_CARD + ' [' + STUDIO_ROW_ATTRIBUTE + '] [data-delorun-studio-row-failed]{' + failed + '}'
    // A row of the bundle's page keeps its own switch and gains no second one.
    + PAGE_ROW + ' [' + STUDIO_ROW_ATTRIBUTE + ']{display:none}'
}
