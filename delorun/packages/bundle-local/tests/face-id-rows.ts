/**
 * Which `face` row of `AUTH_CLASSES` the sheet has words and a glyph for: the tables and the check `face-id-icons.spec.ts` runs.
 */
import type { AuthRow } from '../../home-auth/src/auth-classes.ts'
import { ANSWER_GRANTS } from '../src/client/face-id-icon-keys.ts'
import { CHANGE_CONTROLS, faceCopyOf } from '../src/client/face-id-locales.ts'
import { NEVER_ASKED } from '../src/client/face-retry.ts'

/** The client's action name for each `face` route row, which the table names by source file and expression. */
const ROUTE_ACTIONS: Readonly<Record<string, string>> = {
  'route:plugin-mcp-consent/src/routes.ts#MCP_CONSENT_ROUTES.accept': 'plugin-mcp-consent/accept',
  'route:browser-use-browse/src/routes.ts#REAL_BROWSER_ROUTES.away': 'browser-use-browse/away',
  'route:plugin-delegation-consent/src/routes.ts#DELEGATION_CONSENT_ROUTES.allow': 'plugin-delegation-consent/allow',
  'route:plugin-permission-defaults/src/routes.ts#PERMISSION_ROUTES.setFullAccess': 'plugin-permission-defaults/set-full-access',
  'route:plugin-permission-defaults/src/command-network.ts#NETWORK_SET_PATH': 'plugin-permission-defaults/network-set',
  'route:bundle-local/src/profile-versions.ts#PROFILE_VERSION_ROUTES.save': 'bundle-local/profile-save',
  'route:bundle-local/src/profile-versions.ts#PROFILE_VERSION_ROUTES.switch': 'bundle-local/profile-switch',
  'route:bundle-local/src/run-settings.ts#RUN_ROUTES.prompts': 'bundle-local/run-prompts',
  'route:bundle-local/src/run-settings.ts#RUN_ROUTES.background': 'bundle-local/run-background',
  'route:bundle-local/src/report.ts#REPORT_ROUTE': 'bundle-local/report-details',
  'route:plugin-trash/src/index.ts#path (write)': 'plugin-trash/purge',
  'route:plugin-packs/src/routes.ts#path (write)': 'plugin-packs/add',
  'route:plugin-new-workspace/src/index.ts#PLACES_PATH': 'plugin-new-workspace/places',
  'route:plugin-new-workspace/src/index.ts#SEARCH_PATH': 'plugin-new-workspace/search',
  'route:plugin-new-workspace/src/index.ts#PREVIEW_PATH': 'plugin-new-workspace/preview',
  'route:plugin-new-workspace/src/index.ts#ADD_WORKSPACE_PATH': 'plugin-new-workspace/add',
  'route:plugin-new-workspace/src/index.ts#CREATE_PATH': 'plugin-new-workspace/create',
  'route:plugin-new-workspace/src/index.ts#CLONE_PATH': 'plugin-new-workspace/clone',
  'route:plugin-new-workspace/src/index.ts#SET_DEFAULTS_PATH': 'plugin-new-workspace/set-defaults',
}

/** `face` rows whose sheet has no words of its own and shows the plain shield, each with the reason. */
const PLAIN_SHIELD: Readonly<Record<string, string>> = {
  'remote:workspaceFiles/* outside the workspace': 'a read or write outside the chat\'s workspace has no one kind of words',
  'route:external-agents/src/accounts/routes.ts#ACCOUNT_ROUTES.refresh': 'the accounts refresh is a Check now button whose sheet is the generic one',
  'changes:setup': 'setup controls use the Changes generic words',
  'auth:/auth/passkey/devices': 'the device list and removals build their own words in PasskeyDevices',
  'auth:/auth/devices/remove': 'the device list and removals build their own words in PasskeyDevices',
  'auth:/auth/passkey/remove': 'the device list and removals build their own words in PasskeyDevices',
}

/** The client action name a remote row's sheet is asked for. */
/** `face` rows of the home's own `/auth` routes whose sheet the studio raises, by the grant action the studio names. */
const AUTH_ACTIONS: Readonly<Record<string, string>> = {
  'auth:/auth/passkey/pass (write)': 'auth/passkey/pass',
}

const REMOTE_ACTIONS: Readonly<Record<string, string>> = {
  'remote:session/create outside the known workspaces': 'session/create',
  'remote:commands/execute of an unlisted command': 'commands/execute',
  'remote:settings write that loosens the default preset': 'settings/update',
}

/**
 * @param row - a `face` row.
 * @returns what is wrong with the row's entry in the client, or undefined when its words and glyph resolve.
 */
export function problemOf(row: AuthRow): string | undefined {
  if (PLAIN_SHIELD[row.id] !== undefined) return undefined
  if (row.surface === 'answer') return (ANSWER_GRANTS as readonly string[]).includes(row.id.slice('answer:'.length)) ? undefined : `${row.id} has no answer glyph`
  if (row.surface === 'changes') return (CHANGE_CONTROLS as readonly string[]).includes(row.id.slice('changes:'.length)) ? undefined : `${row.id} has no Changes words`
  const action = row.surface === 'route' ? ROUTE_ACTIONS[row.id] : row.surface === 'auth' ? AUTH_ACTIONS[row.id]
    : row.id.startsWith('remote:event:') ? 'dynamicCordisRunner/event' : REMOTE_ACTIONS[row.id] ?? row.id.slice('remote:'.length)
  if (action === undefined) return `${row.id} names no client action`
  // The studio never raises a sheet for these calls, so they need no words.
  if (Object.hasOwn(NEVER_ASKED, action)) return undefined
  return faceCopyOf(action) === 'generic' ? `${row.id} (${action}) has only the generic words` : undefined
}
