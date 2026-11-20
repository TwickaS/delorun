/**
 * The sheet's glyph map covers every strong action: each `face` row of `AUTH_CLASSES` resolves to words and a glyph the
 * client names, so a new row fails here until the sheet has an entry for it.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { describe, expect, it } from 'vitest'
import { AUTH_CLASSES, type AuthRow } from '../../home-auth/src/auth-classes.ts'
import { ANSWER_GRANTS, COPY_ICON, faceIconOf } from '../src/client/face-id-icon-keys.ts'
import { ACTION_COPY, CHANGE_CONTROLS, faceCopyOf } from '../src/client/face-id-locales.ts'

/** The client's action name for each `face` route row, which the table names by source file and expression. */
const ROUTE_ACTIONS: Readonly<Record<string, string>> = {
  'route:plugin-mcp-consent/src/routes.ts#MCP_CONSENT_ROUTES.accept': 'plugin-mcp-consent/accept',
  'route:browser-use-browse/src/routes.ts#REAL_BROWSER_ROUTES.away': 'browser-use-browse/away',
  'route:plugin-delegation-consent/src/routes.ts#DELEGATION_CONSENT_ROUTES.allow': 'plugin-delegation-consent/allow',
  'route:plugin-permission-defaults/src/routes.ts#PERMISSION_ROUTES.setFullAccess': 'plugin-permission-defaults/set-full-access',
  'route:plugin-permission-defaults/src/command-network.ts#NETWORK_SET_PATH': 'plugin-permission-defaults/network-set',
  'route:bundle-local/src/profile-versions.ts#PROFILE_VERSION_ROUTES.save': 'bundle-local/profile-save',
  'route:bundle-local/src/profile-versions.ts#PROFILE_VERSION_ROUTES.switch': 'bundle-local/profile-switch',
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
const REMOTE_ACTIONS: Readonly<Record<string, string>> = {
  'remote:session/create outside the known workspaces': 'session/create',
  'remote:commands/execute of an unlisted command': 'commands/execute',
  'remote:settings write that loosens the default preset': 'settings/update',
}

/**
 * @param row - a `face` row.
 * @returns what is wrong with the row's entry in the client, or undefined when its words and glyph resolve.
 */
function problemOf(row: AuthRow): string | undefined {
  if (PLAIN_SHIELD[row.id] !== undefined) return undefined
  if (row.surface === 'answer') return (ANSWER_GRANTS as readonly string[]).includes(row.id.slice('answer:'.length)) ? undefined : `${row.id} has no answer glyph`
  if (row.surface === 'changes') return (CHANGE_CONTROLS as readonly string[]).includes(row.id.slice('changes:'.length)) ? undefined : `${row.id} has no Changes words`
  const action = row.surface === 'route' ? ROUTE_ACTIONS[row.id]
    : row.id.startsWith('remote:event:') ? 'dynamicCordisRunner/event' : REMOTE_ACTIONS[row.id] ?? row.id.slice('remote:'.length)
  if (action === undefined) return `${row.id} names no client action`
  return faceCopyOf(action) === 'generic' ? `${row.id} (${action}) has only the generic words` : undefined
}

const faceRows = AUTH_CLASSES.filter(row => row.authClass === 'face')

describe('the sheet\'s glyph map', () => {
  // A new face row with no copy entry resolves to the generic words and fails here.
  it('has words and a glyph for every face row of AUTH_CLASSES', () => {
    expect(faceRows.length).toBeGreaterThan(50)
    expect(faceRows.flatMap(row => problemOf(row) ?? [])).toEqual([])
  })

  // Proves the check rejects: a row the client does not name is reported, and so is one it only words generically.
  it('rejects a new row that no entry covers', () => {
    const row = (id: string, surface: AuthRow['surface']): AuthRow => ({ id, surface, authClass: 'face', reason: 'r' })
    expect(problemOf(row('remote:newThing/do', 'remote'))).toContain('generic words')
    expect(problemOf(row('route:x/src/routes.ts#NEW', 'route'))).toContain('names no client action')
    expect(problemOf(row('changes:new-control', 'changes'))).toContain('no Changes words')
    expect(problemOf(row('answer:new-grant', 'answer'))).toContain('no answer glyph')
  })

  // A copy id with no glyph would leave a sheet with an empty header.
  it('names a glyph for every copy id of ACTION_COPY', () => {
    expect(Object.keys(COPY_ICON).sort()).toEqual([...new Set(Object.values(ACTION_COPY)), 'generic'].sort())
  })

  // The shield is the plain fallback for a Changes control with no entry.
  it('falls back to the shield for an action with no entry of its own', () => {
    expect(faceIconOf('changes/unknown-control')).toBe('shield')
    expect(faceIconOf('somewhere/else')).toBe('shield')
    expect(faceIconOf('terminal/create')).toBe('terminal')
    expect(faceIconOf('changes/update-begin')).toBe('download')
  })
})
