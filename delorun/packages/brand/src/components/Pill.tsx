/**
 * A pill. It renders upstream's `Pill`, a button when `onClick` is given and a static capsule otherwise, and adds a tone.
 * @module @delorun/brand/components/Pill
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Pill as UpstreamPill } from '#upstream'
import css from './Pill.module.css'

/** The props of {@link Pill}. */
export type PillProps = {
  /** `accent` marks the selected or on state in the brand colour. */
  readonly tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'error'
  readonly children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

/**
 * Render a pill.
 * @param props - see {@link PillProps}; `tone` defaults to `neutral`.
 * @returns the pill.
 */
export function Pill({ tone = 'neutral', className, ...rest }: PillProps) {
  return <UpstreamPill active={tone === 'accent'} className={`${css.pill} ${className ?? ''}`.trim()} data-tone={tone} {...rest} />
}
