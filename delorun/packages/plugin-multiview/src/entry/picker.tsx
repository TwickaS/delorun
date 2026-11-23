/**
 * A stand-in for the layout picker that `src/layout` exports once the tiling layouts land, with the same name and props apart from
 * `t`, which reads this plugin's own dictionary here: today's four presets and Reset to default. The pull request that merges
 * second imports `LayoutPicker` from `../layout/index.ts` instead and deletes this module.
 * @module @delorun/plugin-multiview/entry/picker
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MULTIVIEW_NS, MultiviewService } from '../client/contract.ts'
import { LAYOUT_PRESETS, type LayoutPreset } from '../layout/index.ts'
import css from './Entry.module.css'

/** Props of the layout picker. */
export interface LayoutPickerProps {
  /** The chat whose panes the choices arrange. */
  readonly chat: SessionId
  /** The service the choices apply through. */
  readonly multiview: MultiviewService
  /** One line in the agents list, or a grid in the icon's popover. */
  readonly variant?: 'row' | 'grid'
  /** Called after a choice applies. */
  readonly onChosen?: () => void
  /** The dictionary. */
  readonly t: PropsLocale<typeof MULTIVIEW_NS>['t']
}

/** A small drawing of each preset's arrangement. */
const PRESET_GLYPHS: Record<LayoutPreset, string> = {
  'main-column': 'M9.5 3.5v9M9.5 8h4',
  'side-by-side': 'M6.5 3.5v9M10 3.5v9',
  'grid': 'M8 3.5v9M2.5 8h11',
  'main-top': 'M2.5 9h11M6.5 9v3.5M10 9v3.5',
}

/**
 * One button per preset, each a drawing with the name as its label and tooltip, and Reset to default. Presets rearrange the panes
 * and never close one.
 * @param props - the chat, the service, the variant, the after-choice call and the dictionary.
 * @returns the picker.
 */
export function LayoutPicker({ chat, multiview, variant = 'row', onChosen, t }: LayoutPickerProps) {
  return (
    <div className={css.picker} data-variant={variant} role="group" aria-label={t('layout')}>
      {variant === 'row' && <span className={css.pickerLabel} aria-hidden>{t('layout')}</span>}
      {LAYOUT_PRESETS.map(preset => (
        <Tooltip key={preset} label={t(`layout.${preset}`)} side="top" delayMs={300} portal>
          <button
            type="button"
            className={css.preset}
            aria-label={t(`layout.${preset}`)}
            onClick={() => { multiview.applyPreset(chat, preset); onChosen?.() }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
              <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
              <path d={PRESET_GLYPHS[preset]} />
            </svg>
          </button>
        </Tooltip>
      ))}
      <button type="button" className={css.reset} onClick={() => { multiview.resetLayout(chat); onChosen?.() }}>{t('layout.reset')}</button>
    </div>
  )
}
