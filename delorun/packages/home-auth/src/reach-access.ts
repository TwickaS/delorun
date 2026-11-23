/**
 * What a device the home approved may do over a reach listener (C14): its caller identity, the actions the owner's
 * rule permits a phone, the actions it takes only while it holds an unlock, the actions it never takes, and the remote
 * access policy that applies them.
 *
 * Every Peer a reach listener admits speaks for a `reach-device` principal, never for the owner, so upstream's Gateway
 * asks this policy before it dispatches a call or forwards an event to it. The policy refuses by default: it binds only
 * the actions of {@link REACH_ALLOWED_ACTIONS} and {@link REACH_ELEVATED_ACTIONS}, on the global resource, on every
 * Workspace and on every Session the Host can name synchronously. An elevated action without an unlock is refused with
 * the reason `elevation-required: <action>`. Any other action, an action of {@link REACH_DENIED_ACTIONS} or one no table
 * names, is refused with `loopback-required: <action>`: the person takes it at the home's own computer. An allowed or
 * elevated action on a Session or Workspace the policy cannot name is refused with `resource-unlisted: <action>`.
 *
 * The three tables name every Remote method and every forwarded event of Delorun's default profile; the reach access
 * denial suite fails on a method or event no table names, and on an entry that names none.
 *
 * @module @delorun/home-auth/reach-access
 */
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  RemoteAccessAction,
  RemoteAccessBinding,
  RemoteAccessDecision,
  RemoteAccessPolicy,
  RemoteAccessResource,
  RemoteAccessResourceKind,
  RemoteAccessRole,
} from '@deepseek-ai/dsh-api-remote-access/types'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { checkStoredBranding } from '@delorun/brand/branding'
import { DEFAULT_WORKSPACE_ICON, parseWorkspaceIcon } from '@delorun/brand/workspace-icon'
import type { ReachListenerId } from '@delorun/contract-admission'
import type { SettingsLift } from './dangerous-settings.ts'
import { HOLD_OPENERS, holdFeatureOf, hashArgs, scopeOf, type GrantHolder, type GrantStore, type HoldFeature } from './grants.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** One device the home approved, calling over one reach listener. */
    'reach-device': ReachDevicePrincipal
  }
}

/** The principal kind of every Peer a reach listener admits. */
export const REACH_DEVICE = 'reach-device'

/**
 * One device the home approved on one reach listener, as the Peers of its reach sessions speak for it. Session logs
 * record it as the source of the device's prompts, so it carries the device id and the listener id alone: no
 * credential, label or address. An unlock admits only the principal of the listener it was approved on.
 */
export interface ReachDevicePrincipal {
  readonly kind: typeof REACH_DEVICE
  /** The device's id in the home's device list. */
  readonly deviceId: string
  /** The reach listener the device's Peer sits on. */
  readonly listener: ReachListenerId
  /**
   * The id of the PIN mode page unlock that this Peer, one page's, was admitted under (C14, "PIN mode"). The Peer of
   * a locked page, and every Peer without PIN mode, has none.
   */
  readonly unlockId?: string
}

/**
 * The principal of one device on one reach listener.
 * @param deviceId - the device's id in the home's device list.
 * @param listener - the reach listener its Peer sits on.
 * @param unlockId - the page unlock the Peer was admitted under, none for a locked page.
 * @returns the principal its Peers on that listener speak for.
 */
export function reachDevicePrincipal(deviceId: string, listener: ReachListenerId, unlockId?: string): ReachDevicePrincipal {
  return unlockId === undefined ? { kind: REACH_DEVICE, deviceId, listener } : { kind: REACH_DEVICE, deviceId, listener, unlockId }
}

/**
 * Every action a device takes over a reach listener without an unlock, with what it lets the person do from it. The
 * owner's rule for a phone: an approved device is the person, and it can already prompt the agent, so every
 * action no riskier than a prompt is allowed. That covers reading chats, workspaces, the redacted settings, the plugins
 * and the files of a chat's own workspace; starting a chat in a known workspace with any preset; replying, stopping a
 * run and answering ordinary prompts; organizing chats and workspaces, the trash included; goals, scheduled follow-ups,
 * the model, and feedback. A read is listed here only when it reaches no secret and no path outside a chat's workspace, but for a terminal's
 * metadata (its size limits and the shells it can start), which a first terminal reads before `terminal/create` asks
 * for Face ID (F29).
 */
export const REACH_ALLOWED_ACTIONS = {
  'remoteAccess/follow': 'read its own access snapshot, which remote access allows every Peer before any policy',
  'session/list': 'read the chat list',
  'session/search': 'search the chats',
  'session/control': 'follow the chat list and each chat\'s live state',
  'session/follow': 'read a chat as it runs',
  'session/page': 'read a chat\'s history',
  'session/events': 'read a chat\'s history',
  'session/observeEvent': 'follow one event of a chat',
  'session/observeProjections': 'follow a chat\'s projections',
  'session/observeState': 'follow a chat\'s state',
  'session/projections': 'read a chat\'s projections',
  'session/state': 'read a chat\'s state',
  'session/wait': 'wait on a chat\'s state',
  'session/attachment': 'read an image a chat holds',
  // F29: a terminal's metadata, with no output, so a first terminal takes one Face ID, at `terminal/create`. An id-less
  // `terminal/watch` could stream other terminals' events, so it stays face and no hold admits it.
  'terminal/environment': 'read the size limits a chat\'s terminal can take and the chat\'s working directory, which the chat\'s own state already shows, with no terminal output',
  'terminal/shells': 'read the shells a chat\'s terminal can start, their paths and names, with no terminal output',
  // F31: a reloaded terminal tab lists before it reopens, so listing is free and the reopen takes the one Face ID.
  'terminal/list': 'list a chat\'s terminals: each one\'s id, title, shell, starting working directory, size, state, exit code, a fixed line in place of any launch error text (the controller withholds that free text from every caller but the computer), who started it, who holds its input and its sandbox mode, never its output or input',
  'session/modelCatalog': 'read the models a chat can run',
  'session/canOpenWorkspacePath': 'read whether the home can open a folder; opening one belongs to the computer',
  'session/create': 'start a chat in a workspace you registered at the computer, with any of your presets; a chat in another folder needs an unlock, and full access still needs the workspace\'s consent at the computer',
  'session/fork': 'start a chat from a point of another',
  'session/prompt': 'send a message',
  'session/updateQueue': 'edit or withdraw a message still waiting in a chat\'s queue',
  'session/cancel': 'stop a run',
  'session/rename': 'rename a chat, which changes no run',
  'session/selectModel': 'choose a chat\'s model and save it as the default',
  'session/initializeDefaultModel': 'save the default model',
  'fileUploads/upload': 'attach a file to a message',
  'commands/list': 'read the slash commands the composer offers; running one needs an unlock',
  'skills/list': 'read the skills a chat can use',
  'goals/get': 'read a chat\'s goal',
  'goals/clear': 'clear a chat\'s goal',
  'goals/complete': 'mark a chat\'s goal done',
  'goals/create': 'set a chat\'s goal, which steers the chat as a message does',
  'goals/edit': 'edit a chat\'s goal',
  'goals/pause': 'pause a chat\'s goal',
  'goals/resume': 'resume a chat\'s goal',
  'toolResults/watch': 'read the tool results a chat shows',
  'sessionReferenceResolver/candidates': 'read the chats the composer can mention',
  'userQuestions/answer': 'answer a question the agent asked',
  'userQuestions/attachWait': 'hold a question open while answering it',
  'subagents/prompt': 'send a message to a chat\'s subagent',
  'subagents/interruptByUser': 'stop a subagent\'s run',
  'agentTeams/setEnabled': 'switch Team mode on or off for a chat, which changes what the chat\'s agent can delegate and no permission of any run',
  'agentPresets/list': 'read the agent presets a chat can start with',
  'agentPresets/read': 'read one agent preset',
  'agentPresets/select': 'choose which of the presets you defined at your computer a chat that has not started runs with, which decides its plugins and tools; choosing one grants no access by itself, so the workspace\'s full-access consent and every approval prompt still decide what that chat may do',
  'permissionPresets/catalog': 'read the permission presets',
  'workspaceFiles/list': 'list one folder inside a chat\'s workspace, which the service confines to that workspace and caps at 2000 entries',
  'workspaceFiles/read': 'read one page of a text file inside a chat\'s workspace; an absolute path or one that leaves the workspace is refused',
  'workspaceFiles/readBytes': 'read a file\'s bytes inside a chat\'s workspace within the service\'s window and size caps; an absolute path or one that leaves the workspace is refused',
  'workspaceFiles/stat': 'read a file\'s identity, version and size inside a chat\'s workspace; an absolute path or one that leaves the workspace is refused',
  'workspaceFiles/changes': 'read the Changes view, the working tree of a chat\'s workspace, by the same workspace-file rule',
  'officeKit/render': 'render a document inside a chat\'s workspace as a PDF preview, which reads it through the same workspace-file rule',
  'officeKit/generation': 'read which rendering configuration the PDF previews are cached against',
  'workspaceFiles/search': 'search the file names and paths of a chat\'s workspace, which the service confines to that workspace and reports relative to it',
  'fileReferences/list': 'search the file names of a chat\'s workspace for the composer\'s mention list',
  'pluginManager/history': 'read the profile changes that can be undone; undoing or restoring one needs an unlock',
  'pluginManager/inspect': 'read what a plugin package contains before it is installed; installing it needs an unlock',
  'pluginManager/listBundles': 'read the installed bundles',
  'pluginManager/listPlugins': 'read the installed plugins',
  'pluginManager/listVersionExemptions': 'read the pinned plugin versions',
  'pluginManager/listVersions': 'read a plugin package\'s published versions',
  'pluginManager/readBundleDetail': 'read an installed bundle\'s files',
  'pluginManager/registries': 'read which plugin registries are configured',
  'pluginManager/waitForInstall': 'wait on an install that was started',
  'pluginInventory/list': 'read the plugins and presets the Host composed',
  'pluginRegistryProbe/fastest': 'measure which configured plugin registry answers fastest',
  'web/listProviders': 'read the web search and fetch providers; they hold no credentials the device sees',
  'event:web/providers-changed': 'follow a change to the web search and fetch providers',
  'llm/listProviders': 'read the model providers; their credentials are never sent',
  'llm/listConfigurableProviders': 'read the model providers; their credentials are never sent',
  'llm/discoverModels': 'refresh a provider\'s model list, which the Host asks the provider with the stored credentials without sending them to the device',
  'job/list': 'read a chat\'s background jobs',
  'job/follow': 'follow a chat\'s background job',
  'job/kill': 'stop a background job, as stopping a run',
  'schedule/catalog': 'read the scheduled follow-ups',
  'schedule/list': 'read the scheduled follow-ups',
  'schedule/view': 'read one scheduled follow-up',
  'schedule/history': 'read a scheduled follow-up\'s runs',
  'schedule/deliveryLimits': 'read the delivery limits of scheduled follow-ups',
  'schedule/create': 'schedule a follow-up, which runs its prompt later with the chat\'s own permissions, as a message would',
  'schedule/edit': 'edit a scheduled follow-up',
  'schedule/run': 'run a scheduled follow-up now',
  'schedule/deleteInactive': 'delete the scheduled follow-ups that no longer run',
  'workspace/follow': 'read the workspaces and their chats',
  'workspace/pinSession': 'pin a chat to the top of the list, which changes no run',
  'workspace/unpinSession': 'unpin a chat, which changes no run',
  'workspace/delete': 'move a workspace to the trash, from which the computer restores it',
  'workspace/initializeDefault': 'create the default workspace in its configured folder',
  'workspace/insertBefore': 'reorder the workspaces',
  'workspace/rename': 'rename a workspace',
  'workspace/archiveSession': 'archive a chat',
  'workspace/unarchiveSession': 'restore an archived chat',
  'workspace/insertSessionBefore': 'reorder the chats',
  'settings/describe': 'read the settings with every secret redacted, which the studio renders from',
  'sessionFeedback/record': 'record feedback on a chat, which leaves the home only when the person turned feedback upload on',
  'messageFeedback/delete': 'withdraw feedback on a message',
  'messageFeedback/list': 'read the feedback given on a chat\'s messages',
  'messageFeedback/put': 'record feedback on a message',
  'event:approval/request': 'answer an ordinary approval prompt; the answer guard still refuses a full-access grant',
  'event:user-questions/request': 'answer a question the agent asks',
  'event:api-session/activity': 'follow a chat\'s activity',
  'event:api-session/added': 'follow the chat list',
  'event:api-session/error': 'follow a chat\'s errors',
  'event:api-session/removed': 'follow the chat list',
  'event:api-session/status': 'follow whether a chat runs',
  'event:agent-preset/selected': 'follow a chat\'s preset choice',
  'event:commands/change': 'refresh the slash commands',
  'event:goal/activation-changed': 'follow a chat\'s goal',
  'event:llm/adapters-updated': 'refresh the model providers',
  'event:llm/models-updated': 'refresh the models',
  'event:permission-presets/catalog-changed': 'refresh the permission presets',
  'event:plugin-manager/changed': 'refresh the plugin list after a change',
  'event:plugin-manager/install-log': 'follow the log of a plugin install',
  'event:plugin-manager/install-state': 'follow the progress of a plugin install',
  'event:plugin-manager/update-state': 'follow the progress of a plugin update',
  'event:plugin-market/changed': 'refresh the plugin market after a change',
  'event:settings/document-updated': 'refresh the redacted settings',
  'event:schedule/changed': 'refresh the scheduled follow-ups',
} as const satisfies Readonly<Record<RemoteAccessAction, string>>

const ACCOUNT = 'account sign-in is off in Delorun, and an account change belongs to the home\'s own computer'
const OPEN_ON_COMPUTER = 'opens an application on the home\'s computer, which a device has no use for'

/**
 * Every action a device never takes over a reach listener, unlocked or not, with why it belongs to the home's own
 * computer: each reaches the home's credentials or account, or acts on the computer's own screen. A full-access grant,
 * device approval and starting or extending an unlock are refused at their own routes and guards, outside these tables.
 * The refusal names the action; this table tells a deliberate refusal from an action nobody classified. It is fixed in
 * code: no configuration moves an action out of it.
 */
export const REACH_DENIED_ACTIONS = {
  'settings/openSettingsDocument': 'opens the settings document in an editor on the home\'s computer, which a device has no use for',
  'account/getNotificationContent': ACCOUNT,
  'account/getNotifications': ACCOUNT,
  'account/reportNotificationEvent': ACCOUNT,
  'account/cancelSignIn': ACCOUNT,
  'account/getBalance': ACCOUNT,
  'account/getProfile': ACCOUNT,
  'account/getState': ACCOUNT,
  'account/hasRunningAccountTasks': ACCOUNT,
  'account/signOut': ACCOUNT,
  'account/startSignIn': ACCOUNT,
  'account/watch': ACCOUNT,
  'account/watchExpiry': ACCOUNT,
  'event:deepseek-account/session-expired': ACCOUNT,
  'event:deepseek-account/model-sign-in-required': ACCOUNT,
  'session/openWorkspacePath': OPEN_ON_COMPUTER,
  'session/workspacePathApplications': OPEN_ON_COMPUTER,
} as const satisfies Readonly<Record<RemoteAccessAction, string>>

/**
 * The actions of {@link REACH_DENIED_ACTIONS} that dangerous mode lifts for a device that holds an unlock. None: opening a
 * chat's folder in an application acts on the computer's own screen, so both such actions stay at the computer. The role
 * lists them, and the condition refuses them with `loopback-required: <action>` while the mode is off and with
 * `elevation-required: <action>` to a locked device while it holds. Each other action of the never table stays at the
 * computer in every mode.
 */
export const REACH_DANGEROUS_ACTIONS = {
} as const satisfies Partial<Readonly<Record<keyof typeof REACH_DENIED_ACTIONS, string>>>
const DANGEROUS_SET: ReadonlySet<string> = new Set(Object.keys(REACH_DANGEROUS_ACTIONS))

/**
 * The actions that add, remove and check a model provider's key from an approved device. Each is allowed to a
 * device without an unlock while PIN mode is off and no passkey is enrolled; otherwise a save or removal needs a grant
 * for exactly that call (Face ID, or the PIN), and is refused with `elevation-required: <action>` without one. A stored key is never sent to a device: `credentials/describe` answers presence
 * and writability only, and the events name the key, never its value. A call may name only the references the model
 * providers declare ({@link ReachAccessFacts.keyRefs}); any other is refused with {@link UNDECLARED_KEY_REFUSAL}.
 */
export const REACH_KEY_ACTIONS = {
  'credentials/describe': 'read whether a provider key is saved, never its value',
  'credentials/set': 'save or change a provider key, which the device never reads back',
  'credentials/unset': 'remove a saved provider key',
  'event:credentials/record-updated': 'follow a change to a saved credential record, naming its key and never its value',
  'event:credentials/reference-updated': 'follow a change to a saved provider key, naming it and never its value',
} as const satisfies Partial<Readonly<Record<RemoteAccessAction, string>>>
const KEY_SET: ReadonlySet<string> = new Set(Object.keys(REACH_KEY_ACTIONS))

/** The reason a key action that names a reference no model provider declares is refused to a device, unlocked or not. */
export const UNDECLARED_KEY_REFUSAL = 'loopback-required: a key reference no model provider names'

/**
 * Whether a key action's reference arguments all name a reference of the model providers. `credentials/set` and
 * `credentials/unset` name one `ref`, `credentials/describe` a list of `refs`; a list that holds one undeclared name is
 * refused as a whole, and arguments the condition cannot read are refused. Events carry no arguments.
 * @param action - the key action.
 * @param args - the call's arguments.
 * @param declared - the references the model providers declare.
 * @returns whether the call names only declared references.
 */
function namesOnlyDeclaredRefs(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>, declared: ReadonlySet<string>): boolean {
  const names = action === 'credentials/describe' ? args.refs : [args.ref]
  return Array.isArray(names) && names.every(name => typeof name === 'string' && declared.has(name))
}

/**
 * The settings namespaces an approved device writes without an unlock: the everyday settings the computer's
 * Settings pages change, each with what it holds. A write to any other namespace stays in
 * {@link REACH_ELEVATED_ACTIONS}. The computer-only switches, the protected rows and the default permission still
 * refuse a write to these namespaces first, and an approved device on a locked PIN page writes them as it sends a
 * message: PIN mode does not gate them.
 */
export const REACH_EVERYDAY_SETTINGS = {
  'ui-theme': 'the colour scheme',
  'ui-chat': 'the composer and chat display',
  'ui-conversation': 'the conversation display',
  'ui-settings-general': 'general display settings',
  'locale': 'the language',
  'delorun-theme': 'the palette, accent and studio look',
  'delorun-onboarding': 'how far the first-run guide has got',
  'delorun-sidebar': 'the sidebar',
  'delorun-chat-states': 'snooze and settle options',
  'delorun-cost-meter': 'the cost meter',
  'delorun-thinking-rsvp': 'the Thinking tab',
  'delorun-multiview': 'the Multiview layouts and panes',
} as const satisfies Readonly<Record<string, string>>

/**
 * The fields of an everyday namespace an approved device writes without an unlock, for a namespace whose other fields
 * stay unlocked-only: onboarding's `plugins` and `optionalRows` decide which packages the guide installs and which rows
 * it turns on, and chat states' `maxRecords` and `pruneMinutes` size the Host's sweep. A namespace not listed here has
 * every field everyday. A write that touches another field, rebuilds the whole section (`settings/replace`, or an
 * operation on the section's root) or cannot be read is not an everyday call and needs an unlock.
 */
export const REACH_EVERYDAY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'delorun-onboarding': ['done', 'step', 'pausedStart'],
  'delorun-chat-states': ['snoozePresets', 'autoSettleDays', 'refreshSeconds'],
}

/**
 * The top-level fields a settings write touches.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @returns the field names, or undefined for a write that rebuilds the section or whose arguments cannot be read.
 */
function fieldsTouched(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  if (action === 'settings/update') return isObject(args.patch) ? Object.keys(args.patch) : undefined
  if (action !== 'settings/mutate' || !Array.isArray(args.ops)) return undefined
  const fields: string[] = []
  for (const op of args.ops as unknown[]) {
    if (!isObject(op) || !Array.isArray(op.path) || typeof op.path[0] !== 'string') return undefined
    fields.push(op.path[0])
  }
  return fields
}

/**
 * Whether a value is a workspace icon the sidebar's picker can write: one the workspace icon schema accepts, whose text
 * is also free of markup characters, because the studio draws the letters and the emoji as text.
 * @param icon - the value.
 * @returns whether it is.
 */
function isWorkspaceIcon(icon: unknown): boolean {
  const parsed = parseWorkspaceIcon(icon)
  if (parsed === undefined || !isObject(icon)) return false
  return Object.keys(icon).every(key => key in DEFAULT_WORKSPACE_ICON) && !/[<>&"'`\\]/.test(parsed.letters + parsed.emoji)
}

/**
 * Whether a settings write to the sidebar row sets `workspaceIcons` only to valid icons: a whole map, one entry, or an
 * unset. A write that leaves the field alone passes.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @returns whether every icon the write sets is valid.
 */
function writesOnlyValidIcons(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>): boolean {
  const isMap = (value: unknown): boolean => isObject(value) && Object.values(value).every(isWorkspaceIcon)
  if (action === 'settings/update') return !isObject(args.patch) || !('workspaceIcons' in args.patch) || isMap(args.patch.workspaceIcons)
  if (action === 'settings/replace') return !isObject(args.section) || !('workspaceIcons' in args.section) || isMap(args.section.workspaceIcons)
  if (!Array.isArray(args.ops)) return false
  return (args.ops as unknown[]).every((op) => {
    if (!isObject(op) || !Array.isArray(op.path) || op.path[0] !== 'workspaceIcons') return true
    if (op.op === 'unset') return true
    if (op.path.length === 1) return isMap(op.value)
    return op.path.length === 2 && isWorkspaceIcon(op.value)
  })
}

/**
 * Whether a settings write to the theme row sets `branding` only to a record that passes the strict write check: a name
 * or greeting of the allowed length without control characters, a known icon source, a well-formed hash and an upload that
 * is a PNG, JPEG or WebP image within the size limit. A write that leaves the field alone passes.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @returns whether every branding record the write sets is acceptable.
 */
function writesOnlyValidBranding(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>): boolean {
  const ok = (value: unknown): boolean => checkStoredBranding(value) === undefined
  if (action === 'settings/update') return !isObject(args.patch) || !('branding' in args.patch) || ok(args.patch.branding)
  if (action === 'settings/replace') return !isObject(args.section) || !('branding' in args.section) || ok(args.section.branding)
  if (!Array.isArray(args.ops)) return false
  // A write at a path under `branding` replaces a field of the stored record, so it is checked as a record of that field.
  return (args.ops as unknown[]).every((op) => {
    if (!isObject(op) || !Array.isArray(op.path) || op.path[0] !== 'branding') return true
    if (op.op === 'unset') return true
    if (op.path.length === 1) return ok(op.value)
    return op.path.length === 2 && typeof op.path[1] === 'string' && ok({ [op.path[1]]: op.value })
  })
}

/**
 * Whether a settings write stays inside the fields an approved device writes without an unlock.
 * @param action - the settings write.
 * @param args - the call's arguments, naming a namespace of {@link REACH_EVERYDAY_SETTINGS}.
 * @returns whether every field it touches is everyday.
 */
function touchesOnlyEverydayFields(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>): boolean {
  if (args.ns === 'delorun-sidebar' && !writesOnlyValidIcons(action, args)) return false
  if (args.ns === 'delorun-theme' && !writesOnlyValidBranding(action, args)) return false
  const allowed = REACH_EVERYDAY_FIELDS[String(args.ns)]
  if (allowed === undefined) return true
  const touched = fieldsTouched(action, args)
  return touched !== undefined && touched.every(field => allowed.includes(field))
}

/**
 * The plugin rows of Delorun's own profile an approved device turns on or off through `pluginManager/setPluginEnabled`
 * without an unlock, by row id: the optional rows onboarding offers. The plugin manager still refuses a
 * protected row (see {@link PROTECTED_ROW_REFUSAL}).
 */
export const REACH_SHIPPED_ROWS = {
  'delorun-thinking-rsvp': 'the Thinking tab',
  'delorun-cost-meter': 'the cost meter',
} as const satisfies Readonly<Record<string, string>>

/**
 * The installed packages an approved device turns on or off through `pluginManager/setBundleEnabled` without an
 * unlock, by package name: the plugins onboarding recommends. Installing a package that is not on the
 * computer, and removing one, stay unlocked-only.
 */
export const REACH_SHIPPED_BUNDLES = {
  '@delorun/plugin-thinking-rsvp': 'the Thinking tab',
  '@delorun/plugin-cost-meter': 'the cost meter',
  '@deepseek-ai/dsh-experimental-session-search': 'chat search',
  '@deepseek-ai/dsh-experimental-terminal-bundle': 'the terminal',
  '@deepseek-ai/dsh-experimental-tool-worktree': 'worktrees',
  '@deepseek-ai/dsh-experimental-session-titles-bundle': 'chat titles',
  '@deepseek-ai/dsh-deepseek-chat-import': 'importing chats from the DeepSeek website',
} as const satisfies Readonly<Record<string, string>>

/**
 * Whether an elevated call is an everyday one a device makes without an unlock: a settings write to a namespace of
 * {@link REACH_EVERYDAY_SETTINGS}, or a plugin toggle of {@link REACH_SHIPPED_ROWS} or {@link REACH_SHIPPED_BUNDLES}.
 * @param action - the call's action.
 * @param args - the call's arguments.
 * @returns whether the call needs no unlock.
 */
function isEverydayCall(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>): boolean {
  if (SETTINGS_WRITES.has(action)) {
    return typeof args.ns === 'string' && Object.hasOwn(REACH_EVERYDAY_SETTINGS, args.ns) && touchesOnlyEverydayFields(action, args)
  }
  if (action === 'pluginManager/setPluginEnabled') return typeof args.id === 'string' && Object.hasOwn(REACH_SHIPPED_ROWS, args.id)
  if (action === 'pluginManager/setBundleEnabled') return typeof args.name === 'string' && Object.hasOwn(REACH_SHIPPED_BUNDLES, args.name)
  return false
}

/**
 * The actions of {@link REACH_ELEVATED_ACTIONS} (and `session/create` outside the known workspaces) that renew a sliding
 * unlock when allowed: the deliberate, state-changing steps a person takes while working. Every other action, including
 * one added later, does not renew: a studio lists, watches, retains and reattaches on its own while the person does
 * nothing, and reports client errors automatically.
 */
export const RENEWING_ACTIONS: ReadonlySet<string> = new Set([
  'settings/mutate', 'settings/replace', 'settings/update', 'commands/execute',
  'pluginManager/cancelInstall', 'pluginManager/installBundle', 'pluginManager/removeBundle', 'pluginManager/setBundleEnabled',
  'pluginManager/setPluginEnabled', 'pluginManager/setVersionExemption', 'pluginManager/updateBundle', 'pluginManager/undo', 'pluginManager/restore',
  'terminal/create', 'terminal/close', 'terminal/rename',
  'mcpManager/probe', 'mcpManager/restart',
  'directoryPicker/createDirectory', 'directoryPicker/pick',
  'workspace/create', 'session/create',
  'dynamicCordisRunner/invoke', 'dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/settleUserRun', 'dynamicCordisRunner/resolveRequestRun',
  'dynamicCordisRunner/stopFromPanel', 'dynamicCordisRunner/undefineFromPanel',
])

/**
 * The actions of {@link REACH_ELEVATED_ACTIONS} that need the unlock and never renew it: reads, keepalive streams
 * (`terminal/retain`, `terminal/watch`), automatic client reports and events. Together with {@link RENEWING_ACTIONS} it
 * covers every elevated action, which `tests/unlock-slide.spec.ts` checks, so a new action is classified on purpose.
 */
export const ELEVATED_READS: ReadonlySet<string> = new Set([
  'terminal/watch', 'terminal/retain', 'terminal/attach',
  'mcpManager/watch',
  'directoryPicker/list',
  'dynamicCordisRunner/getClientCode', 'dynamicCordisRunner/inventory', 'dynamicCordisRunner/resolveInspectQuery', 'dynamicCordisRunner/syncInspectManifest',
  'dynamicCordisRunner/reportClientGuardFailure', 'dynamicCordisRunner/reportRenderFailure',
  'event:cordis/request-run', 'event:cordis/request-run-resolved', 'event:cordis/dynamic-package', 'event:cordis/dynamic-retract',
  'event:cordis/inspect-query', 'event:cordis/inspect-query-resolved',
])

const PLUGIN_MANAGEMENT = 'install, enable, update or remove a plugin, code that runs in the Host outside any sandbox; the plugin manager still refuses every change to a guard plugin'
const PROFILE_HISTORY = 'undo or restore a profile change; the plugin manager still refuses one that changes a guard plugin'
const SETTINGS_WRITE = 'change a setting of the home'
const MCP_MANAGEMENT = 'manage the external tool servers, which start the commands the home configured for them'
const TERMINAL = 'use a terminal, a shell on the home\'s computer outside the sandbox'
const DIRECTORY_PICKER = 'browse and create folders on the home\'s computer'
const DYNAMIC_PLUGIN = 'run model-authored plugin code in the Host'

/**
 * Every action a device takes only while it holds an unlock the person approved at the home's own computer (C14,
 * "Elevation"), with what it lets the person do: the rare actions that widen what the agent can reach, add code that
 * runs on the computer, or change the home's settings. Without an unlock each is refused with
 * `elevation-required: <action>`; so is a `session/create` in a folder outside the known workspaces, which the condition
 * decides. An action is elevated only by being listed here: a new refused action is never.
 */
export const REACH_ELEVATED_ACTIONS = {
  'settings/mutate': SETTINGS_WRITE,
  'settings/replace': SETTINGS_WRITE,
  'settings/update': SETTINGS_WRITE,
  'commands/execute': 'run a slash command, which can change settings, plugins or the profile',
  'pluginManager/cancelInstall': PLUGIN_MANAGEMENT,
  'pluginManager/installBundle': PLUGIN_MANAGEMENT,
  'pluginManager/removeBundle': PLUGIN_MANAGEMENT,
  'pluginManager/setBundleEnabled': PLUGIN_MANAGEMENT,
  'pluginManager/setPluginEnabled': PLUGIN_MANAGEMENT,
  'pluginManager/setVersionExemption': PLUGIN_MANAGEMENT,
  'pluginManager/updateBundle': PLUGIN_MANAGEMENT,
  'pluginManager/undo': PROFILE_HISTORY,
  'pluginManager/restore': PROFILE_HISTORY,
  'terminal/attach': TERMINAL,
  'terminal/close': TERMINAL,
  'terminal/create': TERMINAL,
  'terminal/rename': TERMINAL,
  'terminal/retain': TERMINAL,
  'terminal/watch': TERMINAL,
  'mcpManager/probe': MCP_MANAGEMENT,
  'mcpManager/restart': MCP_MANAGEMENT,
  'mcpManager/watch': MCP_MANAGEMENT,
  'directoryPicker/createDirectory': DIRECTORY_PICKER,
  'directoryPicker/list': DIRECTORY_PICKER,
  'directoryPicker/pick': DIRECTORY_PICKER,
  'workspace/create': 'register a new folder as a workspace, which decides where a chat\'s commands may write',
  'dynamicCordisRunner/getClientCode': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/inventory': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/invoke': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/reportClientGuardFailure': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/reportRenderFailure': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/resolveInspectQuery': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/resolveRequestRun': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/runHostHalf': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/settleUserRun': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/stopFromPanel': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/syncInspectManifest': DYNAMIC_PLUGIN,
  'dynamicCordisRunner/undefineFromPanel': DYNAMIC_PLUGIN,
  'event:cordis/request-run': DYNAMIC_PLUGIN,
  'event:cordis/request-run-resolved': DYNAMIC_PLUGIN,
  'event:cordis/dynamic-package': DYNAMIC_PLUGIN,
  'event:cordis/dynamic-retract': DYNAMIC_PLUGIN,
  'event:cordis/inspect-query': DYNAMIC_PLUGIN,
  'event:cordis/inspect-query-resolved': DYNAMIC_PLUGIN,
} as const satisfies Readonly<Record<RemoteAccessAction, string>>

/**
 * The elevated actions no unlock opens: every `terminal/*` action, a new one included. A terminal is a shell outside the
 * sandbox, so a device needs a grant for exactly the call, from a passkey or a PIN; an unlock window never opens one.
 */
export const GRACE_REFUSED_ACTIONS: ReadonlySet<string> = new Set(Object.keys(REACH_ELEVATED_ACTIONS).filter(action => action.startsWith('terminal/')))

/**
 * Assert that no action is in two of the tables.
 * @param tables - the allowed, the elevated and the never tables, by name.
 * @throws {TypeError} naming every action two tables list.
 */
export function assertDisjoint(tables: Readonly<Record<string, Readonly<Record<string, string>>>>): void {
  const seen = new Map<string, string>()
  const both: string[] = []
  for (const [name, table] of Object.entries(tables)) {
    for (const action of Object.keys(table)) {
      const first = seen.get(action)
      if (first === undefined) seen.set(action, name)
      else both.push(`${action} (${first}, ${name})`)
    }
  }
  if (both.length > 0) throw new TypeError(`@delorun/home-auth: reach access lists ${JSON.stringify(both.sort())} in two tables`)
}

assertDisjoint({ allowed: REACH_ALLOWED_ACTIONS, keys: REACH_KEY_ACTIONS, elevated: REACH_ELEVATED_ACTIONS, never: REACH_DENIED_ACTIONS })

/** The allowed actions, which every role of the policy lists. */
const ALLOWED: readonly RemoteAccessAction[] = Object.freeze(Object.keys(REACH_ALLOWED_ACTIONS) as (keyof typeof REACH_ALLOWED_ACTIONS)[])
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED)
const ELEVATED_SET: ReadonlySet<string> = new Set(Object.keys(REACH_ELEVATED_ACTIONS))
/** The actions every role lists: the allowed ones, the elevated ones, which the condition refuses without an unlock, and the ones dangerous mode lifts. */
const ROLE_ACTIONS: readonly RemoteAccessAction[] = Object.freeze([
  ...ALLOWED,
  ...(Object.keys(REACH_KEY_ACTIONS) as (keyof typeof REACH_KEY_ACTIONS)[]),
  ...(Object.keys(REACH_ELEVATED_ACTIONS) as (keyof typeof REACH_ELEVATED_ACTIONS)[]),
  ...(Object.keys(REACH_DANGEROUS_ACTIONS) as (keyof typeof REACH_DANGEROUS_ACTIONS)[]),
])

/**
 * The role over one resource kind.
 * @param resource - the kind.
 * @returns the role listing every allowed and every elevated action.
 */
function role<K extends RemoteAccessResourceKind>(resource: K): RemoteAccessRole<K> {
  return { name: `delorun:reach-device-${resource}`, resource, actions: ROLE_ACTIONS }
}

const ALLOW: RemoteAccessDecision = { kind: 'allow' }

/**
 * The actions that read a chat's workspace by a path the device names. The workspace-file service reads an absolute
 * path wherever it points and follows a symbolic link in any directory of a read's path, so the policy resolves each
 * path itself before the service runs: a device reaches a file or folder only when its real path lies inside the real
 * path of the chat's workspace and outside the Delorun home.
 */
const WORKSPACE_PATH_ACTIONS: ReadonlySet<string> = new Set([
  'workspaceFiles/list', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat', 'officeKit/render',
  'workspaceFiles/changes',
])

/**
 * A path the policy does not resolve the way the filesystem service does, so it is refused: a NUL, a `~` the service
 * expands to the person's home directory, and a `..` segment, which the service walks physically through a link.
 */
const UNRESOLVED_PATH = /\0|^~|(?:^|[/\\])\.\.(?:[/\\]|$)/u

/**
 * The real path of a path, or undefined when it does not exist or cannot be read; a device is refused either way.
 * @param path - the absolute path.
 * @returns the real path.
 */
function realPathOf(path: string): string | undefined {
  try {
    // The native call spells each component as the filesystem stores it, which `within` relies on where names fold case.
    return realpathSync.native(path)
  } catch (_unresolvable: unknown) {
    // A path that does not resolve names no file the device may read; the refusal says so instead of the service.
    return undefined
  }
}

/**
 * A real path as the platform's default filesystem compares it: without case on Windows and macOS.
 * @param path - the real path.
 * @returns the comparison key.
 */
function comparable(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
}

/**
 * Whether one real path lies inside another, or is it.
 * @param parent - the real path of the directory.
 * @param child - the real path.
 * @returns whether it does.
 */
function within(parent: string, child: string): boolean {
  const path = relative(comparable(parent), comparable(child))
  return path === '' || (!isAbsolute(path) && path.split(sep)[0] !== '..')
}

/** Where a device's workspace-file call may reach: the chat's real workspace root, and the Delorun home it never reaches. */
interface WorkspaceBounds {
  readonly root: string
  readonly delorunHome: string
  /** Whether a path must lie inside {@link root}; false only for an unlocked device while dangerous mode holds. */
  readonly confined: boolean
}

/**
 * The real path of an absolute path when it lies inside the chat's workspace and outside the Delorun home.
 * @param bounds - the real workspace root and the real Delorun home.
 * @param path - the absolute path.
 * @returns the real path, or undefined when it does not resolve or resolves outside.
 */
function reachableReal(bounds: WorkspaceBounds, path: string): string | undefined {
  const real = realPathOf(path)
  if (real === undefined || (bounds.confined && !within(bounds.root, real)) || within(bounds.delorunHome, real)) return undefined
  return real
}

/**
 * The real path a device's path names, resolved as the workspace-file service resolves it: an absolute path as it is,
 * a relative one from the workspace root.
 * @param bounds - the real workspace root and the real Delorun home.
 * @param path - the path as the device sent it.
 * @returns the real path, or undefined when the device may not reach it.
 */
function reachablePath(bounds: WorkspaceBounds, path: unknown): string | undefined {
  if (typeof path !== 'string' || UNRESOLVED_PATH.test(path)) return undefined
  return reachableReal(bounds, resolve(bounds.root, path))
}

/**
 * Whether every path a workspace-file call names is one a device may reach. A byte read with a base file names two:
 * the base file, and the path the service resolves from the base file's real directory with `/` separators.
 * @param bounds - the real workspace root and the real Delorun home.
 * @param args - the call's named arguments.
 * @returns whether the call reaches only the chat's workspace.
 */
function workspacePathsReachable(bounds: WorkspaceBounds, args: Readonly<Record<string, unknown>>): boolean {
  const options = args.options
  const baseFile: unknown = typeof options === 'object' && options !== null ? Reflect.get(options, 'baseFile') : undefined
  if (baseFile === undefined) return reachablePath(bounds, args.path) !== undefined
  const base = reachablePath(bounds, baseFile)
  if (base === undefined || typeof args.path !== 'string' || args.path.includes('\0')) return false
  return reachableReal(bounds, resolve(dirname(base), args.path.replace(/\\/g, '/'))) !== undefined
}

/**
 * The real bounds of the chat a workspace-file call names.
 * @param facts - the Host state the policy reads.
 * @param resource - the resource the call is decided on, a Session for every workspace-file call.
 * @returns the bounds, or undefined when the Host cannot name the chat's workspace, or it or the Delorun home does not resolve.
 */
function boundsOf(facts: Pick<ReachAccessFacts, 'workspaceRootOf' | 'delorunHome'>, resource: RemoteAccessResource): WorkspaceBounds | undefined {
  if (resource.kind !== 'session') return undefined
  const workspace = facts.workspaceRootOf(resource.id)
  const root = workspace === undefined ? undefined : realPathOf(workspace)
  const delorunHome = realPathOf(facts.delorunHome)
  if (root === undefined || delorunHome === undefined) return undefined
  return { root, delorunHome, confined: true }
}

/** The condition every binding of a device carries: one call's action, the resource it is decided on and its arguments. */
type ReachCondition = (request: {
  readonly action: RemoteAccessAction
  readonly resource: RemoteAccessResource
  readonly args?: Readonly<Record<string, unknown>>
}) => RemoteAccessDecision

/**
 * A boolean setting only the home's own computer moves away from its safe value, such as the external-agent consent:
 * a device's settings write to its namespace is refused, unlocked or not, unless it leaves the field a literal
 * {@link ComputerOnlySwitch.safeValue}. The plugin that owns the field registers it with
 * `HomeAuthService.registerComputerOnlySwitch` while it is mounted.
 */
export interface ComputerOnlySwitch {
  /** The settings namespace, the id of the plugin's profile row. */
  readonly ns: string
  /** The boolean field of the row's configuration, or {@link EVERY_FIELD} to refuse every settings write to the namespace. */
  readonly field: string
  /** What the field turns on, as the refusal names it, such as `the external-agent consent`. */
  readonly label: string
  /**
   * The one value a device may write, `true` when omitted. A field whose `true` loosens a restriction, such as the
   * external-agent consent's `fullAccessStartsAgents`, names `false`, so a device can tighten it and only the computer
   * can turn it on.
   */
  readonly safeValue?: boolean
  /**
   * For a field holding one of an ordered list of values, such as an external agent's safety level, instead of a
   * boolean: a device may write a value of equal or lower rank than the field's current value, and a looser value or a
   * removal stays at the computer. Dangerous mode never lifts such a switch.
   */
  readonly ranked?: {
    /** The values from the most to the least restricted; a value not listed counts as looser than all of them. */
    readonly order: readonly string[]
    /** The value the field holds now, read at each settings write. */
    readonly current: () => string
  }
}

/** The {@link ComputerOnlySwitch.field} that makes the whole namespace computer-only: a device writes none of its fields. */
export const EVERY_FIELD = '*'

/**
 * The computer-only switches dangerous mode lifts for an unlocked device, by settings namespace. A switch not listed
 * here, such as a remote-access setting (reach or pairing), stays at the computer in every mode, so registering a
 * switch lifts nothing.
 */
export const DANGEROUS_LIFTABLE_SWITCHES: ReadonlySet<string> = new Set(['delorun-delegation-consent'])

/**
 * The reason a settings write that would move a computer-only switch off its safe value is refused to a device,
 * unlocked or not.
 * @param label - the switch's {@link ComputerOnlySwitch.label}.
 * @param safeValue - the switch's {@link ComputerOnlySwitch.safeValue}; the refusal names the other direction.
 * @returns `loopback-required: turning <label> off`, or `on` for a switch whose safe value is `false`.
 */
export function switchOffRefusal(label: string, safeValue = true): string {
  return `loopback-required: turning ${label} ${safeValue ? 'off' : 'on'}`
}

/** The settings writes whose arguments the condition reads for a field only the computer lowers. */
const SETTINGS_WRITES: ReadonlySet<string> = new Set(['settings/mutate', 'settings/update', 'settings/replace'])

/**
 * Whether a value is a JSON object.
 * @param value - the value.
 * @returns whether it is a non-array object.
 */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one `settings/mutate` operation leaves a switch's field safe: an operation on another field, or a `set` that
 * writes the literal safe value to it, directly or in the whole section.
 * @param field - the switch's field.
 * @param safe - the switch's safe value.
 * @param op - the operation, as the call sent it.
 * @returns whether it keeps the switch safe.
 */
function opKeepsSwitch(field: string, safe: boolean, op: unknown): boolean {
  if (!isObject(op) || !Array.isArray(op.path)) return false
  const [head, ...rest] = op.path as unknown[]
  if (head === undefined) return op.op === 'set' && isObject(op.value) && op.value[field] === safe
  if (head !== field) return true
  return rest.length === 0 && op.op === 'set' && op.value === safe
}

/**
 * Whether a settings write could loosen a ranked field: it removes the field, writes a value that is not a string or
 * ranks above the current value, or has arguments the condition cannot read.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @param field - the field.
 * @param ranked - the switch's order and current value.
 * @returns whether the write is refused to a device.
 */
function loosensRanked(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>, field: string, ranked: NonNullable<ComputerOnlySwitch['ranked']>): boolean {
  const rank = (value: string): number => ranked.order.includes(value) ? ranked.order.indexOf(value) : ranked.order.length
  const current = rank(ranked.current())
  return removesField(action, args, field)
    || fieldWritten(action, args, field).some(value => typeof value !== 'string' || rank(value) > current)
}

/**
 * Whether a settings write could move a computer-only switch off its safe value. A write to another namespace never
 * does; a write to its namespace does unless its arguments name the field only as the literal safe value, and a
 * `replace`, which rebuilds the section, must name it so. Arguments the condition cannot read count as moving it.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @param target - the switch.
 * @returns whether the write is refused to a device.
 */
function turnsSwitchOff(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>, target: ComputerOnlySwitch): boolean {
  if (args.ns !== target.ns) return false
  const { field } = target
  const safe = target.safeValue ?? true
  if (field === EVERY_FIELD) return true
  if (target.ranked !== undefined) return loosensRanked(action, args, field, target.ranked)
  switch (action) {
    case 'settings/mutate':
      return !Array.isArray(args.ops) || !args.ops.every(op => opKeepsSwitch(field, safe, op))
    case 'settings/update':
      return !isObject(args.patch) || (field in args.patch && args.patch[field] !== safe)
    default:
      // `settings/replace`, the only other member of SETTINGS_WRITES.
      return !isObject(args.section) || args.section[field] !== safe
  }
}

/**
 * The fields a device's settings write loosens, which dangerous mode lets through: the switches
 * {@link DANGEROUS_LIFTABLE_SWITCHES} lists that the write turns off, and the default preset when it loosens.
 * @param facts - the Host state the policy reads.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @param loosens - whether the write loosens the default permission.
 * @returns the lifts, each with the value the call sets when its arguments name one.
 */
function liftsOf(facts: Pick<ReachAccessFacts, 'computerOnlySwitches'>, action: RemoteAccessAction, args: Readonly<Record<string, unknown>>, loosens: boolean): SettingsLift[] {
  const ns = String(args.ns)
  const lifted = (field: string): SettingsLift => ({
    ns, field, written: fieldWritten(action, args, field).at(-1), ...removesField(action, args, field) ? { unset: true } : {},
  })
  const switches = facts.computerOnlySwitches().filter(target => DANGEROUS_LIFTABLE_SWITCHES.has(target.ns) && target.ranked === undefined && turnsSwitchOff(action, args, target))
  return [...switches.map(target => lifted(target.field)), ...loosens ? [lifted('defaultPreset')] : []]
}

/** The reason a settings write that would loosen the permission new chats start in is refused to a device, unlocked or not. */
export const DEFAULT_PERMISSION_REFUSAL = 'loopback-required: loosening the permission new chats start in'

/** A permission preset's sandbox mode and approval policy, which a device may tighten but not loosen. */
export interface PermissionLevel {
  readonly sandbox: string
  readonly approval: string
}

/** The permission new chats start in, as the permission-preset rows hold it. */
export interface DefaultPermission {
  /** The settings namespaces of the permission-preset rows, whose `defaultPreset` names it. */
  readonly namespaces: ReadonlySet<string>
  /** The level of the preset new chats start in now; undefined when it cannot be read. */
  readonly current: PermissionLevel | undefined
  /**
   * The level of one preset.
   * @param name - the preset's key.
   * @returns its level, or undefined for a name the rows do not hold.
   */
  readonly levelOf: (name: string) => PermissionLevel | undefined
}

/** Sandbox modes and approval policies from the strictest to the loosest. */
const SANDBOX_ORDER: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVAL_ORDER: readonly string[] = ['ask', 'never']

/**
 * Whether a level is looser than another in its sandbox mode or approval policy; an unknown value counts as loosest.
 * @param next - the level a write would set.
 * @param current - the level now.
 * @returns whether it is.
 */
function looser(next: PermissionLevel, current: PermissionLevel): boolean {
  const rank = (order: readonly string[], value: string): number => order.includes(value) ? order.indexOf(value) : order.length
  return rank(SANDBOX_ORDER, next.sandbox) > rank(SANDBOX_ORDER, current.sandbox)
    || rank(APPROVAL_ORDER, next.approval) > rank(APPROVAL_ORDER, current.approval)
}

/**
 * The values a settings write sets a field to: undefined for one that removes it, which falls back to an inferred
 * preset, and for arguments the condition cannot read.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @param field - the field.
 * @returns the values, empty when the write leaves the field alone.
 */
function fieldWritten(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>, field: string): readonly unknown[] {
  switch (action) {
    case 'settings/mutate':
      if (!Array.isArray(args.ops)) return [undefined]
      return args.ops.flatMap((op: unknown) => {
        if (!isObject(op) || !Array.isArray(op.path)) return [undefined]
        const [head, ...rest] = op.path as unknown[]
        if (head === undefined) return [op.op === 'set' && isObject(op.value) ? op.value[field] : undefined]
        if (head !== field) return []
        return [rest.length === 0 && op.op === 'set' ? op.value : undefined]
      })
    case 'settings/update':
      if (!isObject(args.patch)) return [undefined]
      return field in args.patch ? [args.patch[field]] : []
    default:
      // `settings/replace`, the only other member of SETTINGS_WRITES.
      return [isObject(args.section) ? args.section[field] : undefined]
  }
}

/**
 * Whether a settings write names the removal of a field: an `unset` operation on it, or a `replace` whose section does
 * not hold it. Arguments the condition cannot read do not count; their value stays unknown.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @param field - the field.
 * @returns whether the write leaves the field unset.
 */
function removesField(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>, field: string): boolean {
  switch (action) {
    case 'settings/mutate':
      return Array.isArray(args.ops) && args.ops.some((op: unknown) => isObject(op) && op.op === 'unset' && Array.isArray(op.path) && op.path.length === 1 && op.path[0] === field)
    case 'settings/update':
      return false
    default:
      // `settings/replace`, the only other member of SETTINGS_WRITES.
      return isObject(args.section) && !(field in args.section)
  }
}

/**
 * Whether a settings write could loosen the permission new chats start in: it writes a permission-preset row's
 * `defaultPreset` to a preset whose sandbox mode or approval policy is looser than the current one, to a preset the
 * rows do not hold, or away, or while the current preset cannot be read.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @param permission - the permission new chats start in, or undefined without permission presets.
 * @returns whether the write is refused to a device.
 */
function loosensDefaultPermission(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>, permission: DefaultPermission | undefined): boolean {
  if (permission === undefined || typeof args.ns !== 'string' || !permission.namespaces.has(args.ns)) return false
  const { current } = permission
  return fieldWritten(action, args, 'defaultPreset').some((name) => {
    const next = typeof name === 'string' ? permission.levelOf(name) : undefined
    return next === undefined || current === undefined || looser(next, current)
  })
}

/**
 * The plugin-manager calls whose arguments name one plugin row by its Loader entry id. Every other plugin-manager
 * change (bundles, installs, version exemptions, undo and restore) changes rows the policy cannot see from the call's
 * arguments, and the plugin manager itself refuses one that would disable, remove or reconfigure a row of a module its
 * `protectedPlugins` names, or restore a profile state in which one differs (`management-required`).
 */
const ROW_CALLS: ReadonlySet<string> = new Set(['pluginManager/setPluginEnabled'])

/** The reason a plugin-manager call that names a protected row is refused to a device, unlocked or not. */
export const PROTECTED_ROW_REFUSAL = 'loopback-required: changing a protected plugin row'

/**
 * The refusal of a consent or guard row's settings write during a device's approval grace. It names no grant action, so
 * a phone's Face ID step never asks for one: no grant admits the write before the grace ends.
 */
export const GRACE_PROTECTED_ROW_REFUSAL = 'loopback-required: a consent or guard row\'s settings while the pairing grace lasts'

/**
 * The module names a `plugin-manager` row's configuration protects: its `protectedPlugins`, the single list a profile
 * keeps of the guard, consent and sandbox rows that plugin management may not change.
 * @param config - the row's configuration, as the Loader holds it.
 * @returns the module names, empty when the row names none, or undefined when `protectedPlugins` is not a list of
 * strings.
 */
export function protectedPluginsIn(config: unknown): ReadonlySet<string> | undefined {
  const listed: unknown = isObject(config) ? config.protectedPlugins : undefined
  if (listed === undefined) return new Set()
  if (!Array.isArray(listed) || !listed.every(name => typeof name === 'string')) return undefined
  return new Set(listed as string[])
}

/**
 * Whether a plugin-manager call names a protected row, or names its row in arguments the condition cannot read. While
 * the protected rows cannot be read, every call that names a row counts.
 * @param facts - the protected rows.
 * @param args - the call's arguments.
 * @returns whether the call is refused to a device.
 */
function namesProtectedRow(facts: Pick<ReachAccessFacts, 'protectedEntryIds'>, args: Readonly<Record<string, unknown>>): boolean {
  const ids = facts.protectedEntryIds()
  return ids === undefined || typeof args.id !== 'string' || ids.has(args.id)
}

/**
 * The modules whose plugin rows only the computer changes, with the reason for each: disabling one removes the unlock
 * gate or the sandbox, and a write to the webhook server's settings could move its loopback listener onto the network,
 * so no unlock, PIN page or dangerous mode lets a device do it. The plugin manager's `protectedPlugins` is a separate
 * list: a bundle may still add a row of one of these modules.
 */
export const COMPUTER_ONLY_ROW_MODULES = {
  '@delorun/home-auth': 'it holds the pairing and unlock gate',
  '@delorun/reach': 'it decides which addresses reach the studio',
  '@deepseek-ai/dsh-sandbox-local': 'it confines the commands a chat runs',
  '@deepseek-ai/dsh-sandbox-policy': 'it decides what the sandbox allows',
  '@delorun/bundle-webhooks/server': 'it decides the address and port the GitHub webhook endpoint listens on',
} as const satisfies Readonly<Record<string, string>>

/**
 * Whether a settings write names the namespace of a row of {@link COMPUTER_ONLY_ROW_MODULES} (a namespace is the row's
 * Loader entry id, with or without its `include:` prefix), or while those rows cannot be read. A call whose
 * namespace is not text names no row; the wire validates it.
 * @param facts - the computer-only rows.
 * @param args - the call's arguments.
 * @returns whether the write is refused to a device in every mode.
 */
function settingsOfComputerOnlyRow(facts: Pick<ReachAccessFacts, 'computerOnlyEntryIds'>, args: Readonly<Record<string, unknown>>): boolean {
  const ids = facts.computerOnlyEntryIds()
  if (ids === undefined) return true
  if (typeof args.ns !== 'string') return false
  return ids.has(args.ns) || ids.has(`include:${args.ns}`)
}

/**
 * Whether a settings write names the namespace of a row the plugin manager protects (its `protectedPlugins`), or the
 * protected rows cannot be read.
 * @param facts - the protected rows.
 * @param args - the call's arguments.
 * @returns whether the write needs a real unlock.
 */
function settingsOfProtectedRow(facts: Pick<ReachAccessFacts, 'protectedEntryIds'>, args: Readonly<Record<string, unknown>>): boolean {
  const ids = facts.protectedEntryIds()
  if (ids === undefined) return true
  return typeof args.ns === 'string' && (ids.has(args.ns) || ids.has(`include:${args.ns}`))
}

/** The plugin-manager calls that enable, disable, remove or update one bundle (package) by `name`. */
const BUNDLE_CALLS: ReadonlySet<string> = new Set(['pluginManager/setBundleEnabled', 'pluginManager/removeBundle', 'pluginManager/updateBundle'])

/**
 * The bundles whose rows include a {@link COMPUTER_ONLY_ROW_MODULES} module, besides the packages that provide those
 * modules: turning one off, removing or replacing it would take the unlock gate, reach or the sandbox with it, and
 * replacing `@delorun/bundle-webhooks` could change the address its webhook server listens on.
 */
export const COMPUTER_ONLY_BUNDLES: readonly string[] = [
  '@delorun/bundle-local', '@delorun/bundle-headless', '@delorun/bundle-studio', '@delorun/bundle-webhooks',
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-minimal', '@deepseek-ai/dsh-headless',
]

/**
 * Whether a bundle call names a package that provides a computer-only module or holds its rows, or names its package in
 * a non-text `name`. A call with no `name` is malformed and is left to the unlock and the plugin manager.
 * @param args - the call's arguments.
 * @returns whether the call is refused to a device in every mode.
 */
function namesComputerOnlyBundle(args: Readonly<Record<string, unknown>>): boolean {
  if (args.name === undefined) return false
  if (typeof args.name !== 'string') return true
  const name = args.name
  return COMPUTER_ONLY_BUNDLES.includes(name) || Object.keys(COMPUTER_ONLY_ROW_MODULES).some(module => module === name || module.startsWith(`${name}/`))
}

/**
 * Whether a plugin-manager call names a row of {@link COMPUTER_ONLY_ROW_MODULES}, or names its row in arguments the
 * condition cannot read. While those rows cannot be read, every call that names a row counts.
 * @param facts - the computer-only rows.
 * @param args - the call's arguments.
 * @returns whether the call is refused to a device in every mode.
 */
function namesComputerOnlyRow(facts: Pick<ReachAccessFacts, 'computerOnlyEntryIds'>, args: Readonly<Record<string, unknown>>): boolean {
  const ids = facts.computerOnlyEntryIds()
  return ids === undefined || typeof args.id !== 'string' || ids.has(args.id)
}

/**
 * The slash commands a device runs, by name, with what each changes; `commands/execute` of any other command, or of a
 * line that names none, is refused to a device, unlocked or not. Each listed command changes only its own chat or
 * reads it: none writes a setting, a plugin row or the profile, so a new command a plugin registers is refused until
 * it is listed here.
 */
export const REACH_DEVICE_COMMANDS = {
  compact: 'compact the chat\'s older history',
  export: 'download the chat\'s log',
  goal: 'set or read the chat\'s goal',
  permission: 'switch the chat\'s permission preset; a full-access preset meets the workspace\'s consent where the home asks for one, which only the computer grants, and with setup\'s stock or dangerous answer it does not',
  plan: 'enter or leave plan mode in the chat',
} as const satisfies Readonly<Record<string, string>>

/** The reason `commands/execute` of a command {@link REACH_DEVICE_COMMANDS} does not list is refused. */
export const UNLISTED_COMMAND_REFUSAL = 'loopback-required: commands/execute of a command a device does not run'

/**
 * Whether `commands/execute` runs a command a device may run: its line parses, as the commands service parses it, to
 * a name {@link REACH_DEVICE_COMMANDS} lists.
 * @param args - the call's arguments.
 * @returns whether it does.
 */
function runsDeviceCommand(args: Readonly<Record<string, unknown>>): boolean {
  if (typeof args.line !== 'string') return false
  const name = parseCommand(args.line)?.name
  return name !== undefined && Object.hasOwn(REACH_DEVICE_COMMANDS, name)
}

/** The reason a `session/create` outside the known workspaces is refused without an unlock. */
export const CREATE_OUTSIDE_WORKSPACES = 'elevation-required: session/create in a folder outside the known workspaces'

/**
 * Whether a `session/create` starts its chat in a Workspace the person registered at the computer: it names a
 * Workspace the Host lists and no folder, or a folder whose real path is the real path of one. A call that names
 * neither starts the chat in the Host's own working directory, which is no known workspace.
 * @param facts - the Host state the policy reads.
 * @param args - the call's named arguments.
 * @returns whether it does.
 */
function createsInKnownWorkspace(facts: Pick<ReachAccessFacts, 'workspaces'>, args: Readonly<Record<string, unknown>>): boolean {
  const request = Object.values(args).find((value): value is object => typeof value === 'object' && value !== null)
  const workspaceId: unknown = request === undefined ? undefined : Reflect.get(request, 'workspaceId')
  const cwd: unknown = request === undefined ? undefined : Reflect.get(request, 'cwd')
  if (workspaceId !== undefined) return cwd === undefined && facts.workspaces().some(workspace => workspace.id === workspaceId)
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) return false
  const real = realPathOf(cwd)
  if (real === undefined) return false
  return facts.workspaces().some((workspace) => {
    const root = realPathOf(workspace.path)
    return root !== undefined && comparable(root) === comparable(real)
  })
}

/**
 * The condition of one device's bindings on one listener, the single place an elevated action is decided. It refuses
 * an action of {@link REACH_ELEVATED_ACTIONS} with `elevation-required: <action>` unless the device holds a running
 * unlock on the principal's listener, for a call and for an event, a snapshot or a list filter alike, and logs each
 * call an unlock admits with the unlock's id once the home keeps no grant store. Once it does, every elevated action needs a grant for exactly the call, from a passkey
 * or a PIN, on every device, and no unlock window admits it (A483); no switch, workspace grant or dangerous mode waives that. Every `terminal/*` action ({@link GRACE_REFUSED_ACTIONS}) is refused before the store starts too.
 * It treats a `session/create` that starts a chat outside the known
 * workspaces (see {@link createsInKnownWorkspace}) the same way, with {@link CREATE_OUTSIDE_WORKSPACES}: a folder
 * decides where the chat's commands may write. It refuses a workspace-file call unless every path it names is one a
 * device may reach (see {@link WORKSPACE_PATH_ACTIONS}), unlocked or not. Before the unlock check, and so unlocked or
 * not, it refuses a settings write that could turn a registered {@link ComputerOnlySwitch} off or loosen the
 * permission new chats start in, a plugin-manager call that names a protected row ({@link PROTECTED_ROW_REFUSAL}), and
 * a slash command {@link REACH_DEVICE_COMMANDS} does not list ({@link UNLISTED_COMMAND_REFUSAL}), except while
 * dangerous mode holds ({@link ReachAccessFacts.dangerousMode}), when an unlock decides them. It refuses an action of
 * {@link REACH_DANGEROUS_ACTIONS} with `loopback-required: <action>` unless the mode holds and the device is unlocked,
 * and it lets an unlocked device outside the chat's workspace, though never into the Delorun home, while the mode holds. Every other action is allowed as its role lists it, and so is every
 * other question asked without a call's arguments.
 * @param facts - the Host state the policy reads.
 * @param principal - the device and the listener whose bindings carry the condition.
 * @returns the condition.
 */
export function createCondition(
  facts: Pick<ReachAccessFacts, 'workspaces' | 'workspaceRootOf' | 'delorunHome' | 'elevationOf' | 'touchUnlock' | 'logElevated' | 'liftedSettings' | 'computerOnlySwitches' | 'protectedEntryIds' | 'computerOnlyEntryIds' | 'defaultPermission' | 'dangerousMode' | 'pageUnlockOf' | 'unlockModeEnabled' | 'faceGrants' | 'keyRefs'>,
  principal: ReachDevicePrincipal,
): ReachCondition {
  const { deviceId, listener, unlockId } = principal
  /**
   * The running unlock this principal's Peer holds: its page's under PIN mode, otherwise the device's.
   * @returns the unlock's id, or undefined.
   */
  const unlock = (): { readonly id: string; readonly grace?: true } | undefined => unlockId === undefined ? facts.elevationOf(deviceId, listener) : facts.pageUnlockOf(unlockId)
  /**
   * Refuse without an unlock on the principal's listener, and log an admitted call. An action of
   * {@link GRACE_REFUSED_ACTIONS} is admitted by a grant alone, never by an unlock.
   * @param action - the action.
   * @param reason - the refusal.
   * @param call - whether a call's arguments came with the question.
   * @param scope - {@link scopeOf} of the resource the question names.
   * @param args - the arguments.
   * @param row - the `AUTH_CLASSES` row the call is decided under, which says whether a Face ID pass may admit it; `remote:<action>` by default.
   * @returns the refusal, or undefined when an unlock admits it.
   */
  const unlocked = (action: RemoteAccessAction, reason: string, call: boolean, scope: string, args?: unknown, row = `remote:${action}`): RemoteAccessDecision | undefined => {
    const faced = facts.faceGrants?.()
    // A face action is admitted by a grant for exactly this call, from Face ID or, on a device with no passkey, from its
    // PIN (A483), or by the device's Face ID pass on this listener when its row allows one (A499); no unlock window, code or approval grace admits it.
    if (faced !== undefined) return grantFor(faced, action, reason, call, scope, args, row)
    // Before the grant store starts, a terminal stays refused and any other action falls back to the unlock the person
    // entered; no unlock exists before the home service starts either, so the fallback admits nothing.
    if (GRACE_REFUSED_ACTIONS.has(action)) return { kind: 'deny', reason }
    const elevation = unlock()
    if (elevation === undefined) return { kind: 'deny', reason }
    if (call) {
      facts.logElevated(`home-auth: elevated action: device=${deviceId} listener=${listener} action=${action} elevation=${elevation.id}`)
      // Renewed below, once the whole condition allows the call.
      if (RENEWING_ACTIONS.has(action)) renew = elevation.id
    }
    return undefined
  }
  let renew: string | undefined
  /** The grants this call uses up, once the whole condition allows it. */
  let spend: (() => void)[] = []
  /**
   * Decide a call by the grant the home keeps for it. A question without arguments is allowed only for a list or a
   * snapshot read of a method, so the studio lists the action; an `event:` action is refused without arguments, because
   * no grant covers an event. A call needs a live hold on the terminal or picker it names, in the resource it names, or a
   * grant for exactly these arguments, which is used up only when the whole decision allows.
   * @param faced - the grant facts.
   * @param action - the action.
   * @param reason - the refusal.
   * @param call - whether a call's arguments came with the question.
   * @param scope - {@link scopeOf} of the resource the question names.
   * @param args - the arguments.
   * @param row - the `AUTH_CLASSES` row of the call: a live Face ID pass of this device on this listener admits it when that row is `face`
   *   and not always-ask, and a call that opens a terminal or picker then opens its hold too, so the terminal outlives the pass under the hold's own limits.
   * @returns the refusal, or undefined when a hold, a pass or a grant admits it.
   */
  const grantFor = (faced: FaceGrantFacts, action: RemoteAccessAction, reason: string, call: boolean, scope: string, args: unknown, row: string): RemoteAccessDecision | undefined => {
    if (!call) return action.startsWith('event:') ? { kind: 'deny', reason } : undefined
    const holder = { deviceId, listener, unlockId }
    const feature = holdFeatureOf(action)
    const id = feature === undefined ? undefined : holdIdOf(feature, action, args)
    if (feature !== undefined && !ALWAYS_GRANTED.has(action) && (id === undefined ? feature === 'picker' && faced.grants.holdsAny(holder, feature, scope) : faced.grants.holdAdmits(holder, feature, id, scope))) return undefined
    const opens = feature !== undefined && id !== undefined && HOLD_OPENERS[action] === feature ? { feature, id, scope } : undefined
    if (faced.passAdmits?.(holder, row) === true) {
      if (opens !== undefined) spend.push(() => { faced.grants.openHoldByPass(holder, opens) })
      return undefined
    }
    const hash = hashArgs(args)
    if (hash === undefined || !faced.grants.has(holder, action, hash)) return { kind: 'deny', reason }
    spend.push(() => { faced.grants.consume(holder, action, hash, opens) })
    return undefined
  }
  const decide: ReachCondition = ({ action, resource, args }) => {
    const scope = scopeOf(resource)
    // A call (a question with arguments) is the device's use: it keeps its Face ID pass from the idle end, never past its end.
    if (args !== undefined) facts.faceGrants?.()?.grants.touchPass({ deviceId, listener })
    // Dangerous mode lifts the four refusals below: each call still needs its grant, and the check follows. The mode is
    // read per call, so withdrawing the grant restores them. A PIN page unlock lifts nothing (A483: never a window).
    const lifts: SettingsLift[] = []
    if (args !== undefined) {
      const lifted = facts.dangerousMode()
      // A computer-only switch stays on, new chats' permission stays as loose as it is, a protected row stays as it is,
      // and a command a device does not run stays unrun, so no unlock admits any of them. The mode lifts a switch only
      // when DANGEROUS_LIFTABLE_SWITCHES lists it: the remote-access settings stay at the computer.
      if (SETTINGS_WRITES.has(action)) {
        const off = facts.computerOnlySwitches().find(target => !(lifted && DANGEROUS_LIFTABLE_SWITCHES.has(target.ns) && target.ranked === undefined) && turnsSwitchOff(action, args, target))
        if (off !== undefined) return { kind: 'deny', reason: off.ranked === undefined ? switchOffRefusal(off.label, off.safeValue) : `loopback-required: loosening ${off.label}` }
        // The settings of the gate, reach and sandbox rows stay as the computer set them: a write there replaces the row in effect.
        if (settingsOfComputerOnlyRow(facts, args)) return { kind: 'deny', reason: PROTECTED_ROW_REFUSAL }
        // The approval grace never covers a consent or guard row's settings, and no grant lifts this refusal: the write
        // waits until the grace ends, when it takes Face ID or the PIN like any other.
        if (unlockId === undefined && facts.elevationOf(deviceId, listener)?.grace === true && settingsOfProtectedRow(facts, args)) return { kind: 'deny', reason: GRACE_PROTECTED_ROW_REFUSAL }
        const loosens = loosensDefaultPermission(action, args, facts.defaultPermission())
        if (!lifted && loosens) return { kind: 'deny', reason: DEFAULT_PERMISSION_REFUSAL }
        if (lifted) lifts.push(...liftsOf(facts, action, args, loosens))
      }
      // The rows that carry the unlock gate and the sandbox stay refused to every device: no unlock and no mode lifts them.
      if (ROW_CALLS.has(action) && namesComputerOnlyRow(facts, args)) return { kind: 'deny', reason: PROTECTED_ROW_REFUSAL }
      if (BUNDLE_CALLS.has(action) && namesComputerOnlyBundle(args)) return { kind: 'deny', reason: PROTECTED_ROW_REFUSAL }
      if (!lifted) {
        if (ROW_CALLS.has(action) && namesProtectedRow(facts, args)) return { kind: 'deny', reason: PROTECTED_ROW_REFUSAL }
        if (action === 'commands/execute' && !runsDeviceCommand(args)) return { kind: 'deny', reason: UNLISTED_COMMAND_REFUSAL }
      }
    }
    if (DANGEROUS_SET.has(action)) {
      if (!facts.dangerousMode()) return { kind: 'deny', reason: `loopback-required: ${action}` }
      const refused = unlocked(action, `elevation-required: ${action}`, args !== undefined, scope, args)
      if (refused !== undefined) return refused
    }
    if (KEY_SET.has(action) && facts.unlockModeEnabled()) {
      const faced = facts.faceGrants?.()
      if (faced !== undefined) {
        // Saving or removing a key needs a grant for this call, whatever the page's PIN unlock says (A483: never a
        // window); presence and its events stay free.
        const refused = FACE_KEY_ACTIONS.has(action) ? grantFor(faced, action, `elevation-required: ${action}`, args !== undefined, scope, args, `remote:${action}`) : undefined
        if (refused !== undefined) return refused
      } else {
        // Before the grant store starts, no grant can admit a key action.
        return { kind: 'deny', reason: `elevation-required: ${action}` }
      }
    }
    if (KEY_SET.has(action) && args !== undefined && !namesOnlyDeclaredRefs(action, args, facts.keyRefs())) return { kind: 'deny', reason: UNDECLARED_KEY_REFUSAL }
    if (ELEVATED_SET.has(action) && !(args !== undefined && isEverydayCall(action, args))) {
      const refused = unlocked(action, `elevation-required: ${action}`, args !== undefined, scope, args)
      if (refused !== undefined) return refused
    }
    // The write proceeds once the grant admitted it, so the mode's end can set the field back.
    if (lifts.length > 0) {
      const unrecorded = facts.liftedSettings(lifts)
      if (unrecorded !== undefined) return { kind: 'deny', reason: unrecorded }
    }
    if (args === undefined) return ALLOW
    if (action === 'session/create') {
      if (createsInKnownWorkspace(facts, args)) return ALLOW
      return unlocked(action, CREATE_OUTSIDE_WORKSPACES, true, scope, args, 'remote:session/create outside the known workspaces') ?? ALLOW
    }
    if (WORKSPACE_PATH_ACTIONS.has(action)) {
      const bounds = boundsOf(facts, resource)
      if (bounds !== undefined && workspacePathsReachable(bounds, args)) return ALLOW
      const outside = `loopback-required: ${action} with a path outside the chat's workspace`
      // Dangerous mode moves the workspace bound for a call with its grant; the Delorun home stays out of reach.
      if (bounds !== undefined && facts.dangerousMode() && workspacePathsReachable({ ...bounds, confined: false }, args)) {
        return unlocked(action, outside, true, scope, args, 'remote:workspaceFiles/* outside the workspace') ?? ALLOW
      }
      return { kind: 'deny', reason: outside }
    }
    return ALLOW
  }
  return (question) => {
    renew = undefined
    spend = []
    const decision = decide(question)
    // An unlock is renewed by a state-changing call that was allowed, never by a read or a call refused after the unlock check.
    if (decision.kind === 'allow' && renew !== undefined) facts.touchUnlock?.(renew)
    // A grant is used up only once the whole decision allows, so a call refused later keeps it.
    if (decision.kind === 'allow') for (const use of spend) use()
    return decision
  }
}

const GLOBAL_ROLE = role('global')
const WORKSPACE_ROLE = role('workspace')
const SESSION_ROLE = role('session')

/** What the policy reads of the grants for Face ID. */
export interface FaceGrantFacts {
  /** The grants and holds a verified assertion or a correct PIN minted. */
  readonly grants: Pick<GrantStore, 'has' | 'consume' | 'holdAdmits' | 'holdsAny' | 'openHoldByPass' | 'touchPass'>
  /**
   * Whether the live Face ID pass of this device on this listener admits a call decided under one `AUTH_CLASSES` row (`passAdmitsRow` in
   * `./auth-classes.ts`, which this module cannot import: that table is built from this module's tables). Absent, no
   * pass admits anything.
   * @param holder - the device, listener and page unlock of the call.
   * @param row - the row's id.
   * @returns whether the pass admits the call.
   */
  readonly passAdmits?: (holder: GrantHolder, row: string) => boolean
  /**
   * Whether a device holds a passkey; such a device is admitted by a grant and never by an unlock window.
   * @param deviceId - the device.
   * @returns whether it does.
   */
  readonly deviceHasPasskey: (deviceId: string) => boolean
}

/** The model key actions a grant covers; the others of {@link REACH_KEY_ACTIONS} read presence and stay free. */
const FACE_KEY_ACTIONS: ReadonlySet<string> = new Set(['credentials/set', 'credentials/unset'])

/** The actions a hold never admits: a terminal is created, and a folder made, only with a grant for that call. */
const ALWAYS_GRANTED: ReadonlySet<string> = new Set(['terminal/create', 'directoryPicker/createDirectory'])


/** The id every `directoryPicker/*` hold carries: the picker has no id of its own, so one device holds one. */
export const PICKER_HOLD_ID = 'directoryPicker'

/**
 * The terminal or picker a call names, which a hold is bound to. `terminal/create` takes its wire arguments as
 * `{ request: { id, … } }`; the other terminal calls name `{ id }`.
 * @param feature - the hold's feature.
 * @param action - the action.
 * @param args - the call's arguments.
 * @returns the id, or undefined for a call that names none, such as listing the terminals.
 */
function holdIdOf(feature: HoldFeature, action: string, args: unknown): string | undefined {
  if (feature === 'picker') return PICKER_HOLD_ID
  const named = action === 'terminal/create' ? (typeof args === 'object' && args !== null && 'request' in args ? args.request : undefined) : args
  if (typeof named === 'object' && named !== null && 'id' in named && typeof named.id === 'string' && named.id !== '') return named.id
  return undefined
}

/** Host state the policy reads, all synchronous and in memory. */
export interface ReachAccessFacts {
  /**
   * Whether a reach listener holds a live Peer for one device; a removed device holds none.
   * @param deviceId - the device.
   * @param listener - the reach listener.
   * @returns whether that listener does.
   */
  readonly admitted: (deviceId: string, listener: ReachListenerId) => boolean
  /**
   * The Workspaces of the Host with their folders and Sessions, empty while no Workspace registry is active.
   * @returns the Workspaces in registry order.
   */
  readonly workspaces: () => readonly Pick<Workspace, 'id' | 'path' | 'sessionIds'>[]
  /**
   * The Sessions live in the Host, empty while no Session store is active.
   * @returns their ids.
   */
  readonly liveSessions: () => readonly SessionId[]
  /**
   * The workspace root of one Session: its Workspace's path, or a live Session's working directory.
   * @param sessionId - the Session.
   * @returns the root, or undefined when the Host cannot name it synchronously.
   */
  readonly workspaceRootOf: (sessionId: SessionId) => string | undefined
  /** The Delorun home, which holds the home's secrets and tokens; no device read reaches a path inside it. */
  readonly delorunHome: string
  /**
   * The running unlock of one device on one listener of this profile's home, read before each elevated action.
   * @param deviceId - the device.
   * @param listener - the listener its Peer sits on.
   * @returns its id, or undefined.
   */
  readonly elevationOf: (deviceId: string, listener: ReachListenerId) => { readonly id: string; readonly grace?: true } | undefined
  /**
   * Renew an unlock after a call that needed it; reads and questions without arguments never call it.
   * @param elevationId - the id of the unlock the call ran under.
   */
  readonly touchUnlock?: (elevationId: string) => void
  /**
   * The running PIN mode page unlock one Peer was admitted under.
   * @param unlockId - the id in the Peer's principal.
   * @returns the unlock, or undefined once it ended.
   */
  readonly pageUnlockOf: (unlockId: string) => { readonly id: string } | undefined
  /**
   * Whether a locked device is refused where an unlock matters, which makes the model key actions
   * ({@link REACH_KEY_ACTIONS}) need a grant: a PIN is set or a passkey is enrolled.
   * @returns whether it is.
   */
  readonly unlockModeEnabled: () => boolean
  /**
   * The grant store; undefined before the service starts, when elevated actions keep the unlock check.
   * @returns the store, or undefined.
   */
  readonly faceGrants?: () => FaceGrantFacts | undefined
  /**
   * The credential references the model providers declare, read when a key action arrives: each provider's conventional
   * key reference, the environment variables its authentication reads and the `apiKeyEnv` its profile names. A key action
   * of a device may name no other reference.
   * @returns the references.
   */
  readonly keyRefs: () => ReadonlySet<string>
  /**
   * Record one line in the operational log, for each call an unlock admits.
   * @param line - the line.
   */
  readonly logElevated: (line: string) => void
  /**
   * Record the settings a device is about to loosen while dangerous mode holds, so the mode's end sets them back.
   * Called after the unlock admitted the call and before it proceeds; the record is saved to disk before it returns.
   * @param lifts - the fields and the values the call sets.
   * @returns undefined once recorded, or the refusal reason when the record could not be saved, which refuses the write.
   */
  readonly liftedSettings: (lifts: readonly SettingsLift[]) => string | undefined
  /**
   * The computer-only switches the mounted plugins registered.
   * @returns the switches.
   */
  readonly computerOnlySwitches: () => readonly ComputerOnlySwitch[]
  /**
   * The Loader entry ids of the rows whose module the `plugin-manager` row's `protectedPlugins` names.
   * @returns the ids, or undefined when the list cannot be read.
   */
  readonly protectedEntryIds: () => ReadonlySet<string> | undefined
  /**
   * The Loader entry ids of the rows whose module is in {@link COMPUTER_ONLY_ROW_MODULES}.
   * @returns the ids, or undefined when they cannot be read.
   */
  readonly computerOnlyEntryIds: () => ReadonlySet<string> | undefined
  /**
   * The permission new chats start in, which a device's settings write may tighten but not loosen.
   * @returns it, or undefined while no permission presets run.
   */
  readonly defaultPermission: () => DefaultPermission | undefined
  /**
   * Whether dangerous mode holds: the computer-only refusals of a settings write, a protected plugin row, an unlisted
   * command, the {@link REACH_DANGEROUS_ACTIONS} and a workspace-file path outside the chat's workspace are lifted for a
   * device that holds an unlock. Approving a device and signing in stay at the computer.
   * @returns whether it holds; false without a permission-defaults service or while its store cannot be read.
   */
  readonly dangerousMode: () => boolean
}

/**
 * The reason an allowed or elevated action was refused on a resource the policy could not name, or the refusal of
 * every other action. An elevated action on a resource the policy names is decided by the condition instead.
 * @param action - the refused action.
 * @returns `resource-unlisted: <action>` for an allowed or elevated action, otherwise `loopback-required: <action>`.
 */
export function reachRefusal(action: RemoteAccessAction): string {
  return ALLOWED_SET.has(action) || ELEVATED_SET.has(action) ? `resource-unlisted: ${action}` : `loopback-required: ${action}`
}

/**
 * Build the `reach-device` policy. A device a reach listener admits holds the allowed and elevated actions on the global
 * resource, on every Workspace and on every Session the facts name: a Session of a Workspace or a live one. It holds
 * nothing on a listener that holds no Peer for it.
 * @param facts - the Host state the policy reads.
 * @returns the policy the authenticator registers for {@link REACH_DEVICE}.
 */
export function createReachAccessPolicy(facts: ReachAccessFacts): RemoteAccessPolicy<ReachDevicePrincipal> {
  return {
    bindings(device): readonly RemoteAccessBinding[] {
      if (!facts.admitted(device.deviceId, device.listener)) return []
      const condition = createCondition(facts, device)
      const bindings: RemoteAccessBinding[] = [{ role: GLOBAL_ROLE, resource: { kind: 'global' }, condition }]
      const sessions = new Set<SessionId>()
      for (const workspace of facts.workspaces()) {
        bindings.push({ role: WORKSPACE_ROLE, resource: { kind: 'workspace', id: workspace.id }, condition })
        for (const id of workspace.sessionIds) sessions.add(id)
      }
      for (const id of facts.liveSessions()) sessions.add(id)
      // The condition sits on every role: a workspace-file read names a Session, and the reads are bound there.
      for (const id of sessions) bindings.push({ role: SESSION_ROLE, resource: { kind: 'session', id }, condition })
      return bindings
    },
    explain: request => reachRefusal(request.action),
  }
}
