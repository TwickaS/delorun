/** Chat display preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the Chat target. */
export const CHAT_SETTINGS_NAMESPACE = 'ui-chat'

/** Field carrying the work-details presentation mode. */
export const TRANSCRIPT_VIEW_FIELD = 'transcriptView'

/** Field carrying the independent work-details collapse timing. */
export const COLLAPSE_TIMING_FIELD = 'collapseTiming'

/** Available points when a completed Turn returns to its historical presentation. */
export const COLLAPSE_TIMINGS = ['completion', 'next-input'] as const

/** When a completed Turn returns to its historical presentation. */
export type CollapseTiming = typeof COLLAPSE_TIMINGS[number]

/** Preserve completion-time folding when no timing preference is saved. */
export const DEFAULT_COLLAPSE_TIMING: CollapseTiming = 'completion'

/** Field carrying which Assistant replies stay visible in a folded Turn. */
export const FOLDED_REPLIES_FIELD = 'foldedReplies'

/** Assistant replies kept visible while a completed Turn folds its process: every reply, or only the final answer. */
export const FOLDED_REPLIES = ['all', 'final'] as const

/** Which Assistant replies stay visible while a completed Turn folds its process. */
export type FoldedReplies = typeof FOLDED_REPLIES[number]

/** Keep every Assistant reply visible when no folded-reply preference is saved. */
export const DEFAULT_FOLDED_REPLIES: FoldedReplies = 'all'

/** Work-details presentation modes a user can choose; `custom` takes each part from {@link CUSTOM_DISPLAY_FIELD}. */
export const TRANSCRIPT_VIEW_MODES = ['compact', 'standard', 'detailed', 'verbose', 'custom'] as const

/** Work-details presentation mode. */
export type TranscriptViewMode = typeof TRANSCRIPT_VIEW_MODES[number]

/**
 * Saved value from the two-mode generation of this setting. Read as `detailed`;
 * never offered as a choice and never written back.
 */
export const LEGACY_TRANSCRIPT_VIEW_MODE = 'normal'

/** Saved `expanded` values read as `detailed`, without being offered or written back. */
export const LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE = 'expanded'

/** Every value the durable field accepts: current modes plus legacy saved values. */
const TRANSCRIPT_VIEW_SETTING_VALUES = [
  ...TRANSCRIPT_VIEW_MODES, LEGACY_TRANSCRIPT_VIEW_MODE, LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE,
] as const

/** Field carrying the parts of the Custom work-details mode. */
export const CUSTOM_DISPLAY_FIELD = 'customDisplay'

/**
 * How a reasoning block shows: folded to its title, its title with a
 * one-line preview, open while the model thinks and folded after, always
 * open, or open in a window of a few lines that follows the stream.
 * `rsvp` is reserved for word-by-word reading and shows as `preview`.
 */
export const THINKING_DISPLAYS = ['title', 'preview', 'live', 'expanded', 'window', 'rsvp'] as const

/** How a reasoning block shows. */
export type ThinkingDisplay = typeof THINKING_DISPLAYS[number]

/** Collapsible step groups for every Turn, past Turns only, or none. */
export const STEP_GROUPINGS = ['collapsed', 'history', 'none'] as const

/** Collapsible step groups for every Turn, past Turns only, or none. */
export type StepGrouping = typeof STEP_GROUPINGS[number]

/** The parts of the Custom work-details mode. */
export interface CustomDisplay {
  /** How reasoning shows. */
  thinking: ThinkingDisplay
  /** The window's height in lines, for `window` reasoning. */
  thinkingWindowLines: number
  /** Collapsible step groups. */
  stepGrouping: StepGrouping
  /** Show the running command, path, query or reasoning detail in group titles. */
  liveProcessDetail: boolean
  /** Whether a shell command's terminal card starts open. */
  openTerminalCards: boolean
  /** Whether a completed Turn folds its process rows. */
  foldCompletedTurns: boolean
}

/** The Custom mode's parts before the person changes any: the Detailed mode's. */
export const DEFAULT_CUSTOM_DISPLAY: CustomDisplay = {
  thinking: 'preview',
  thinkingWindowLines: 6,
  stepGrouping: 'history',
  liveProcessDetail: true,
  openTerminalCards: false,
  foldCompletedTurns: true,
}

/** Default work details for non-Desktop Web clients. */
export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = 'detailed'

/** Performance and usage detail levels accepted by user settings. */
export const PERFORMANCE_USAGE_MODES = ['compact', 'detailed'] as const

/** Performance and usage presentation. */
export type PerformanceUsageMode = typeof PERFORMANCE_USAGE_MODES[number]

/** Preserve detailed accounting for users without an explicit preference. */
export const DEFAULT_PERFORMANCE_USAGE: PerformanceUsageMode = 'detailed'

/** Destinations for ordinary clicks on Chat HTTP(S) links. */
export type LinkOpening = 'sidebar' | 'new-tab'

/** Preserve the built-in browser for users without an explicit preference. */
export const DEFAULT_LINK_OPENING: LinkOpening = 'sidebar'

/** Durable Chat section shared by the Host schema and browser scope. */
export interface ChatSettings {
  /** Work-details preference; absence uses the client default, and legacy saved values remain accepted. */
  transcriptView?: TranscriptViewMode | typeof LEGACY_TRANSCRIPT_VIEW_MODE | typeof LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE | null
  /** Independent collapse timing; absence preserves completion-time folding. */
  collapseTiming?: CollapseTiming
  /** Replies kept visible in a folded Turn; absence keeps every reply. */
  foldedReplies?: FoldedReplies
  /** The Custom mode's parts; absence uses {@link DEFAULT_CUSTOM_DISPLAY}. */
  customDisplay?: CustomDisplay
  /** Detail level for composer statistics and completed-Turn usage. */
  performanceUsage: PerformanceUsageMode
  /** Default destination for Chat HTTP(S) links. */
  linkOpening: LinkOpening
}

/** Durable Chat schema; also the wire envelope the browser scope validates against. */
export const ChatSettingsFields = {
  [COLLAPSE_TIMING_FIELD]: z.union([...COLLAPSE_TIMINGS]).default(DEFAULT_COLLAPSE_TIMING),
  [FOLDED_REPLIES_FIELD]: z.union([...FOLDED_REPLIES]).default(DEFAULT_FOLDED_REPLIES),
  linkOpening: z.union(['sidebar', 'new-tab']).default(DEFAULT_LINK_OPENING),
  performanceUsage: z.union([...PERFORMANCE_USAGE_MODES]).default(DEFAULT_PERFORMANCE_USAGE),
  [CUSTOM_DISPLAY_FIELD]: z.object({
    thinking: z.union([...THINKING_DISPLAYS]).default(DEFAULT_CUSTOM_DISPLAY.thinking),
    thinkingWindowLines: z.natural().min(2).max(20).default(DEFAULT_CUSTOM_DISPLAY.thinkingWindowLines),
    stepGrouping: z.union([...STEP_GROUPINGS]).default(DEFAULT_CUSTOM_DISPLAY.stepGrouping),
    liveProcessDetail: z.boolean().default(DEFAULT_CUSTOM_DISPLAY.liveProcessDetail),
    openTerminalCards: z.boolean().default(DEFAULT_CUSTOM_DISPLAY.openTerminalCards),
    foldCompletedTurns: z.boolean().default(DEFAULT_CUSTOM_DISPLAY.foldCompletedTurns),
  }),
  // Missing and unrecognized modes defer to the client's default.
  [TRANSCRIPT_VIEW_FIELD]: z.union([...TRANSCRIPT_VIEW_SETTING_VALUES]).loose(),
}

/** Schema for shared configuration values. */
export const ChatSettingsSchema = z.object(ChatSettingsFields)
