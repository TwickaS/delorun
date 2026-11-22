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
 * - `U`: class `face`: a device needs a grant alone for exactly this call (Face ID, or the PIN on a device with no
 *   passkey); without one it is answered `403 ELEVATION_REQUIRED` (`gateByClass`, or `gateByUnlock`);
 * - `C`: only the computer; a device is refused (`403 LOOPBACK_REQUIRED`) whatever its unlock;
 * - `K`: a device until a PIN or any passkey exists (`admitKeyDevice`): model keys are tested, never shown;
 * - `R+U`: one registration serves both levels, by route (see the reason).
 */
export type RouteLevel = 'R' | 'U' | 'C' | 'K' | 'R+U'

/** One route's level and the reason for it. */
export interface RouteAccess {
  readonly level: RouteLevel
  readonly reason: string
}

/**
 * @param level - a level.
 * @returns the row builder for that level.
 */
const at = <L extends RouteLevel>(level: L) => (reason: string): RouteAccess & { readonly level: L } => ({ level, reason })
const READ = at('R')
/** Level `R` for a write that changes only an everyday setting or the person's own organising, so it needs no unlock. */
const EVERYDAY = at('R')
const UNLOCKED = at('U')
const COMPUTER = at('C')

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
  'browser-use-browse/src/routes.ts': {
    'REAL_BROWSER_ROUTES.state': READ('reads whether a chat may use the person\'s own browser'),
    'REAL_BROWSER_ROUTES.end': READ('ending the grant only narrows what the agent may reach'),
    'REAL_BROWSER_ROUTES.away': UNLOCKED('turning it on lets runs the person did not start use their own browser, with their sign-ins, so it takes Face ID; the home reads the body, and a body that says `on: false` only tightens and takes none'),
  },
  'plugin-delegation-consent/src/routes.ts': {
    'DELEGATION_CONSENT_ROUTES.grants': READ('lists which agents may work in which workspaces'),
    'DELEGATION_CONSENT_ROUTES.levels': READ('reads each external agent\'s saved level and what its sandbox lacks; it changes no level, which only a settings write does, and the reach policy ranks that'),
    'DELEGATION_CONSENT_ROUTES.allow': UNLOCKED('allowing lets an external agent work in a workspace'),
    'DELEGATION_CONSENT_ROUTES.revoke': READ('revoking only withdraws a grant'),
  },
  'plugin-agent-seats/src/mount.ts': {
    'RESUME_PATH': READ('resuming an agent after its plan limit only flips the seat\'s status; the next message the person sends is what spends plan usage'),
    'CHOOSE_MODEL_PATH': READ('picking the model the person\'s own program runs for a seat changes no permission, sandbox or tool the program has'),
  },
  'external-agents/src/accounts/routes.ts': {
    'ACCOUNT_ROUTES.accounts': READ('reads each agent\'s sign-in, plan and limit figures, which hold no personal data; reading starts no check'),
    'ACCOUNT_ROUTES.refresh': UNLOCKED('a check starts the person\'s own Claude Code or Codex program on the computer'),
  },
  'plugin-permission-defaults/src/routes.ts': {
    'PERMISSION_ROUTES.everywhere': READ('reads whether dangerous mode is on'),
    'PERMISSION_ROUTES.everywhereOff': READ('turning dangerous mode off only tightens; turning it on is `delorun setup` or the computer-only `RUN_ROUTES.dangerousConfirm`'),
    'PERMISSION_ROUTES.workspaces': READ('lists the workspaces and their full access'),
    'PERMISSION_ROUTES.review': READ('shows what full access would allow, before anything changes'),
    'PERMISSION_ROUTES.setFullAccess': UNLOCKED('full access lets a chat write outside the workspace sandbox'),
  },
  'plugin-permission-defaults/src/command-network.ts': {
    NETWORK_LIST_PATH: READ('reads a workspace\'s network allowlist'),
    NETWORK_SET_PATH: UNLOCKED('a looser allowlist lets commands reach more of the network'),
  },
  'bundle-local/src/browser-check.ts': {
    BROWSER_TEST_ROUTE: { level: 'C', reason: 'starts a browser on the computer, outside the agent sandbox; no paired device' },
    BROWSER_INSTALL_ROUTE: { level: 'C', reason: 'downloads a browser build to the computer; no paired device' },
  },
  'bundle-local/src/browse-pairing.ts': {
    BROWSE_PAIR_ROUTE: { level: 'C', reason: 'pairing runs browse on the computer and shows a code that links the person\'s own Chrome, with their sign-ins' },
  },
  'bundle-local/src/profile-versions.ts': {
    'PROFILE_VERSION_ROUTES.list': READ('lists the saved setup versions'),
    'PROFILE_VERSION_ROUTES.changes': READ('shows what differs between versions'),
    'PROFILE_VERSION_ROUTES.save': UNLOCKED('saving writes a setup version to the computer'),
    'PROFILE_VERSION_ROUTES.switch': UNLOCKED('switching replaces the plugins and settings the harness runs'),
  },
  'bundle-local/src/run-settings.ts': {
    'RUN_ROUTES.state': READ('reads the answers of How Delorun runs and what runs now: the port numbers and whether phone access is on, with no key or path'),
    'RUN_ROUTES.prompts': UNLOCKED('turning questions off lets a chat do more without asking, so a device confirms `stock` with Face ID or its PIN every time, even in a Face ID pass; the home reads the body, and a body that says `safer` only tightens and takes none'),
    'RUN_ROUTES.dangerousBegin': COMPUTER('the first step of turning dangerous mode on, which only the person at the computer does'),
    'RUN_ROUTES.dangerousConfirm': COMPUTER('turning dangerous mode on lets any chat switch to full access without asking, and is done only at the computer, with a yes and the typed phrase the home checks itself'),
    'RUN_ROUTES.background': UNLOCKED('keeping Delorun running after the terminal closes decides whether the studio stays reachable, so a device confirms it'),
    'RUN_ROUTES.port': COMPUTER('the port decides where the studio listens and changes its sign-in address'),
    'RUN_ROUTES.reachPreview': COMPUTER('it reads Tailscale on the computer and issues the ticket that turning phone access on needs'),
    'RUN_ROUTES.reach': COMPUTER('turning phone access on or off decides who can reach the home, and on changes Tailscale'),
  },
  'bundle-local/src/trust.ts': {
    TRUST_BILL_PATH: READ('reads what the harness trusts'),
    TRUST_CHECK_PATH: READ('a check reads and asks the network under the service\'s own bounds, and writes nothing'),
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
    'CHAT_STATE_PATHS.set': EVERYDAY('snoozing or settling a chat writes its state, which is everyday organising'),
  },
  'plugin-main-chat/src/index.ts': {
    'MAIN_CHAT_PATHS.reports': READ('counts the main chat\'s waiting reports'),
    'MAIN_CHAT_PATHS.open': READ('opens the main chat, which exists to be opened'),
  },
  'plugin-trash/src/index.ts': {
    path: { level: 'R+U', reason: 'listing, deleting to the trash and restoring are reversible and need no unlock; deleting forever (purge, empty) needs one' },
  },
  'plugin-packs/src/routes.ts': {
    path: { level: 'R+U', reason: 'listing, cancelling an install and clearing a failed row change nothing installed and need no unlock; adding, retrying and removing a plugin pack write code the Host will run, so they need one' },
  },
  'plugin-new-workspace/src/index.ts': {
    PLACES_PATH: UNLOCKED('lists the computer\'s recent workspaces and folders by path'),
    SEARCH_PATH: UNLOCKED('walks the computer\'s folders and names them by path'),
    PREVIEW_PATH: UNLOCKED('names the entries and the Git branch of a folder on the computer'),
    ADD_WORKSPACE_PATH: UNLOCKED('a workspace is what the model may write'),
    CREATE_PATH: UNLOCKED('makes a folder on the computer, runs Git in it and adds it as a workspace'),
    CLONE_PATH: UNLOCKED('cloning writes a repository into a folder on the computer'),
    CLONE_STATUS_PATH: READ('reports the state of a clone by its id, a status read that starts nothing'),
    DEFAULTS_PATH: READ('reads a registered workspace\'s model and browser defaults, a read of settings the studio already lists; any other path is answered with none, unchecked'),
    SET_DEFAULTS_PATH: UNLOCKED('sets the model and browser every new chat in a workspace starts with'),
  },
  'preview-flags/src/index.ts': {
    'PREVIEW_FLAG_ROUTES.list': READ('names the declared preview flags and whether each is on, with no setting or data'),
  },
  'plugin-onboarding/src/index.ts': {
    WORKSPACE_NOTICE_PATH: READ('names the files set aside, not their paths'),
    SETUP_RECORD_PATH: READ('reads which setup steps are done'),
    READINESS_PATH: READ('reads what the computer has installed for setup'),
    KEY_TEST_PATH: { level: 'K', reason: 'tests the model keys and names each provider\'s result, never a key; once a PIN or any passkey exists, no device' },
    START_PATH: READ('a random id naming this start of the home, with no setting or data'),
    DEFER_STEP_PATH: READ('notes that a setup step waits for the computer: ids from a closed list, no setting changes'),
    AGENT_MODELS_PATH: READ('lists an agent\'s models by starting the agent\'s own program under a timeout; it is bounded and changes nothing'),
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
  { kind: 'plugin-row', id: '@delorun/bundle-webhooks/server', reason: 'its settings decide the address the GitHub webhook endpoint listens on, which stays on loopback unless the computer moves it' },
  { kind: 'mode', id: 'dangerous mode on', reason: 'it is turned on only at the computer, by `delorun setup prompts` or the studio\'s computer-only confirmation with its typed phrase, the same class as turning remote access on' },
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
  { kind: 'mode', id: 'terminal/* without a grant', reason: 'a terminal is a shell outside the sandbox: a device needs a grant for the call, from a passkey or a PIN, and no unlock opens it' },
  { kind: 'changes-route', id: '/delorun/changes/notice-seen', reason: 'the notice of a change a phone made is for the person at the computer; a phone must not dismiss it' },
  { kind: 'changes-route', id: '/delorun/changes actions, harness, protection off and setup without a grant', reason: 'applying, turning off, setup and changes to Delorun itself change what runs; a device needs a grant for the call, from a passkey or a PIN, and may take back or tighten without one' },
]

/**
 * The Changes controls and their classes, one row per control of `plugin-changes`' `CONTROL_LEVELS` (the id is the
 * control's name; `plugin-changes/tests/face-grants.spec.ts` keeps this table and that one equal), plus `reads` for the
 * `state`, `show` and `workspaces` routes and `setup` for the setup routes. Every `U` row takes Face ID.
 */
export const CHANGES_ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  reads: READ('what failed, the recent changes and the waiting ones, without file contents beyond a shown change'),
  'plugin-undo': UNLOCKED('undoing a plugin\'s change rewrites the person\'s files'),
  'plugin-discard': UNLOCKED('discarding a plugin\'s change deletes a recorded change'),
  'harness-discard': UNLOCKED('discarding a change to Delorun itself deletes a recorded change'),
  'plugin-apply': UNLOCKED('applying a plugin\'s change changes what runs'),
  'plugin-other': UNLOCKED('turning plugins off or on, work sessions, safe mode, create, request and reveal change what runs'),
  'harness-apply': UNLOCKED('applying a change to Delorun itself changes what runs'),
  'harness-undo': UNLOCKED('undoing a change to Delorun itself rewrites what runs'),
  'make-copy': UNLOCKED('Make my copy writes a copy of Delorun'),
  restart: UNLOCKED('a restart ends the chats that are running'),
  'protection-off': UNLOCKED('turning protection off lets plugin changes run unreviewed'),
  'protection-on': READ('turning protection on only tightens'),
  'update-check': READ('reads and records the release check'),
  'update-begin': UNLOCKED('preparing and applying an update replaces the release the home runs'),
  'update-rollback': UNLOCKED('a rollback replaces the release the home runs'),
  'update-cancel': READ('cancelling an update that has not begun only takes back'),
  'update-dismiss': READ('dismissing the record of an update only hides a message'),
  'update-continue': READ('continuing a chat the update stopped sends it one fixed message the person asked for in Settings, to that chat only, once'),
  stop: UNLOCKED('stopping the home ends every chat that is running'),
  setup: UNLOCKED('a setup file leaves the computer and changes what the profile runs'),
  'notice-seen': COMPUTER('the notice of a change a phone made is for the person at the computer'),
}
