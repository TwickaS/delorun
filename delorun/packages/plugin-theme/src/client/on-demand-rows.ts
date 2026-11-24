/**
 * The two on-demand bundles' rows under the Delorun look. Codex subagent and Claude Code subagent are the release's
 * `ON_DEMAND_BUNDLES`: they install when a person adds them, so the Host reports them as absent from the profile with
 * the plugin manager's "this is a signed plugin pack" refusal, and the page draws that as a red "Problem" tag. Nothing
 * is broken, so the tag is wrong, and a person scanning the Experimental plugins group reads the whole list as broken.
 *
 * These rules hide that tag on those two rows and on their pages, and state what they are instead, in the words
 * {@link followOnDemandLabel} sets in `--delorun-on-demand-label`. The row keeps the page's own "Not installed" tag and
 * the Add action the downloads panel draws for a pack that is not in the home, so it reads as what it is.
 *
 * The tag is hidden only while the row also carries the page's "Not installed" tag, so a bundle that is installed and
 * genuinely broken keeps its red tag: the rule states a fact about the not-installed case, it does not silence the row.
 * The names come from upstream's own list, so a bundle that joins or leaves it needs no change here.
 *
 * The rules reach upstream's stable surfaces only: `data-plugin-package` and `data-plugin-detail` on the row and its
 * page, and the page's own tags and title row, matched by the suffix CSS Modules keep after the hash. The stock look
 * drops the whole sheet, so upstream's tag returns.
 * @module @delorun/plugin-theme/client/on-demand-rows
 */

import { ON_DEMAND_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { ON_DEMAND_LABEL } from './on-demand-label.ts'

/** The page's own status tag, matched by the suffix CSS Modules keep after the hash. */
export const STATUS_TAG = '[class*="statusTag"]'

/** The red status tag the page draws for a bundle it reports an error for. */
export const PROBLEM_TAG = `${STATUS_TAG}[data-tone="danger"]`

/** The page's "Not installed" tag, which a bundle the profile does not hold carries. */
export const NOT_INSTALLED_TAG = `${STATUS_TAG}[data-tone="outline"]`

/** The row's and the page's title line, which carries the wording. */
export const TITLE_ROW = '[class*="titleRow"]'

/**
 * The rows and pages the rules reach: one selector per on-demand bundle, for its row and for its page.
 * @returns the selectors.
 */
export function onDemandRowSelectors(): string[] {
  return ON_DEMAND_BUNDLES.flatMap(name => [
    `[data-plugin-package="${name}"]`,
    `[data-plugin-detail="${name}"]`,
  ])
}

/**
 * The rules that hide the wrong tag and state the wording.
 * @returns the CSS text, empty when the release lists no on-demand bundle.
 */
export function onDemandRowsCss(): string {
  const rows = onDemandRowSelectors()
  if (rows.length === 0) return ''
  const problems = rows.map(row => `${row}:has(${NOT_INSTALLED_TAG}) ${PROBLEM_TAG}`).join(',')
  // The pseudo-element belongs to each title line, so it is appended to every selector rather than to the list.
  const titles = rows.map(row => `${row} ${TITLE_ROW}::after`).join(',')
  // A quiet tag beside the page's own tags: a fact about the bundle, not a warning.
  const label = [
    `content:var(${ON_DEMAND_LABEL})`,
    'display:inline-flex',
    'align-items:center', // us-spelling: quoted output
    'height:18px',
    'padding:0 7px',
    'border-radius:var(--dsw-radius-xs)',
    'background:var(--dsw-alias-bg-layer-2)',
    'color:var(--dsw-alias-label-secondary)', // us-spelling: quoted output
    'font-size:10px',
    'line-height:1',
    'white-space:nowrap',
  ].join(';')
  return `${problems}{display:none}` + `${titles}{${label}}`
}
