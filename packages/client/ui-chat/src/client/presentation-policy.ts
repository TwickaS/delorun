/** Chat presentation derived from Host-backed detail, collapse timing, folded replies, and the Custom mode's parts. */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  DEFAULT_CUSTOM_DISPLAY, DEFAULT_FOLDED_REPLIES,
  type CollapseTiming, type CustomDisplay, type FoldedReplies, type StepGrouping, type ThinkingDisplay, type TranscriptViewMode,
} from '../chat-settings.ts'
export { COLLAPSE_TIMINGS, FOLDED_REPLIES, type CollapseTiming, type FoldedReplies } from '../chat-settings.ts'

/** Presentation capabilities that one work-details mode enables. */
export interface ChatPresentationPolicy {
  /** Preference identity for layout resets and diagnostics; renderers select the capabilities below. */
  readonly mode: TranscriptViewMode
  /** Saved collapse timing; completion retains the default immediate folding and scrolling. */
  readonly collapseTiming: CollapseTiming
  /** Assistant replies that stay visible while a completed Turn folds: every reply, or only the final answer. */
  readonly foldedReplies: FoldedReplies
  /** Whether a normally completed Turn folds its process rows behind the whole-Turn control. */
  readonly foldCompletedTurns: boolean
  /** Collapsible group headers for all Turns, historical Turns only, or no Turns. */
  readonly stepGrouping: StepGrouping
  /** Show the running command, path, query, or reasoning detail in group titles. */
  readonly liveProcessDetail: boolean
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean
  /** Whether a shell command's terminal card starts open, its output capped to the head and tail until expanded. */
  readonly openTerminalCards: boolean
  /** How a reasoning block shows; `rsvp` shows as `preview` until word-by-word reading exists. */
  readonly thinking: ThinkingDisplay
  /** The height in lines of a `window` reasoning block. */
  readonly thinkingWindowLines: number
}

type PresetMode = Exclude<TranscriptViewMode, 'custom'>
type ModePolicy = Omit<ChatPresentationPolicy, 'collapseTiming' | 'foldedReplies'>

const POLICIES: Readonly<Record<PresetMode, ModePolicy>> = {
  compact: {
    mode: 'compact',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: false,
    settledReasoningPreview: false,
    openTerminalCards: false,
    thinking: 'preview',
    thinkingWindowLines: DEFAULT_CUSTOM_DISPLAY.thinkingWindowLines,
  },
  standard: {
    mode: 'standard',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: true,
    settledReasoningPreview: true,
    openTerminalCards: false,
    thinking: 'preview',
    thinkingWindowLines: DEFAULT_CUSTOM_DISPLAY.thinkingWindowLines,
  },
  detailed: {
    mode: 'detailed',
    foldCompletedTurns: true,
    stepGrouping: 'history',
    liveProcessDetail: true,
    settledReasoningPreview: true,
    openTerminalCards: false,
    thinking: 'preview',
    thinkingWindowLines: DEFAULT_CUSTOM_DISPLAY.thinkingWindowLines,
  },
  verbose: {
    mode: 'verbose',
    foldCompletedTurns: false,
    stepGrouping: 'none',
    liveProcessDetail: false,
    settledReasoningPreview: true,
    openTerminalCards: true,
    thinking: 'preview',
    thinkingWindowLines: DEFAULT_CUSTOM_DISPLAY.thinkingWindowLines,
  },
}

function withTiming(
  collapseTiming: CollapseTiming,
  foldedReplies: FoldedReplies,
): Readonly<Record<PresetMode, ChatPresentationPolicy>> {
  return {
    compact: { ...POLICIES.compact, collapseTiming, foldedReplies },
    standard: { ...POLICIES.standard, collapseTiming, foldedReplies },
    detailed: { ...POLICIES.detailed, collapseTiming, foldedReplies },
    verbose: { ...POLICIES.verbose, collapseTiming, foldedReplies },
  }
}

const TIMING_POLICIES = {
  completion: { all: withTiming('completion', 'all'), final: withTiming('completion', 'final') },
  'next-input': { all: withTiming('next-input', 'all'), final: withTiming('next-input', 'final') },
}

/** The Custom mode's policies, kept per choice so a selector sees one object for one set of choices. */
const CUSTOM_POLICIES = new Map<string, ChatPresentationPolicy>()

function customPolicy(collapseTiming: CollapseTiming, foldedReplies: FoldedReplies, custom: CustomDisplay): ChatPresentationPolicy {
  const key = JSON.stringify([collapseTiming, foldedReplies, custom.thinking, custom.thinkingWindowLines, custom.stepGrouping,
    custom.liveProcessDetail, custom.openTerminalCards, custom.foldCompletedTurns])
  let policy = CUSTOM_POLICIES.get(key)
  if (policy === undefined) {
    policy = {
      mode: 'custom',
      collapseTiming,
      foldedReplies,
      foldCompletedTurns: custom.foldCompletedTurns,
      stepGrouping: custom.stepGrouping,
      liveProcessDetail: custom.liveProcessDetail,
      settledReasoningPreview: custom.thinking !== 'title',
      openTerminalCards: custom.openTerminalCards,
      thinking: custom.thinking,
      thinkingWindowLines: custom.thinkingWindowLines,
    }
    CUSTOM_POLICIES.set(key, policy)
  }
  return policy
}

/**
 * Resolve a stable policy for one detail mode, collapse timing, folded-reply choice, and Custom parts.
 * @param mode - persisted work-details mode.
 * @param collapseTiming - persisted timing; defaults to immediate completion folding.
 * @param foldedReplies - persisted folded-reply choice; defaults to keeping every reply visible.
 * @param custom - the Custom mode's parts, read only in `custom` mode.
 * @returns the same policy object for the same choices.
 */
export function presentationPolicyFor(
  mode: TranscriptViewMode,
  collapseTiming: CollapseTiming = 'completion',
  foldedReplies: FoldedReplies = DEFAULT_FOLDED_REPLIES,
  custom: CustomDisplay = DEFAULT_CUSTOM_DISPLAY,
): ChatPresentationPolicy {
  if (mode === 'custom') return customPolicy(collapseTiming, foldedReplies, custom)
  return TIMING_POLICIES[collapseTiming][foldedReplies][mode]
}

/** A Custom source that never changes from the default parts. */
const DEFAULT_CUSTOM_SOURCE: ObservableSnapshot<CustomDisplay> = {
  getSnapshot: () => DEFAULT_CUSTOM_DISPLAY,
  subscribe: () => () => {},
}

/**
 * Combine Host-backed detail, persisted timing, folded replies, and the Custom parts without owning subscriptions.
 * @param mode - live work-details mode.
 * @param collapseTiming - live Host-backed collapse timing.
 * @param foldedReplies - live Host-backed folded-reply choice.
 * @param custom - live Host-backed Custom parts; without it, Custom uses {@link DEFAULT_CUSTOM_DISPLAY}.
 * @returns observable policy whose subscriptions follow all four preferences.
 */
export function derivePresentationPolicy(
  mode: ObservableSnapshot<TranscriptViewMode>,
  collapseTiming: ObservableSnapshot<CollapseTiming>,
  foldedReplies: ObservableSnapshot<FoldedReplies>,
  custom: ObservableSnapshot<CustomDisplay> = DEFAULT_CUSTOM_SOURCE,
): ObservableSnapshot<ChatPresentationPolicy> {
  return {
    getSnapshot: () => presentationPolicyFor(
      mode.getSnapshot(), collapseTiming.getSnapshot(), foldedReplies.getSnapshot(), custom.getSnapshot(),
    ),
    subscribe: (listener) => {
      const offs = [
        mode.subscribe(listener), collapseTiming.subscribe(listener), foldedReplies.subscribe(listener), custom.subscribe(listener),
      ]
      return () => { for (const off of offs) off() }
    },
  }
}
