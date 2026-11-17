/**
 * The chip beside a feature that a preview flag shows: the word "Preview", small and muted, with a tooltip that says
 * what a preview is. It is a label, not a badge: no fill colour, no icon and no motion.
 * @module @delorun/preview-flags/client/PreviewChip
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { PreviewFlagLocaleKey } from './locales.ts'
import css from './PreviewChip.module.css'

/** The props of {@link PreviewChip}. */
export interface PreviewChipProps {
  /**
   * The plugin's bound translate function, whose dictionaries include this package's (`@delorun/preview-flags/locales`).
   * @param key - one of the chip's keys.
   * @returns the words in the studio's language.
   */
  readonly t: (key: PreviewFlagLocaleKey) => string
  /** The tooltip, where the feature needs its own sentence; the dictionary's general one otherwise. */
  readonly tooltip?: string | undefined
}

/**
 * Render the chip. It takes keyboard focus so the tooltip is readable without a pointer, and a tap pins the tooltip.
 * @param props - see {@link PreviewChipProps}.
 * @returns the chip with its tooltip.
 */
export function PreviewChip({ t, tooltip }: PreviewChipProps): ReactNode {
  return (
    <Tooltip label={tooltip ?? t('previewFlag.tooltip')} side="top" portal openOnClick maxWidth={280}>
      <span className={css.chip} tabIndex={0} data-preview-chip>{t('previewFlag.chip')}</span>
    </Tooltip>
  )
}
