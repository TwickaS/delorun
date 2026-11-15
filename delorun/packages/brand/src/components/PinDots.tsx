/**
 * A row of dots, one per entered character, with at least `minimum` empty slots. It carries no entered value, in text
 * or in an attribute, and is hidden from assistive technology.
 * @module @delorun/brand/components/PinDots
 */
import css from './PinDots.module.css'

/** The props of {@link PinDots}. */
export interface PinDotsProps {
  /** How many characters are entered. */
  readonly count: number
  /** The fewest slots to show. */
  readonly minimum: number
  readonly tone?: 'neutral' | 'error'
  /** Whether the row shakes once, which a wrong entry sets; reduced motion removes the movement. */
  readonly shake?: boolean
}

/**
 * Render the dots.
 * @param props - see {@link PinDotsProps}.
 * @returns the dots.
 */
export function PinDots({ count, minimum, tone = 'neutral', shake = false }: PinDotsProps) {
  return (
    <div className={css.dots} aria-hidden="true" data-dots={count} data-tone={tone} data-shake={shake ? '' : undefined}>
      {Array.from({ length: Math.max(minimum, count) }, (_, index) => <span key={index} className={index < count ? `${css.dot} ${css.filled}` : css.dot} />)}
    </div>
  )
}
