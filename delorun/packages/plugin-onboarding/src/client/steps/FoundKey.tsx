/**
 * The words about a key Delorun already has: where it came from and, behind a disclosure, how Delorun knows. It holds a
 * source kind and a variable name, never a key.
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import type { KeySource } from '../../wire.ts'
import type { StepServices } from '../types.ts'
import css from './models.module.css'

/**
 * @param t - the dictionary lookup.
 * @param source - where the key came from, when the host said.
 * @returns the sentence that says so, or the honest "already has a key" when the source is not known.
 */
export function sourceLine(t: StepServices['t'], source: KeySource | undefined): string {
  if (source === undefined || source.kind === 'unknown') return t('providers.source.unknown')
  return t(`providers.source.${source.kind}`, { variable: source.variable ?? t('providers.source.variable') })
}

/** The props of the explanation. */
interface FoundKeyProps {
  /** The dictionary lookup. */
  readonly t: StepServices['t']
  /** Where the key came from, when the host said. */
  readonly source: KeySource | undefined
}

/**
 * The source line and the "How does Delorun know?" disclosure, as one group a screen reader reads as "Key saved. From …".
 * @param props - the lookup and the source.
 * @returns the group.
 */
export function FoundKey({ t, source }: FoundKeyProps): ReactNode {
  const id = useId()
  const line = sourceLine(t, source)
  return (
    <div className={css.found}>
      <p id={`${id}-source`} className={css.source} aria-label={t('providers.source.label', { source: line })}>{line}</p>
      <details className={css.how}>
        <summary className={css.moreSummary}>{t('providers.how')}</summary>
        <p className={css.howBody}>{t('providers.how.body')}</p>
      </details>
    </div>
  )
}
