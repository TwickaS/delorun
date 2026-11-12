/**
 * Onboarding's row configuration, kept by the host half and read and written by the studio half: whether the person
 * finished or skipped onboarding, the step they reached, the chat whose empty state still offers starter prompts and
 * what its folder holds, the packages the recommended-plugins step offers, and the limits of the routes that reach the
 * network or run Git.
 * @module @delo/plugin-onboarding/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FOLDER_KINDS } from './wire.ts'

/** The Loader row id, which names the settings namespace the studio edits. */
export const ONBOARDING_ROW_ID = 'delo-onboarding'

/** The theme's Loader row id, whose settings the look step edits. A test compares it with the theme's own constant. */
export const THEME_ROW_ID = 'delo-theme'

/** An npm package name, scoped or not. */
export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

/** The most packages the recommended-plugins step offers: more would not fit one screen. */
export const RECOMMENDED_LIMIT = 8

/** The id of a step, which `step` keeps: lower-case letters, digits, dots and hyphens. */
export const STEP_ID = /^[a-z0-9.-]{0,64}$/

/** The `starterSession` value that means the starter prompts wait for the next empty chat that opens. */
export const PENDING_STARTERS = 'pending'

/** A session id as the routes and the settings keep it, `pending` ({@link PENDING_STARTERS}), or empty for none. */
export const SESSION_KEY = /^[A-Za-z0-9._:-]{0,200}$/

/** The row's settings as the studio reads them. */
export interface OnboardingSettings {
  /** Whether the person finished or skipped onboarding; it shows again only when asked. */
  done: boolean
  /** The step they reached, by id; empty before the first and after the last. */
  step: string
  /** The chat whose empty state offers starter prompts; `pending` until the next empty chat opens; empty for none. */
  starterSession: string
  /** Packages the recommended-plugins step offers; the step is left out when the list is empty. */
  plugins: string[]
  /** What the first chat's folder holds, which picks its starting prompts; empty for the general prompts. */
  starterKind: string
}

/** The settings of a profile that has not started onboarding. */
export const DEFAULT_SETTINGS: OnboardingSettings = { done: false, step: '', starterSession: '', plugins: [], starterKind: '' }

/** The host half's live configuration: one field per setting. */
export interface Config {
  done: Volatile<boolean>
  step: Volatile<string>
  starterSession: Volatile<string>
  plugins: Volatile<string[]>
  starterKind: Volatile<string>
  registry: string
  registryTimeoutMs: number
  keyTestTimeoutMs: number
  cloneTimeoutMs: number
}

/** The configuration schema: each field validated, defaulted, and changeable while the studio runs. */
export const Config = z.object({
  done: z.boolean().default(DEFAULT_SETTINGS.done).volatile(),
  step: z.string().pattern(STEP_ID).default(DEFAULT_SETTINGS.step).volatile(),
  starterSession: z.string().pattern(SESSION_KEY).default(DEFAULT_SETTINGS.starterSession).volatile(),
  plugins: z.array(z.string().pattern(PACKAGE_NAME).max(214)).max(RECOMMENDED_LIMIT)
    .description('Packages the recommended-plugins step offers, by npm package name. With none, the step is left out.')
    .default([...DEFAULT_SETTINGS.plugins]).volatile(),
  starterKind: z.union(['', ...FOLDER_KINDS] as const).default('').volatile(),
  registry: z.string().pattern(/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/u)
    .description('The npm registry the plugins step reads a package that is not installed from, only when the person asks.')
    .default('https://registry.npmjs.org'),
  registryTimeoutMs: z.natural().min(1000).max(60_000).description('The most time the registry requests may take together, in milliseconds.').default(10_000),
  keyTestTimeoutMs: z.natural().min(1000).max(60_000).description('The most time one provider\'s key test may take, in milliseconds.').default(15_000),
  cloneTimeoutMs: z.natural().min(10_000).max(3_600_000).description('The most time a clone from Git may take, in milliseconds.').default(600_000),
})
