/**
 * The `settings.general.item` rows the studio half registers beside the
 * Appearance section: the Delorun look switch, the
 * typeface and the density as preview tiles, and how the composer's model
 * picker labels reasoning effort. Each writes one field of the theme row's
 * settings, and the Look row turns the studio additions off.
 * @module @delorun/plugin-theme/client/AppearanceRows
 */
import { useId } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_SETTINGS, DENSITIES, EFFORT_DISPLAYS, TYPEFACES, type ThemeSettings, type Typeface } from '../config.ts'
import { writesFor } from '../settings.ts'
import { FONT_FAMILIES } from '../palette/soft.ts'
import { STOCK_FONT_STACKS } from '../palette/stock.ts'
import css from './AppearanceRows.module.css'
import { useFormWrites, type FormWrites } from './form-writes.ts'
import { ChoiceGroup, SettingRow, StudioLookSwitch, TileGroup } from '@delorun/brand'

/** What the rows read and write. */
export interface AppearanceRowInjected {
  /** The theme settings, stored by the host half. */
  readonly settings: ConfigForm<ThemeSettings>
  /**
   * Turn Delorun's look and every Delorun studio plugin off, which withdraws these rows.
   * @returns whether the setting was saved.
   */
  readonly useStockLook: () => Promise<boolean>
}

/** The props each row reads: the Appearance dictionary and the injected services. */
export type AppearanceRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings.delorunAppearance'> & InjectFace<AppearanceRowInjected>

/** The font stack each typeface tile shows its specimen in. */
const SPECIMEN_FONTS: Readonly<Record<Typeface, string>> = {
  delorun: `'${FONT_FAMILIES.text}', ${STOCK_FONT_STACKS.text}`,
  system: STOCK_FONT_STACKS.text,
}

/**
 * Follow the theme settings for one row.
 * @param settings - the theme row's form.
 * @param t - the row's dictionary.
 * @returns the writes state, the current settings (the defaults until the Host answers) and the failure report while the last write failed.
 */
function useTheme(settings: ConfigForm<ThemeSettings>, t: AppearanceRowProps['t']): FormWrites<ThemeSettings> & { readonly current: ThemeSettings; readonly failure: string | undefined } {
  const writes = useFormWrites(settings)
  return { ...writes, current: writes.snapshot.value ?? DEFAULT_SETTINGS, failure: writes.failed ? t('saveFailed') : undefined }
}

/**
 * Render the Look row: a switch that is on, and turning it off turns the studio additions off.
 * @param props - the dictionary and the services.
 * @returns the row.
 */
export function StudioLookRow({ t, settings, useStockLook }: AppearanceRowProps) {
  const { disabled, failure, track } = useTheme(settings, t)
  return (
    <SettingRow title={t('look')} description={t('look.lead')} failure={failure}>
      <StudioLookSwitch label={t('look')} disabled={disabled}
        onChange={() => { track(useStockLook()) }} />
    </SettingRow>
  )
}

/**
 * Render the Typeface row: a tile per typeface with a specimen in it.
 * @param props - the dictionary and the services.
 * @returns the row.
 */
export function TypefaceRow({ t, settings }: AppearanceRowProps) {
  const id = useId()
  const { current, disabled, failure, save } = useTheme(settings, t)
  return (
    <SettingRow stacked titleId={id} title={t('typeface')} description={t('typeface.lead')} failure={failure}>
      <TileGroup labelledBy={id} className={css.typeTiles} value={current.typeface} disabled={disabled}
        onChange={(value) => { save('typeface', value) }}
        tiles={TYPEFACES.map(value => ({
          value,
          label: t(`typeface.${value}`),
          preview: (
            <span className={css.specimen} style={{ fontFamily: SPECIMEN_FONTS[value] }}>
              <span className={css.specimenGlyphs}>Aa</span>
              <span className={css.specimenLine}>{t('typeface.specimen')}</span>
            </span>
          ),
        }))} />
    </SettingRow>
  )
}

/**
 * Render the Density row: a tile per density with rows drawn at its spacing.
 * @param props - the dictionary and the services.
 * @returns the row.
 */
export function DensityRow({ t, settings }: AppearanceRowProps) {
  const id = useId()
  const { current, disabled, failure, track } = useTheme(settings, t)
  return (
    <SettingRow stacked titleId={id} title={t('density')} description={t('density.lead')} failure={failure}>
      <TileGroup labelledBy={id} className={css.densityTiles} value={current.density} disabled={disabled}
        onChange={(density) => { track(settings.mutate(writesFor({ kind: 'density', density }, current))) }}
        tiles={DENSITIES.map(value => ({
          value,
          label: t(`density.${value}`),
          preview: <span className={css.densityMock} data-density={value}><span /><span /><span /><span /></span>,
        }))} />
    </SettingRow>
  )
}

/**
 * Render the Reasoning effort labels row: the effort as its name or as bars.
 * @param props - the dictionary and the services.
 * @returns the row.
 */
export function EffortLabelsRow({ t, settings }: AppearanceRowProps) {
  const { current, disabled, failure, save } = useTheme(settings, t)
  return (
    <SettingRow title={t('effort')} description={t('effort.lead')} failure={failure}>
      <ChoiceGroup label={t('effort')} value={current.effort} disabled={disabled}
        options={EFFORT_DISPLAYS.map(display => ({ value: display, label: t(`effort.${display}`) }))}
        onChange={(display) => { save('effort', display) }} />
    </SettingRow>
  )
}
