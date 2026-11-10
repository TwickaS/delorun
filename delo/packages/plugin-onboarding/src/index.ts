/**
 * Host entry of Delo's onboarding. The flow is browser-only; this half keeps the row's configuration (progress and
 * the recommended packages) as live settings, serves what the terminal setup recorded to the studio over one exact
 * Connection Fetch route ({@link SETUP_RECORD_PATH}), so onboarding can leave out what the terminal covered, and, while
 * upstream's workspace registry is present, adds the folder the person chooses as a workspace over a second route
 * ({@link ADD_WORKSPACE_PATH}) that refuses the folders Delo never adds.
 * @module @delo/plugin-onboarding
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.profileContext merge.
import type {} from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the ctx.settings merge.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: the ctx.workspaceRegistry merge.
import type {} from '@deepseek-ai/dsh-workspace'
import { readSetupRecord } from './answers.ts'
import { ADD_WORKSPACE_PATH, SETUP_RECORD_PATH } from './wire.ts'
import { addWorkspace } from './workspace-route.ts'

export { SETUP_ANSWERS_FILENAME, MAX_ANSWERS_BYTES, readSetupRecord } from './answers.ts'
export { Config, DEFAULT_SETTINGS, ONBOARDING_ROW_ID, PACKAGE_NAME, RECOMMENDED_LIMIT, type OnboardingSettings } from './config.ts'
export {
  ADD_WORKSPACE_PATH, AddWorkspaceAnswer, AddWorkspaceRequest, LOCATION_PROBLEMS, MAX_ADD_BODY_BYTES, MAX_PATH_LENGTH, MAX_SECTIONS, NO_RECORD, SECTION_NAME,
  SETUP_RECORD_PATH, SetupRecord, type LocationProblem,
} from './wire.ts'

/** The plugin's name in logs. */
export const name = 'delo-onboarding'

/** Required services: the Connection for the routes. */
export const inject = ['connection']

/**
 * Keep the row's settings, serve the setup record, and add workspaces while the registry is present.
 * @param ctx - the plugin context with the injected services.
 */
export function apply(ctx: Context): void {
  // Onboarding edits its own settings in the studio, so the settings service builds no form for them.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Without the registry the route is absent and the studio's request fails, which its folder choice reports.
  ctx.inject(['workspaceRegistry'], (child) => {
    child.connection.fetch.register({
      path: ADD_WORKSPACE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => addWorkspace(request, {
        registry: child.workspaceRegistry,
        // The process environment boundary: the Delo home is resolved from it, as every Delo plugin resolves it.
        env: process.env,
        warn: (message) => { ctx.logger.warn(`${name}: ${message}`) },
      }),
    })
  })
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
