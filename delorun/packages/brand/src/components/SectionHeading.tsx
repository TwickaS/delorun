/**
 * A section's heading and its optional lead sentence, set large with a balanced line and tight tracking. It carries no
 * label above the heading and no number: a section is named by its heading alone.
 * @module @delorun/brand/components/SectionHeading
 */
import type { ReactNode } from 'react'
import css from './SectionHeading.module.css'

/** The props of {@link SectionHeading}. */
export interface SectionHeadingProps {
  /** The localised heading, in sentence case. */
  readonly title: ReactNode
  /** One or two localised sentences under the heading. */
  readonly lead?: ReactNode
  /** The heading level; `1` for a page's one headline, `2` (the default) for a section, `3` for a part of one. */
  readonly level?: 1 | 2 | 3
  /** The heading element's id, for a link to the section and its `aria-labelledby`. */
  readonly id?: string | undefined
  readonly className?: string | undefined
}

/**
 * Render a section heading.
 * @param props - see {@link SectionHeadingProps}.
 * @returns the heading, and the lead when given, in an `<hgroup>`.
 */
export function SectionHeading({ title, lead, level = 2, id, className }: SectionHeadingProps) {
  const Heading = level === 1 ? 'h1' : level === 3 ? 'h3' : 'h2'
  return (
    <hgroup className={`${css.group} ${className ?? ''}`.trim()} data-level={level}>
      <Heading id={id} className={css.title}>{title}</Heading>
      {lead === undefined ? null : <p className={css.lead}>{lead}</p>}
    </hgroup>
  )
}
