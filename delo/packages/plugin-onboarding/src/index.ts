/**
 * Host entry of Delo's onboarding. The flow is browser-only; this half keeps the row's configuration (progress and
 * the recommended packages) as live settings and serves what the terminal setup recorded to the studio over one exact
 * Connection Fetch route ({@link SETUP_RECORD_PATH}), so onboarding can leave out what the terminal covered.
 * @module @delo/plugin-onboarding
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.profileContext merge.
import type {} from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the ctx.settings merge.
import type {} from '@deepseek-ai/dsh-settings'
import { readSetupRecord } from './answers.ts'
import { SETUP_RECORD_PATH } from './wire.ts'

export { SETUP_ANSWERS_FILENAME, MAX_ANSWERS_BYTES, readSetupRecord } from './answers.ts'
export { Config, DEFAULT_SETTINGS, ONBOARDING_ROW_ID, PACKAGE_NAME, RECOMMENDED_LIMIT, type OnboardingSettings } from './config.ts'
export { MAX_SECTIONS, NO_RECORD, SECTION_NAME, SETUP_RECORD_PATH, SetupRecord } from './wire.ts'

/** The plugin's name in logs. */
export const name = 'delo-onboarding'

/** Required services: the Connection for the route. */
export const inject = ['connection']

/**
 * Keep the row's settings and serve the setup record.
 * @param ctx - the plugin context with the injected services.
 */
export function apply(ctx: Context): void {
  // Onboarding edits its own settings in the studio, so the settings service builds no form for them.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.connection.fetch.register({
    path: SETUP_RECORD_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const record = await readSetupRecord(ctx.get('profileContext')?.dir, (message) => { ctx.logger.warn(`${name}: ${message}`) })
      return new Response(JSON.stringify(record), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    },
  })
}
