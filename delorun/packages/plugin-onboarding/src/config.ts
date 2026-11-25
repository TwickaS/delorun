/**
 * Onboarding's row configuration, kept by the host half and read and written by the studio half: whether the person
 * finished or skipped onboarding, the step they reached, the chat whose empty state still offers starter prompts and
 * what its folder holds, the packages and the bundled rows the recommended-plugins step offers, and the limits of the routes that reach the
 * network or start an agent.
 * @module @delorun/plugin-onboarding/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** The Loader row id, which names the settings namespace the studio edits. */
export const ONBOARDING_ROW_ID = 'delorun-onboarding'

/** The theme's Loader row id, whose settings the look step edits. A test compares it with the theme's own constant. */
export const THEME_ROW_ID = 'delorun-theme'

/** An npm package name, scoped or not. */
export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

/** A Loader row id as a bundle's patch declares it: lower-case letters, digits, dots, underscores and hyphens. */
export const ROW_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * The most packages (and, separately, bundled rows) the recommended-plugins step offers. The step's compact 48 px rows
 * fit twelve on one screen; the studio bundle's curated list is the longest list a profile sets, and a longer list
 * fails validation and stops the studio.
 */
export const RECOMMENDED_LIMIT = 12

/** The id of a step, which `step` keeps: lower-case letters, digits, dots and hyphens. */
export const STEP_ID = /^[a-z0-9.-]{0,64}$/

/** The row's settings as the studio reads them. */
export interface OnboardingSettings {
  /** Whether the person finished or skipped onboarding; it shows again only when asked. */
  done: boolean
  /** The step they reached, by id; empty before the first and after the last. */
  step: string
  /** Packages the recommended-plugins step offers; the step is left out when the list is empty. */
  plugins: string[]
  /** Rows a bundle inserts disabled, by row id, that the recommended-plugins step offers to turn on; the step is left out when this and `plugins` are empty. */
  optionalRows: string[]
  /** The start of Delorun in which the person pressed Complete setup later, which keeps the guide closed until the next start; empty for none. */
  pausedStart: string
  /** How long adding a package may run before its card says it is still working, in seconds. */
  addWaitSeconds: number
  /** What the person chose for Browser: `on` or `off`; empty while they never chose, which counts as on. */
  browser: '' | 'on' | 'off'
  /** While `browser` is `off`: whether the Browser pack was last seen `enabled` or `disabled` (turned off or removed); empty until seen. A pack seen enabled after `disabled` was switched on again in Plugins. */
  browserPack: '' | 'enabled' | 'disabled'
  /** The deferred steps the person dismissed the Finish setup entry for, by step id. The entry stays hidden while the waiting steps are a subset of these, so a step deferred later shows it again. */
  dismissedSteps: string[]
}

/** The settings of a profile that has not started onboarding. */
export const DEFAULT_SETTINGS: OnboardingSettings = { done: false, step: '', plugins: [], optionalRows: [], pausedStart: '', addWaitSeconds: 60, browser: '', browserPack: '', dismissedSteps: [] }

/** The host half's live configuration: one field per setting. */
export interface Config {
  done: Volatile<boolean>
  step: Volatile<string>
  plugins: Volatile<string[]>
  optionalRows: Volatile<string[]>
  pausedStart: Volatile<string>
  addWaitSeconds: Volatile<number>
  browser: Volatile<'' | 'on' | 'off'>
  browserPack: Volatile<'' | 'enabled' | 'disabled'>
  dismissedSteps: Volatile<string[]>
  registry: string
  registryTimeoutMs: number
  keyTestTimeoutMs: number
  agentModelsTimeoutMs: number
  hiddenProviders: string[]
}

/** The configuration schema: each field validated, defaulted, and changeable while the studio runs. */
export const Config = z.object({
  done: z.boolean().default(DEFAULT_SETTINGS.done).volatile(),
  step: z.string().pattern(STEP_ID).default(DEFAULT_SETTINGS.step).volatile(),
  plugins: z.array(z.string().pattern(PACKAGE_NAME).max(214)).max(RECOMMENDED_LIMIT)
    .description('Packages the recommended-plugins step offers, by npm package name. With none, the step is left out.')
    .default([...DEFAULT_SETTINGS.plugins]).volatile(),
  optionalRows: z.array(z.string().pattern(ROW_ID)).max(RECOMMENDED_LIMIT)
    .description('Rows of the profile that a bundle inserts disabled, by row id, which the recommended-plugins step offers to turn on. Each must name a row of the profile, or the plugin does not load.')
    .default([...DEFAULT_SETTINGS.optionalRows]).volatile(),
  pausedStart: z.string().pattern(/^[A-Za-z0-9-]{0,64}$/).default(DEFAULT_SETTINGS.pausedStart).volatile(),
  addWaitSeconds: z.natural().min(5).max(1800)
    .description('How long adding a package in the guide may run before its card says it is still working, in seconds. The add itself is not stopped.')
    .default(DEFAULT_SETTINGS.addWaitSeconds).volatile(),
  browser: z.union(['', 'on', 'off'])
    .description('What the person chose for Browser, in Settings or in the guide: on, or off. Empty while they never chose, which counts as on.')
    .default(DEFAULT_SETTINGS.browser).volatile(),
  browserPack: z.union(['', 'enabled', 'disabled'])
    .description('While Browser is off: whether the Browser plugin pack was last seen enabled or disabled, so Settings can tell a pack switched on again in Plugins from one still waiting for a restart to turn off. Empty until seen.')
    .default(DEFAULT_SETTINGS.browserPack).volatile(),
  dismissedSteps: z.array(z.string().pattern(STEP_ID)).max(3)
    .description('The deferred steps the person dismissed the Finish setup entry for, by step id. The entry stays hidden while the steps still waiting are all in this list, so a step deferred later shows it again.')
    .default([...DEFAULT_SETTINGS.dismissedSteps]).volatile(),
  registry: z.string().pattern(/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/u)
    .description('The npm registry the plugins step reads a package that is not installed from, only when the person asks.')
    .default('https://registry.npmjs.org'),
  registryTimeoutMs: z.natural().min(1000).max(60_000).description('The most time the registry requests may take together, in milliseconds.').default(10_000),
  agentModelsTimeoutMs: z.natural().min(1000).max(120_000).description('The most time an installed agent may take to list its models, in milliseconds.').default(20_000),
  keyTestTimeoutMs: z.natural().min(1000).max(60_000).description('The most time one provider\'s key test may take, in milliseconds.').default(15_000),
  hiddenProviders: z.array(z.string().pattern(ROW_ID)).max(16)
    .description('Model provider routes the key test and the guide leave out, by route id, such as a route nobody can sign in to. Upstream\'s registry still lists them; they stay mounted.')
    .default([]),
})
