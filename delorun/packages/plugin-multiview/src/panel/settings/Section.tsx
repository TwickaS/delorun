/**
 * The Multiview section of Settings: the layout, the person's own arrangement, the panes and the behaviour.
 * @module @delorun/plugin-multiview/panel/settings/Section
 */
import { useId, useState, useSyncExternalStore, type CSSProperties, type JSX } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cardCss, ChoiceGroup, SettingRow, SettingsCard, TileGroup } from '@delorun/settings-controls'
import type { MultiviewService } from '../../client/contract.ts'
import {
  AUTO_COLUMNS_RANGE, DEFAULT_MULTIVIEW_SETTINGS, KEPT_CHATS_RANGE, MAX_PANES_RANGE, MIN_PANE_SIZE_RANGE, MOSAIC_MOTIONS, PANE_GAP_RANGE, REMEMBER_SCOPES, SAVE_TRIGGERS,
  type MultiviewSettings,
} from '../../config.ts'
import { LayoutThumb } from '../../layout/LayoutThumb.tsx'
import type { LayoutsLocaleKey } from '../../layout/locales.ts'
import { LAYOUT_CHOICE_IDS, MAIN_SHARE_RANGE, MAIN_SIDES, STACK_STYLES } from '../../layout/presets.ts'
import css from './Section.module.css'

/** The section's id and place in the Settings sidebar: after Browser (17), before Privacy (20). */
export const MULTIVIEW_SECTION = { id: 'delorun-multiview', order: 18 } as const

/** What the section reads and writes. */
export interface SettingsSectionInjected {
  /** The Multiview service, for "Yours" and Reset to Auto. */
  readonly multiview: MultiviewService
  /** The Host settings row. */
  readonly form: ConfigForm<Partial<MultiviewSettings>>
  /** The layout copy. */
  readonly t: Translate<LayoutsLocaleKey>
  /** The chat in the main view, if any, whose workspace the workspace defaults belong to. */
  readonly mainChat: () => SessionId | undefined
}

/** The props of {@link MultiviewSettingsSection}. */
export type MultiviewSettingsSectionProps = InjectFace<SettingsSectionInjected>

/** The panes a layout thumbnail draws. */
const THUMB_PANES = 4

/** The thumbnail width in the layout grid, in CSS pixels. */
const THUMB_SIZE = 40

/**
 * A whole number inside a range, with its unit after it. Typing is kept as a draft; the value is saved, kept inside the range,
 * when the field loses focus or Enter is pressed, and a draft that is not a number goes back to the saved value.
 * @param props - the name, the saved value, the range, the unit and the save.
 * @returns the field.
 */
function NumberField({ label, value, min, max, unit, disabled, onCommit }: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly unit?: string | undefined
  readonly disabled: boolean
  readonly onCommit: (next: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const parsed = draft === null ? value : Number(draft)
  const invalid = draft !== null && (draft.trim() === '' || !Number.isInteger(parsed) || parsed < min || parsed > max)
  const commit = (): void => {
    if (draft !== null && draft.trim() !== '' && Number.isFinite(parsed)) {
      const next = Math.min(max, Math.max(min, Math.round(parsed)))
      if (next !== value) onCommit(next)
    }
    setDraft(null)
  }
  return (
    <span className={css.number}>
      <input type="number" inputMode="numeric" className={css.field} aria-label={label} aria-invalid={invalid || undefined} min={min} max={max} step={1}
        disabled={disabled} value={draft ?? String(value)}
        onChange={(event) => { setDraft(event.currentTarget.value) }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit(); else if (event.key === 'Escape') setDraft(null) }} />
      {unit !== undefined && <span className={css.unit} aria-hidden="true">{unit}</span>}
    </span>
  )
}

/** A slider with the number beside it: the slider writes when it is let go, the number when it is left or Enter is pressed. */
function SliderField({ label, value, min, max, unit, disabled, onCommit }: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly unit: string
  readonly disabled: boolean
  readonly onCommit: (next: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  const commit = (): void => {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  const fill: CSSProperties & Record<`--${string}`, string> = { '--range-fill': `${String(((shown - min) / (max - min)) * 100)}%` }
  return (
    <span className={css.slider}>
      <input type="range" className={css.range} aria-label={label} aria-valuetext={`${String(shown)} ${unit}`} min={min} max={max} step={1}
        value={shown} disabled={disabled} style={fill}
        onChange={(event) => { setDraft(Number(event.currentTarget.value)) }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <NumberField label={label} value={shown} min={min} max={max} unit={unit} disabled={disabled} onCommit={onCommit} />
    </span>
  )
}

/**
 * The section.
 * @param props - the Multiview service, the settings row, the copy and the main chat.
 * @returns the section's page.
 */
export function MultiviewSettingsSection({ multiview, form, t, mainChat }: MultiviewSettingsSectionProps): JSX.Element {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const settings: MultiviewSettings = { ...DEFAULT_MULTIVIEW_SETTINGS, ...snapshot.value }
  const disabled = !snapshot.writable
  const layoutTitleId = useId()
  // The field whose write was refused or rejected is named under its row; the next write clears it.
  const [failed, setFailed] = useState<keyof MultiviewSettings | undefined>(undefined)
  const save = <K extends keyof MultiviewSettings>(field: K, value: MultiviewSettings[K]): void => {
    setFailed(undefined)
    void form.set(field, value).then((ok) => { if (!ok) setFailed(field) }, (_rejected: unknown) => { setFailed(field) })
  }
  const failure = (field: keyof MultiviewSettings): string | undefined => (failed === field ? t('section.failed') : undefined)
  const tiles = LAYOUT_CHOICE_IDS.filter(id => id !== 'yours' || settings.yours != null).map(id => ({
    value: id,
    label: t(`choice.${id}`),
    preview: (
      <span className={css.thumb} title={t(`choice.${id}.hint`)}>
        <LayoutThumb choice={id} n={THUMB_PANES} size={THUMB_SIZE} mainSide={settings.mainSide} stackStyle={settings.stackStyle} shape={settings.yours ?? undefined} />
      </span>
    ),
  }))
  const toggle = (field: 'compactComposer' | 'autoOpen' | 'reopenOnReturn'): JSX.Element => (
    <Switch className={css.switch} checked={settings[field]} label={t(`section.${field}`)} disabled={disabled} onChange={(next) => { save(field, next) }} />
  )
  const numeric = (field: 'mainShare' | 'autoColumns' | 'maxPanes' | 'minPaneWidth' | 'minPaneHeight' | 'keepChats', range: { readonly min: number; readonly max: number }, unit?: string): JSX.Element => (
    <NumberField label={t(`section.${field}`)} value={settings[field]} min={range.min} max={range.max} unit={unit} disabled={disabled} onCommit={(next) => { save(field, next) }} />
  )
  return (
    <div className={cardCss.stack}>
      <SettingsCard id="delorun-multiview-layout" title={t('section.group.layout')}>
        <SettingRow stacked titleId={layoutTitleId} title={t('section.defaultLayout')} description={t('section.defaultLayout.lead')} failure={failure('defaultLayout')}>
          <TileGroup labelledBy={layoutTitleId} className={css.layoutTiles} value={settings.defaultLayout} tiles={tiles} disabled={disabled}
            onChange={(id) => { save('defaultLayout', id) }} />
        </SettingRow>
        <SettingRow title={t('section.mainSide')} description={t('section.mainSide.lead')} failure={failure('mainSide')}>
          <ChoiceGroup label={t('section.mainSide')} value={settings.mainSide} disabled={disabled}
            options={MAIN_SIDES.map(side => ({ value: side, label: t(`side.${side}`) }))} onChange={(side) => { save('mainSide', side) }} />
        </SettingRow>
        <SettingRow stackOnPhone title={t('section.stackStyle')} description={t('section.stackStyle.lead')} failure={failure('stackStyle')}>
          <ChoiceGroup label={t('section.stackStyle')} value={settings.stackStyle} disabled={disabled}
            options={STACK_STYLES.map(style => ({ value: style, label: t(`stack.${style}`) }))} onChange={(style) => { save('stackStyle', style) }} />
        </SettingRow>
        <SettingRow title={t('section.mainShare')} description={t('section.mainShare.lead')} failure={failure('mainShare')}>
          {numeric('mainShare', MAIN_SHARE_RANGE, t('section.unit.percent'))}
        </SettingRow>
        <SettingRow title={t('section.autoColumns')} description={t('section.autoColumns.lead', { count: settings.autoColumns })} failure={failure('autoColumns')}>
          {numeric('autoColumns', AUTO_COLUMNS_RANGE)}
        </SettingRow>
        <SettingRow title={t('section.mosaicMotion')} description={t('section.mosaicMotion.lead')} failure={failure('mosaicMotion')}>
          <ChoiceGroup label={t('section.mosaicMotion')} value={settings.mosaicMotion} disabled={disabled}
            options={MOSAIC_MOTIONS.map(motion => ({ value: motion, label: t(`section.motion.${motion}`) }))} onChange={(motion) => { save('mosaicMotion', motion) }} />
        </SettingRow>
      </SettingsCard>

      <SettingsCard id="delorun-multiview-yours" title={t('section.group.yours')}>
        <SettingRow stackOnPhone title={t('section.rememberScope')} description={t('section.rememberScope.lead')} failure={failure('rememberScope')}>
          <ChoiceGroup label={t('section.rememberScope')} value={settings.rememberScope} disabled={disabled}
            options={REMEMBER_SCOPES.map(scope => ({ value: scope, label: t(`section.scope.${scope}`) }))} onChange={(scope) => { save('rememberScope', scope) }} />
        </SettingRow>
        <SettingRow stackOnPhone title={t('section.saveOn')} description={t('section.saveOn.lead')} failure={failure('saveOn')}>
          <ChoiceGroup label={t('section.saveOn')} value={settings.saveOn} disabled={disabled}
            options={SAVE_TRIGGERS.map(trigger => ({ value: trigger, label: t(`section.save.${trigger}`) }))} onChange={(trigger) => { save('saveOn', trigger) }} />
        </SettingRow>
        <SettingRow stackOnPhone title={t('section.yours')} description={t('section.yours.lead')}>
          <div className={css.actions}>
            <p className={css.status} role="status" data-saved={settings.yours != null || undefined}>
              {settings.yours != null ? t('section.yours.saved') : t('section.yours.none')}
            </p>
            <Button variant="outline" disabled={disabled} onClick={() => { multiview.resetToAuto(mainChat()) }}>{t('section.yours.reset')}</Button>
          </div>
        </SettingRow>
      </SettingsCard>

      <SettingsCard id="delorun-multiview-panes" title={t('section.group.panes')}>
        <SettingRow title={t('section.maxPanes')} description={t('section.maxPanes.lead')} failure={failure('maxPanes')}>
          {numeric('maxPanes', MAX_PANES_RANGE)}
        </SettingRow>
        <SettingRow title={t('section.minPaneWidth')} description={t('section.minPaneWidth.lead')} failure={failure('minPaneWidth')}>
          {numeric('minPaneWidth', MIN_PANE_SIZE_RANGE.width, t('section.unit.px'))}
        </SettingRow>
        <SettingRow title={t('section.minPaneHeight')} description={t('section.minPaneHeight.lead')} failure={failure('minPaneHeight')}>
          {numeric('minPaneHeight', MIN_PANE_SIZE_RANGE.height, t('section.unit.px'))}
        </SettingRow>
        <SettingRow title={t('section.paneGap')} description={t('section.paneGap.lead')} failure={failure('paneGap')}>
          <SliderField label={t('section.paneGap')} value={settings.paneGap} min={PANE_GAP_RANGE.min} max={PANE_GAP_RANGE.max} unit={t('section.unit.px')}
            disabled={disabled} onCommit={(next) => { save('paneGap', next) }} />
        </SettingRow>
        <SettingRow title={t('section.compactComposer')} description={t('section.compactComposer.lead')} failure={failure('compactComposer')}>
          {toggle('compactComposer')}
        </SettingRow>
      </SettingsCard>

      <SettingsCard id="delorun-multiview-behaviour" title={t('section.group.behaviour')}>
        <SettingRow title={t('section.autoOpen')} description={t('section.autoOpen.lead')} failure={failure('autoOpen')}>
          {toggle('autoOpen')}
        </SettingRow>
        <SettingRow title={t('section.reopenOnReturn')} description={t('section.reopenOnReturn.lead')} failure={failure('reopenOnReturn')}>
          {toggle('reopenOnReturn')}
        </SettingRow>
        <SettingRow title={t('section.keepChats')} description={t('section.keepChats.lead')} failure={failure('keepChats')}>
          {numeric('keepChats', KEPT_CHATS_RANGE)}
        </SettingRow>
      </SettingsCard>
    </div>
  )
}
