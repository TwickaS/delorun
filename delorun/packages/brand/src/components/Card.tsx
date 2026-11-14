/**
 * A bordered card with an optional heading. The heading is an `<h3>` that names the `<section>`.
 * @module @delorun/brand/components/Card
 */
import { useId, type ReactNode } from 'react'
import css from './Card.module.css'

/** The props of {@link Card}. */
export interface CardProps {
  /** The localized heading, in sentence case; without it the card is an unlabelled box. */
  readonly title?: string | undefined
  readonly className?: string | undefined
  readonly children: ReactNode
}

/**
 * Render a card.
 * @param props - see {@link CardProps}.
 * @returns the card.
 */
export function Card({ title, className, children }: CardProps) {
  const id = useId()
  return (
    <section className={`${css.card} ${className ?? ''}`.trim()} aria-labelledby={title === undefined ? undefined : id}>
      {title === undefined ? null : <h3 id={id} className={css.title}>{title}</h3>}
      {children}
    </section>
  )
}
