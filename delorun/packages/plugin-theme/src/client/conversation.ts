/**
 * The chat display choices the Conversation section offers, over upstream's
 * `ui-chat` settings: the four presets, Custom and its parts, and the parts
 * each preset stands for, which seed Custom when the person changes one part.
 * @module @delorun/plugin-theme/client/conversation
 */
import type { CustomDisplay, StepGrouping, ThinkingDisplay } from '@deepseek-ai/dsh-client-ui-chat'

/** Upstream's settings namespace for the chat display. */
export const CHAT_NAMESPACE = 'ui-chat'

/** The presets, then Custom. */
export const DISPLAY_MODES = ['compact', 'standard', 'detailed', 'verbose', 'custom'] as const

/** One display mode. */
export type DisplayMode = typeof DISPLAY_MODES[number]

/** A preset, as opposed to Custom. */
export type Preset = Exclude<DisplayMode, 'custom'>

/** A thinking display the section offers: every one of upstream's but `rsvp`, which needs a thinking view this studio does not ship. */
export type ThinkingChoice = Exclude<ThinkingDisplay, 'rsvp'>

/** The thinking displays offered, in order. */
export const THINKING_CHOICES: readonly ThinkingChoice[] = ['title', 'preview', 'live', 'expanded', 'window']

/** The window heights offered for `window` thinking. */
export const WINDOW_LINES = [3, 6, 10] as const

/** The step groupings offered. */
export const GROUPINGS: readonly StepGrouping[] = ['collapsed', 'history', 'none']

/** The part of upstream's chat settings the section reads and writes. */
export interface ChatDisplaySettings {
  transcriptView?: string | null
  collapseTiming?: 'completion' | 'next-input'
  foldedReplies?: 'all' | 'final'
  customDisplay?: CustomDisplay
}

/** The parts each preset shows, as upstream's presets set them; the spec checks these against upstream's own presets. */
export const PRESET_PARTS: Readonly<Record<Preset, CustomDisplay>> = {
  compact: { thinking: 'preview', thinkingWindowLines: 6, stepGrouping: 'collapsed', liveProcessDetail: false, openTerminalCards: false, foldCompletedTurns: true },
  standard: { thinking: 'preview', thinkingWindowLines: 6, stepGrouping: 'collapsed', liveProcessDetail: true, openTerminalCards: false, foldCompletedTurns: true },
  detailed: { thinking: 'preview', thinkingWindowLines: 6, stepGrouping: 'history', liveProcessDetail: true, openTerminalCards: false, foldCompletedTurns: true },
  verbose: { thinking: 'preview', thinkingWindowLines: 6, stepGrouping: 'none', liveProcessDetail: false, openTerminalCards: true, foldCompletedTurns: false },
}

/** The display a studio shows before a choice is stored: upstream's Web default. */
export const DEFAULT_MODE: Preset = 'detailed'

/**
 * The display mode a stored value names; a missing or legacy value is upstream's default.
 * @param value - the stored `transcriptView`.
 * @returns the mode.
 */
export function displayMode(value: string | null | undefined): DisplayMode {
  return (DISPLAY_MODES as readonly string[]).includes(value ?? '') ? value as DisplayMode : DEFAULT_MODE
}

/**
 * The parts a mode shows: a preset's own, or Custom's stored ones.
 * @param mode - the display mode.
 * @param custom - Custom's stored parts.
 * @returns the parts.
 */
export function partsOf(mode: DisplayMode, custom: CustomDisplay | undefined): CustomDisplay {
  return mode === 'custom' ? custom ?? PRESET_PARTS[DEFAULT_MODE] : PRESET_PARTS[mode]
}
