/**
 * A short explanation under a step's controls: a heading and a row of small cards, each a title and a sentence. It
 * grows into the space the step leaves, so a step with little to choose shows what the choice is for.
 */
import type { ReactNode } from 'react'
import css from './Explain.module.css'

/** One card of the explanation. */
export interface ExplainCard {
  /** Unique within the explanation. */
  readonly key: string
  /** The card's title. */
  readonly title: string
  /** The card's sentence. */
  readonly text: string
  /** A short example drawn in code type under the sentence, such as a folder's contents, one entry per line. */
  readonly sample?: string
}

/**
 * @param props - the heading, the cards and whether the cards are numbered steps.
 * @returns the explanation.
 */
export function Explain({ heading, cards, numbered = false }: { readonly heading: string; readonly cards: readonly ExplainCard[]; readonly numbered?: boolean }): ReactNode {
  const List = numbered ? 'ol' : 'ul'
  return (
    <section className={css.explain} aria-label={heading}>
      <h3 className={css.heading}>{heading}</h3>
      <List className={css.cards}>
        {cards.map((card, index) => (
          <li key={card.key} className={css.card}>
            {numbered && <span className={css.number} aria-hidden="true">{index + 1}</span>}
            <span className={css.title}>{card.title}</span>
            <span className={css.text}>{card.text}</span>
            {card.sample !== undefined && <span className={css.sample}>{card.sample}</span>}
          </li>
        ))}
      </List>
    </section>
  )
}
