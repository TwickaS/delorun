/**
 * Snooze and idle chats, in Settings: T3 Code's two settings for them under one
 * heading. The snooze menu's presets, up to eight, show as chips worded as the
 * menu words them; picking one opens a small editor below for its kind and its
 * length or its day and time, and Add opens a new one there. Under them, Settle
 * idle chats turns auto-settle on with its number of days.
 */
import {
  Button, IconClockOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, Input, Switch, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { cardCss, ChoiceGroup, SettingHeading, SettingsCard } from '@delorun/settings-controls'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import {
  AUTO_SETTLE_DAYS, DEFAULT_CHAT_STATES_SETTINGS, PRESET_DAYS, SNOOZE_PRESET_LIMITS, type ChatStatesSettings,
} from '../config.ts'
import { DEFAULT_SNOOZE_PRESETS, snoozePresetId, type SnoozePresetSetting } from '../snooze.ts'
import { snoozeLabelText } from './snooze-text.ts'
import css from './SnoozeSettings.module.css'

/** What the section reads and writes. */
export interface SnoozeSettingsInjected {
  /** The chat-states settings, stored by the host half. */
  readonly settings: ConfigForm<ChatStatesSettings>
  /** The studio's language, for the chips' wording and times. */
  readonly locale: () => string
  /** Show the notice that a change could not be saved, where the notice outlives this section. */
  readonly reportFailure: () => void
}

/** The section's props. */
export type SnoozeSettingsProps = PropsLocale<'delorunChatStates'> & InjectFace<SnoozeSettingsInjected>

type Translate = SnoozeSettingsProps['t']

/** The auto-settle days a switch turns on with: T3 Code's default. */
const AUTO_SETTLE_ON = 3

/** Units a duration preset is entered in, with their minutes. */
const UNITS = { minutes: 1, hours: 60, days: 1440 } as const

type Unit = keyof typeof UNITS

/** A new preset, and what each kind starts from when the editor switches to it. */
const NEW_AFTER: SnoozePresetSetting = { kind: 'after', minutes: 120 }
const NEW_AT: SnoozePresetSetting = { kind: 'at', day: 'tomorrow', time: '09:00' }

/** The largest unit that divides a duration evenly, so a preset reads as it was entered. */
function unitOf(minutes: number): Unit {
  if (minutes % UNITS.days === 0) return 'days'
  return minutes % UNITS.hours === 0 ? 'hours' : 'minutes'
}

/** A `HH:MM` time in the studio's language, such as 6:00 PM. */
function clock(time: string, locale: string): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number)
  return new Date(2026, 0, 1, hours, minutes).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

/** A preset's chip text, as the snooze menu words it: In 2 hours, or a day and its time. */
function chipText(preset: SnoozePresetSetting, t: Translate, locale: string): { readonly name: string; readonly time?: string } {
  if (preset.kind === 'after') return { name: snoozeLabelText({ kind: 'in', minutes: preset.minutes }, t, locale) }
  return { name: t(`settings.day.${preset.day}`), time: clock(preset.time, locale) }
}

/**
 * The editor for one preset: a length of time, or a day and a time, and its removal.
 * @param props - the preset, the dictionary, whether it is disabled or removable, and its change and removal.
 * @returns the editor.
 */
function PresetEditor({ preset, disabled, removable, t, onChange, onRemove }: {
  readonly preset: SnoozePresetSetting
  readonly disabled: boolean
  readonly removable: boolean
  readonly t: Translate
  readonly onChange: (preset: SnoozePresetSetting) => void
  readonly onRemove: () => void
}) {
  const unit = preset.kind === 'after' ? unitOf(preset.minutes) : 'hours'
  const amount = preset.kind === 'after' ? String(preset.minutes / UNITS[unit]) : ''
  // Typing passes through an empty or out-of-range field; only a valid length is saved.
  const [draft, setDraft] = useState(amount)
  useEffect(() => { setDraft(amount) }, [amount])
  const setAmount = (text: string): void => {
    setDraft(text)
    const minutes = Math.round(Number(text) * UNITS[unit])
    if (text !== '' && minutes >= SNOOZE_PRESET_LIMITS.minutes.min && minutes <= SNOOZE_PRESET_LIMITS.minutes.max) onChange({ kind: 'after', minutes })
  }
  const removeLabel = t('settings.preset.remove')
  return (
    <div className={css.editor}>
      <div className={css.editorRow}>
        <ChoiceGroup label={t('settings.preset.kind')} value={preset.kind} disabled={disabled}
          options={[{ value: 'after', label: t('settings.preset.after') }, { value: 'at', label: t('settings.preset.at') }]}
          onChange={(kind) => { onChange(kind === 'after' ? NEW_AFTER : NEW_AT) }} />
        <Tooltip label={removeLabel} side="bottom" align="end" delayMs={500}>
          <button type="button" className={css.iconButton} aria-label={removeLabel} disabled={disabled || !removable} onClick={onRemove}>
            <IconTrashOutlineRegular size={16} />
          </button>
        </Tooltip>
      </div>
      <div className={css.fields}>
        {preset.kind === 'after'
          ? (
            <>
              <span className={css.amount}>
                <Input type="number" inputMode="numeric" aria-label={t('settings.preset.amount')} disabled={disabled}
                  min={1} max={Math.floor(SNOOZE_PRESET_LIMITS.minutes.max / UNITS[unit])} value={draft}
                  onChange={(event) => { setAmount(event.currentTarget.value) }} />
              </span>
              <ChoiceGroup label={t('settings.preset.unit')} value={unit} disabled={disabled}
                options={(Object.keys(UNITS) as Unit[]).map(each => ({ value: each, label: t(`custom.unit.${each}`) }))}
                onChange={(next) => {
                  const minutes = Math.round(Number(draft === '' ? '1' : draft) * UNITS[next])
                  onChange({ kind: 'after', minutes: Math.min(SNOOZE_PRESET_LIMITS.minutes.max, Math.max(SNOOZE_PRESET_LIMITS.minutes.min, minutes)) })
                }} />
            </>
          )
          : (
            <>
              <div className={css.days} role="group" aria-label={t('settings.preset.day')}>
                {PRESET_DAYS.map(day => (
                  <button key={day} type="button" aria-pressed={preset.day === day} className={css.day} disabled={disabled}
                    onClick={() => { if (preset.day !== day) onChange({ ...preset, day }) }}>
                    {t(`settings.day.${day}`)}
                  </button>
                ))}
              </div>
              <span className={css.time}>
                <Input type="time" aria-label={t('settings.preset.time')} disabled={disabled} value={preset.time}
                  onChange={(event) => { if (/^\d\d:\d\d$/.test(event.currentTarget.value)) onChange({ ...preset, time: event.currentTarget.value }) }} />
              </span>
            </>
          )}
      </div>
    </div>
  )
}

/**
 * Render the section.
 * @param props - the dictionary, the settings and the studio's language.
 * @returns the section.
 */
export function SnoozeSettingsSection({ settings, locale, reportFailure, t }: SnoozeSettingsProps) {
  const titleId = useId()
  const snapshot = useSyncExternalStore(listener => settings.subscribe(listener), () => settings.getSnapshot())
  const current = snapshot.value ?? DEFAULT_CHAT_STATES_SETTINGS
  const disabled = !snapshot.writable
  const [editing, setEditing] = useState<number | null>(null)
  const save = <K extends keyof ChatStatesSettings>(field: K, value: ChatStatesSettings[K]): void => {
    settings.set(field, value).then((ok) => { if (!ok) reportFailure() }, reportFailure)
  }
  const presets = current.snoozePresets
  const savePresets = (next: SnoozePresetSetting[]): void => { save('snoozePresets', next) }
  const language = locale()
  const edited = editing === null ? undefined : presets[editing]
  const isDefault = presets.map(snoozePresetId).join() === DEFAULT_SNOOZE_PRESETS.map(snoozePresetId).join()
  const days = current.autoSettleDays
  return (
    <SettingsCard id={titleId} title={t('settings.nav')} className={css.section}>
        <section className={cardCss.block} aria-labelledby={`${titleId}-presets`}>
          <div className={cardCss.row}>
            <SettingHeading id={`${titleId}-presets`} title={t('settings.presets')} lead={t('settings.presets.lead')} />
            <div className={css.meta}>
              <span className={css.count}>{t('settings.presets.count', { n: String(presets.length), max: String(SNOOZE_PRESET_LIMITS.count) })}</span>
              {!isDefault && (
                <Button variant="ghost" disabled={disabled} onClick={() => { setEditing(null); savePresets([...DEFAULT_SNOOZE_PRESETS]) }}>
                  {t('settings.preset.reset')}
                </Button>
              )}
            </div>
          </div>
          <ul className={css.chips} aria-label={t('settings.presets')}>
            {presets.map((preset, index) => {
              const text = chipText(preset, t, language)
              return (
                // A preset has no id of its own and two may be equal while being edited, so the place is the key.
                <li key={index}>
                  <button type="button" className={css.chip} aria-pressed={editing === index} disabled={disabled}
                    onClick={() => { setEditing(editing === index ? null : index) }}>
                    <IconClockOutlineRegular size={14} />
                    <span>{text.name}</span>
                    {text.time !== undefined && <span className={css.chipTime}>{text.time}</span>}
                  </button>
                </li>
              )
            })}
            <li>
              <button type="button" className={css.chip} data-add="" disabled={disabled || presets.length >= SNOOZE_PRESET_LIMITS.count}
                onClick={() => { savePresets([...presets, NEW_AFTER]); setEditing(presets.length) }}>
                <IconPlusOutlineRegular size={14} />
                <span>{t('settings.preset.add')}</span>
              </button>
            </li>
          </ul>
          {edited !== undefined && (
            <PresetEditor key={editing} preset={edited} disabled={disabled} removable={presets.length > 1} t={t}
              onChange={(next) => { savePresets(presets.map((each, at) => (at === editing ? next : each))) }}
              onRemove={() => { savePresets(presets.filter((_, at) => at !== editing)); setEditing(null) }} />
          )}
        </section>

        <section className={cardCss.block} aria-labelledby={`${titleId}-settle`}>
          <div className={cardCss.row}>
            <SettingHeading id={`${titleId}-settle`} title={t('settings.autoSettle')} lead={t('settings.autoSettle.lead')} />
            <div className={css.control}>
              {days > 0 && (
                <div className={css.settleDays}>
                  <span className={css.amount}>
                    <Input type="number" inputMode="numeric" aria-label={t('settings.autoSettle.days')} disabled={disabled}
                      min={1} max={AUTO_SETTLE_DAYS.max} value={days}
                      onChange={(event) => {
                        const next = Math.round(Number(event.currentTarget.value))
                        if (next >= 1 && next <= AUTO_SETTLE_DAYS.max) save('autoSettleDays', next)
                      }} />
                  </span>
                  <span>{t('settings.autoSettle.unit')}</span>
                </div>
              )}
              <Switch checked={days > 0} disabled={disabled} label={t('settings.autoSettle')}
                onChange={(on) => { save('autoSettleDays', on ? AUTO_SETTLE_ON : 0) }} />
            </div>
          </div>
        </section>
    </SettingsCard>
  )
}
