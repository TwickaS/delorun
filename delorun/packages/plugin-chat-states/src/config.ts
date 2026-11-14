/**
 * The chat-states settings, shared by the host half that declares them and
 * the studio half that reads and edits them: the snooze menu's presets, how
 * many idle days settle a chat by themselves, how often the studio reads
 * the states again, and how the harness bounds the stored states.
 * @module @delorun/plugin-chat-states/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSetting, type Weekday } from './snooze.ts'

/** The Loader row id of `@delorun/bundle-studio`'s row for this plugin, which names the settings namespace the studio edits. */
export const CHAT_STATES_ROW_ID = 'delorun-chat-states'

/** The days a preset can name. */
export const PRESET_DAYS = ['today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const satisfies
  readonly ('today' | 'tomorrow' | Weekday)[]

/** The snooze menu's limits, T3 Code's: up to eight presets, a duration of one minute to thirty days. */
export const SNOOZE_PRESET_LIMITS = { count: 8, minutes: { min: 1, max: 43_200 } } as const

/** The idle days after which a chat settles by itself, T3 Code's range; 0 turns it off. */
export const AUTO_SETTLE_DAYS = { min: 0, max: 90 } as const

/** The seconds between the studio's reads of the states: often enough that another browser's change shows, rarely enough to cost the harness little. */
export const REFRESH_SECONDS = { min: 5, max: 3600 } as const

/** How many chats' states the harness keeps; the oldest are forgotten beyond it. */
export const MAX_RECORDS = { min: 100, max: 100_000, default: 2000 } as const

/** The minutes between the harness's sweeps that forget the states of chats that no longer exist. */
export const PRUNE_MINUTES = { min: 1, max: 1440, default: 60 } as const

/** The settings as the studio reads them. */
export interface ChatStatesSettings {
  /** The snooze menu's presets, in the person's order; the menu lists them soonest first. */
  snoozePresets: SnoozePresetSetting[]
  /** Idle days after which a chat sits on the Settled shelf by itself, until it changes or is returned; 0 is off. */
  autoSettleDays: number
  /** Seconds between the studio's reads of the states, so another browser's changes show. */
  refreshSeconds: number
}

/** The settings a studio applies before its stored ones arrive: T3 Code's presets, no auto-settle, a read every 30 seconds. */
export const DEFAULT_CHAT_STATES_SETTINGS: ChatStatesSettings = { snoozePresets: [...DEFAULT_SNOOZE_PRESETS], autoSettleDays: 0, refreshSeconds: 30 }

/** The host half's live configuration: one field per setting. */
export interface Config {
  snoozePresets: Volatile<SnoozePresetSetting[]>
  autoSettleDays: Volatile<number>
  refreshSeconds: Volatile<number>
  maxRecords: Volatile<number>
  pruneMinutes: Volatile<number>
}

const Preset: z<SnoozePresetSetting> = z.union([
  z.object({ kind: z.const('after').required(), minutes: z.natural().min(SNOOZE_PRESET_LIMITS.minutes.min).max(SNOOZE_PRESET_LIMITS.minutes.max).required() }),
  z.object({ kind: z.const('at').required(), day: z.union([...PRESET_DAYS]).required(), time: z.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required() }),
])

/** The configuration schema: each field validated, defaulted, and changeable while the studio runs. */
export const Config = z.object({
  snoozePresets: z.array(Preset).min(1).max(SNOOZE_PRESET_LIMITS.count).description('The snooze menu\'s presets: a duration from now, or a time of day on a named day.').default([...DEFAULT_SNOOZE_PRESETS]).volatile(),
  autoSettleDays: z.natural().min(AUTO_SETTLE_DAYS.min).max(AUTO_SETTLE_DAYS.max).description('Idle days after which a chat counts as settled until it changes or is returned to the list; 0 turns it off.').default(DEFAULT_CHAT_STATES_SETTINGS.autoSettleDays).volatile(),
  refreshSeconds: z.natural().min(REFRESH_SECONDS.min).max(REFRESH_SECONDS.max).description('Seconds between the studio\'s reads of the chat states, so another browser\'s changes show.').default(DEFAULT_CHAT_STATES_SETTINGS.refreshSeconds).volatile(),
  maxRecords: z.natural().min(MAX_RECORDS.min).max(MAX_RECORDS.max).description('How many chats\' states the harness keeps; beyond it the states with the oldest changes are forgotten.').default(MAX_RECORDS.default).volatile(),
  pruneMinutes: z.natural().min(PRUNE_MINUTES.min).max(PRUNE_MINUTES.max).description('Minutes between the sweeps that forget the states of chats that no longer exist and enforce the limit.').default(PRUNE_MINUTES.default).volatile(),
})
