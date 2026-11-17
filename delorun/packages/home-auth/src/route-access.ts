/**
 * The access level of every plugin Fetch route a Delorun package registers with `ctx.connection.fetch.register`, and the
 * reason for each. A paired device reaches such a route only when its `admitPeer` admits it, so a route without one is
 * computer-only by default; this table states the level of each route so none is left to default, and
 * `tests/route-access.spec.ts` fails on a registered route that is not listed here or whose code does not match its level.
 *
 * The levels follow the owner's phone-parity rule: a paired device does what the computer's studio does, and only what
 * would let a stolen phone widen its own access needs the person at the computer.
 *
 * @module @delorun/home-auth/route-access
 */

import { COMPUTER_ONLY_ROW_MODULES } from './reach-access.ts'

/**
 * How a route answers a paired device:
 * - `R`: any approved device, with no unlock (`admitApprovedDevice`);
 * - `U`: an unlocked device only; a locked one is answered `403 ELEVATION_REQUIRED` (`gateByUnlock`);
 * - `C`: only the computer; a device is refused (`403 LOOPBACK_REQUIRED`) whatever its unlock;
 * - `K`: a device that holds no PIN lock (`admitKeyDevice`): model keys are tested, never shown;
 * - `R+U`: one registration serves both levels, by route (see the reason).
 */
export type RouteLevel = 'R' | 'U' | 'C' | 'K' | 'R+U'

/** One route's level and the reason for it. */
export interface RouteAccess {
  readonly level: RouteLevel
  readonly reason: string
}

const READ = (reason: string): RouteAccess => ({ level: 'R', reason })
const UNLOCKED = (reason: string): RouteAccess => ({ level: 'U', reason })

/**
 * Every registered plugin Fetch route, by source file (relative to `delorun/packages`) and the expression its `path`
 * field holds. Computer-only routes (`C`) are listed with the reason they stay at the computer.
 */
export const PLUGIN_ROUTE_ACCESS: Readonly<Record<string, Readonly<Record<string, RouteAccess>>>> = {
  'plugin-theme/src/index.ts': {
    STUDIO_ICON_UPLOAD_PATH: READ('the icon is an everyday setting; the bytes are checked by their first bytes and size'),
  },
  'plugin-mcp-consent/src/routes.ts': {
    'MCP_CONSENT_ROUTES.pending': READ('lists the servers waiting for consent'),
    'MCP_CONSENT_ROUTES.waiting': READ('names the waiting servers and what changed, nothing else'),
    'MCP_CONSENT_ROUTES.accept': UNLOCKED('accepting lets a server\'s command run on the computer'),
    'MCP_CONSENT_ROUTES.decline': READ('declining only withholds consent'),
    'MCP_CONSENT_ROUTES.revoke': READ('revoking only withdraws consent'),
  },
  'plugin-delegation-consent/src/routes.ts': {
    'DELEGATION_CONSENT_ROUTES.grants': READ('lists which agents may work in which workspaces'),
    'DELEGATION_CONSENT_ROUTES.allow': UNLOCKED('allowing lets an external agent work in a workspace'),
    'DELEGATION_CONSENT_ROUTES.revoke': READ('revoking only withdraws a grant'),
  },
  'plugin-permission-defaults/src/routes.ts': {
    'PERMISSION_ROUTES.everywhere': READ('reads whether dangerous mode is on'),
    'PERMISSION_ROUTES.everywhereOff': READ('turning dangerous mode off only tightens; turning it on is setup and config only, at the computer'),
    'PERMISSION_ROUTES.workspaces': READ('lists the workspaces and their full access'),
    'PERMISSION_ROUTES.review': READ('shows what full access would allow, before anything changes'),
    'PERMISSION_ROUTES.setFullAccess': UNLOCKED('full access lets a chat write outside the workspace sandbox'),
  },
  'plugin-permission-defaults/src/command-network.ts': {
    NETWORK_LIST_PATH: READ('reads a workspace\'s network allowlist'),
    NETWORK_SET_PATH: UNLOCKED('a looser allowlist lets commands reach more of the network'),
  },
  'bundle-local/src/profile-versions.ts': {
    'PROFILE_VERSION_ROUTES.list': READ('lists the saved setup versions'),
    'PROFILE_VERSION_ROUTES.changes': READ('shows what differs between versions'),
    'PROFILE_VERSION_ROUTES.save': UNLOCKED('saving writes a setup version to the computer'),
    'PROFILE_VERSION_ROUTES.switch': UNLOCKED('switching replaces the plugins and settings the harness runs'),
  },
  'bundle-local/src/trust.ts': {
    TRUST_BILL_PATH: READ('reads what the harness trusts'),
    TRUST_CHECK_PATH: UNLOCKED('a check asks the network and spends time on the computer'),
  },
  'bundle-local/src/report.ts': {
    REPORT_ROUTE: UNLOCKED('the report excerpt can hold paths of the home'),
  },
  'bundle-local/src/requirements.ts': {
    'REQUIREMENT_ROUTES.check': READ('a read of which programs and settings a bundle needs are present, as the owner sees it'),
  },
  'bundle-local/src/update-check.ts': {
    UPDATE_CHANNEL_PATH: READ('names the release host alone'),
    UPDATE_NOTICE_PATH: READ('says whether a newer release exists'),
    UPDATE_NOTES_PATH: READ('shows the verified release notes'),
  },
  'plugin-chat-states/src/index.ts': {
    'CHAT_STATE_PATHS.list': READ('reads which chats are snoozed or settled'),
    'CHAT_STATE_PATHS.set': READ('snoozing and settling are everyday organising'),
  },
  'plugin-main-chat/src/index.ts': {
    'MAIN_CHAT_PATHS.reports': READ('counts the main chat\'s waiting reports'),
    'MAIN_CHAT_PATHS.open': READ('opens the main chat, which exists to be opened'),
  },
  'plugin-trash/src/index.ts': {
    path: { level: 'R+U', reason: 'listing, deleting to the trash and restoring are reversible and need no unlock; deleting forever (purge, empty) needs one' },
  },
  'plugin-onboarding/src/index.ts': {
    WORKSPACE_NOTICE_PATH: READ('names the files set aside, not their paths'),
    ADD_WORKSPACE_PATH: UNLOCKED('a workspace is what the model may write'),
    CLONE_PATH: UNLOCKED('cloning writes a repository into a folder on the computer'),
    CLONE_STATUS_PATH: UNLOCKED('reports the clone the unlocked device started'),
    SETUP_RECORD_PATH: READ('reads which setup steps are done'),
    READINESS_PATH: READ('reads what the computer has installed for setup'),
    KEY_TEST_PATH: { level: 'K', reason: 'tests the model keys and names each provider\'s result, never a key; under PIN mode only an unlocked page' },
    DEFER_STEP_PATH: READ('notes that a setup step waits for the computer: ids from a closed list, no setting changes'),
    AGENT_MODELS_PATH: UNLOCKED('starts the agent\'s own process to list its models'),
    LOCAL_MODELS_PATH: READ('probes the two loopback model listings'),
    RECOMMEND_PATH: READ('names the recommended packages and connections'),
  },
}

/** What kind of thing a computer-only row names. */
export type ComputerOnlyKind = 'action' | 'settings-write' | 'plugin-row' | 'auth-route' | 'changes-route' | 'mode'

/** One thing a paired device never does, whatever its unlock, a PIN page, dangerous mode or the approval grace. */
export interface ComputerOnlyRow {
  readonly kind: ComputerOnlyKind
  readonly id: string
  readonly reason: string
}

const AUTH = (id: string, reason: string): ComputerOnlyRow => ({ kind: 'auth-route', id, reason })

/**
 * Everything that stays at the computer, with the reason for each row. A row here is refused to a device with
 * `LOOPBACK_REQUIRED` under every unlock kind, in dangerous mode and during the approval grace; a row not here is a read
 * (`R`) or an action behind an unlock (`U`) for a device. The actions come from `REACH_DENIED_ACTIONS` and the plugin
 * rows from `COMPUTER_ONLY_ROW_MODULES`, which carry the same reasons in code.
 */
export const COMPUTER_ONLY: readonly ComputerOnlyRow[] = [
  ...Object.entries(COMPUTER_ONLY_ROW_MODULES).map(([module, reason]): ComputerOnlyRow => ({ kind: 'settings-write', id: `settings of ${module}`, reason: `a write there replaces the row in effect, and ${reason}` })),
  { kind: 'action', id: 'account/*', reason: 'account sign-in is off in Delorun, and an account change belongs to the home\'s own computer' },
  { kind: 'action', id: 'settings/openSettingsDocument', reason: 'opens the settings document in an editor on the computer\'s own screen' },
  { kind: 'action', id: 'session/openWorkspacePath', reason: 'opens an application on the computer\'s own screen, in every mode' },
  { kind: 'action', id: 'session/workspacePathApplications', reason: 'lists the applications on the computer\'s own screen, in every mode' },
  { kind: 'settings-write', id: 'delorun-home-auth', reason: 'pairing and secrets decide who is admitted, so a device never changes them' },
  { kind: 'settings-write', id: 'delorun-reach', reason: 'turning remote access on or off, or changing what it exposes, decides who can reach the home' },
  { kind: 'settings-write', id: 'delorun-update-check enabled: false', reason: 'a stolen unlocked phone could silence security fixes; turning checks on is allowed anywhere' },
  { kind: 'plugin-row', id: '@delorun/home-auth', reason: 'disabling it removes the unlock gate' },
  { kind: 'plugin-row', id: '@delorun/reach', reason: 'disabling it removes the control over which addresses reach the studio' },
  { kind: 'plugin-row', id: '@deepseek-ai/dsh-sandbox-local', reason: 'disabling it removes the confinement of commands a chat runs' },
  { kind: 'plugin-row', id: '@deepseek-ai/dsh-sandbox-policy', reason: 'disabling it removes what the sandbox allows' },
  { kind: 'mode', id: 'dangerous mode on', reason: 'it is setup and config only, the same class as turning remote access on' },
  AUTH('/auth/owner/claim', 'it establishes who owns the home'),
  AUTH('/auth/devices/window', 'a phone that approves devices would let a stolen phone mint lasting access'),
  AUTH('/auth/devices/pending', 'a phone that approves devices would let a stolen phone mint lasting access'),
  AUTH('/auth/devices/approve', 'a phone that approves devices would let a stolen phone mint lasting access'),
  AUTH('/auth/devices/cancel', 'it belongs to approving devices'),
  AUTH('/auth/elevation/pending', 'a device never approves its own unlock'),
  AUTH('/auth/elevation/approve', 'a device never approves its own unlock'),
  AUTH('/auth/elevation/revoke', 'ending another device\'s unlock is the computer\'s decision'),
  AUTH('/auth/pin/set', 'a phone must not choose or lengthen its own unlock secret'),
  AUTH('/auth/pin/options', 'a phone must not choose the rules of its own unlock secret'),
  AUTH('/auth/pin/off', 'a phone must not turn its own unlock gate off'),
  AUTH('/auth/pin/resume', 'a phone must not lift a brute-force pause on its own unlock'),
  { kind: 'changes-route', id: '/delorun/changes actions and setup', reason: 'apply, discard, undo and setup attest the person at the computer in the change log; the reveal action opens the computer\'s file manager' },
]

/**
 * The web-server routes of Changes: `/delorun/changes/state`, `show` and `workspaces` are read by any admitted session
 * (R); the action and setup routes are `POST`s that attest the person at the computer before the body is read, so a
 * device is answered `403 LOOPBACK_REQUIRED` (C): their attestation is the record's proof of presence, which a device
 * unlock does not stand for.
 */
export const CHANGES_ROUTE_ACCESS: Readonly<Record<'reads' | 'actions' | 'setup', RouteAccess>> = {
  reads: READ('what failed and the recent changes, without file contents beyond a shown change'),
  actions: { level: 'C', reason: 'apply, discard and undo attest the person at the computer in the change log' },
  setup: { level: 'C', reason: 'a setup file leaves the computer and changes what the profile runs' },
}
