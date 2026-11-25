/**
 * The studio plugins' switches on the `@delorun/bundle-studio` card: one line per plugin the bundle inserts disabled,
 * with its own switch, so a person turns cost tracking or the Thinking tab on from the Plugins screen instead of
 * finding the row under Components on the bundle's own page.
 *
 * The entry registers into upstream's `plugins.row.state` slot, which the page renders under every row of an installed
 * bundle and on the row's own page. It renders only for the rows of {@link STUDIO_ROWS} and only on the card: the
 * stylesheet hides it on a row of the bundle's page, where the row already has a switch of its own.
 *
 * Whether a row runs comes from the page's own subject, so the switch reads the same state the bundle's page shows.
 * @module @delorun/plugin-theme/client/StudioRows
 */

import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginDetailProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { STUDIO_BUNDLE, isStudioRow } from './studio-rows.ts'
import type { StudioRowsFace } from './studio-rows-store.ts'

/** What the entry reads and writes. */
export type StudioRowsInjected = StudioRowsFace

/** The entry's props: the page's subject, its copy and the switches. */
export type StudioRowsProps = PluginDetailProps & PropsLocale<'delorunPluginList'> & InjectFace<StudioRowsInjected>

/**
 * Render one studio plugin's switch, or nothing for a row this surface does not list.
 * @param props - the page's subject, the copy and the switches.
 * @returns the line, or null.
 */
export function StudioRows({ subject, t, useRows, setEnabled }: StudioRowsProps) {
  const state = useRows(current => current)
  // The line belongs to the bundle's card; a row of its page keeps the switch the page draws.
  if (subject.kind !== 'row' || subject.pkg.name !== STUDIO_BUNDLE || !isStudioRow(subject.row.rowId)) return null
  const row = state.rows.find(each => each.rowId === subject.row.rowId)
  if (row === undefined) return null
  const busy = state.busy === row.rowId
  const failed = state.failed === row.rowId
  const locked = row.entryId === undefined || row.readOnlyReason !== undefined
  return (
    <div data-delorun-studio-row={row.rowId}>
      <span data-delorun-studio-row-name>{row.title}</span>
      {failed ? <span role="alert" data-delorun-studio-row-failed>{t('studioRowFailed')}</span> : null}
      <Switch
        checked={subject.row.enabled}
        label={t('studioRowToggle', { name: row.title })}
        disabled={busy || locked}
        onChange={(enabled) => { setEnabled(row.rowId, enabled) }}
      />
    </div>
  )
}
