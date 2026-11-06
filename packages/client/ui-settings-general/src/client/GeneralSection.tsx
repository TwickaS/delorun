/**
 * The General section: one column rendering feature-owned item contributions,
 * or, for a card of a grouped Settings layout, the rows the card names.
 */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GeneralSection.module.css'

/** Full component props: section owner share plus item render share. */
export type GeneralSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.general.item'>

/**
 * Render the General section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSection({ renderSlot, items }: GeneralSectionComponentProps) {
  if (items !== undefined) {
    return (
      <div className={css.rows}>
        {items.map(id => (
          <div key={id} className={css.cardRow} data-settings-anchor={id}>
            {renderSlot('settings.general.item', {}, { only: id })}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className={css.section}>
      {renderSlot('settings.general.item', {})}
    </div>
  )
}
