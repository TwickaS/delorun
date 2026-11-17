/**
 * One choice from a short list, shown as the studio's selector button with its menu instead of the browser's own select.
 * The label's `htmlFor` names the button, so the label names it for assistive technology.
 */
import { useState } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChoiceSelect.module.css'

/** One entry of {@link ChoiceSelect}. */
export interface Choice {
  /** The value the choice reports. */
  readonly id: string
  /** The words shown for it. */
  readonly label: string
}

/**
 * Render the selector.
 * @param props.id - the button's id, which the field's label points at.
 * @param props.value - the chosen entry's id.
 * @param props.choices - the entries, in menu order.
 * @param props.onChange - called with the id of the entry the person picks.
 * @returns the selector button and its menu.
 */
export function ChoiceSelect({ id, value, choices, onChange }: {
  readonly id: string
  readonly value: string
  readonly choices: readonly Choice[]
  readonly onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = choices.find(choice => choice.id === value) ?? choices[0]
  return <Menu open={open} onClose={() => { setOpen(false) }} portal align="start" minWidthFromAnchor selectedId={value}
    items={choices.map(choice => ({ id: choice.id, label: choice.label }))}
    onSelect={(picked) => { setOpen(false); onChange(picked) }}
    anchor={<button type="button" id={id} className={css.selector} aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setOpen(!open) }}>
      <span className={css.label}>{current?.label ?? ''}</span>
      <IconChevronDownOutlineRegular className={css.chevron} />
    </button>} />
}
