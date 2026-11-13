/**
 * The card every Delo Settings section is built from: an `<h3>` heading in
 * sentence case, an optional one-sentence description, then a bordered box,
 * with the `<section>` labelled by the heading. The heading reads the
 * Settings panel's `--dsh-settings-card-heading-*` properties, so it matches
 * the cards the panel draws for General rows, and it falls back to the same
 * look where no layout sets them. {@link cardCss} holds the classes of the
 * blocks and rows inside a box.
 * @module @delo/settings-controls/SettingsCard
 */
import { useId, type ReactNode } from 'react'
import css from './SettingsCard.module.css'

/**
 * The class names of a card's parts: `stack` (cards of one section, 24 px apart, with a failure line under them),
 * `block` (one setting in a box, hairlines between blocks), `row` (a setting's text, then its control at the right
 * edge), `failure` (a failed write) and the {@link SettingHeading} parts.
 */
export const cardCss = css

/** The props of {@link SettingsCard}. */
export interface SettingsCardProps {
  /** The localized heading, in sentence case. */
  readonly title: string
  /** One short localized sentence between the heading and the box. */
  readonly description?: string | undefined
  /** The heading's id, which names the `<section>`; a generated one when absent. */
  readonly id?: string | undefined
  /** A class added to the box, for a section's own geometry. */
  readonly className?: string | undefined
  /** The `data-group` attribute of the `<section>`, which tests and styles may select. */
  readonly group?: string | undefined
  /** The settings or rows the box holds. */
  readonly children: ReactNode
}

/**
 * Render one card: the heading, the description, then the box 8 px below.
 * @param props - see {@link SettingsCardProps}.
 * @returns the card's `<section>`.
 */
export function SettingsCard({ title, description, id, className, group, children }: SettingsCardProps) {
  const generated = useId()
  const headingId = id ?? generated
  return (
    <section className={css.card} aria-labelledby={headingId} data-group={group}>
      <h3 id={headingId} className={css.heading}>{title}</h3>
      {description !== undefined && <p className={css.description}>{description}</p>}
      <div className={className === undefined ? css.box : `${css.box} ${className}`}>{children}</div>
    </section>
  )
}

/**
 * Render the title and the help of one setting in a card.
 * @param props - the title's id, which a control may be named by, the title and the optional help.
 * @returns the title and help.
 */
export function SettingHeading({ id, title, lead }: { readonly id?: string | undefined; readonly title: string; readonly lead?: string | undefined }) {
  return (
    <div className={css.settingHeading}>
      <h4 id={id} className={css.title}>{title}</h4>
      {lead !== undefined && <p className={css.lead}>{lead}</p>}
    </div>
  )
}
