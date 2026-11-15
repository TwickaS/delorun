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
import type { ReachListenerId } from '@delorun/contract-admission'
import type { SettingsLift } from './dangerous-settings.ts'

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
 * owner's rule for a phone (A297): an approved device is the person, and it can already prompt the agent, so every
 * action no riskier than a prompt is allowed. That covers reading chats, workspaces, the redacted settings, the plugins
 * and the files of a chat's own workspace; starting a chat in a known workspace with any preset; replying, stopping a
 * run and answering ordinary prompts; organizing chats and workspaces, the trash included; goals, scheduled follow-ups,
 * the model, and feedback. A read is listed here only when it reaches no secret and no path outside a chat's workspace.
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
 * The actions of {@link REACH_DENIED_ACTIONS} that dangerous mode lifts for a device that holds an unlock: the role
 * lists them, and the condition refuses them with `loopback-required: <action>` while the mode is off and with
 * `elevation-required: <action>` to a locked device while it holds. Each other action of the never table stays at the
 * computer in every mode.
 */
export const REACH_DANGEROUS_ACTIONS = {
  'session/openWorkspacePath': 'open a chat\'s folder in an application on the home\'s computer',
  'session/workspacePathApplications': 'list the applications on the home\'s computer that open a chat\'s folder',
} as const satisfies Partial<Readonly<Record<keyof typeof REACH_DENIED_ACTIONS, string>>>
const DANGEROUS_SET: ReadonlySet<string> = new Set(Object.keys(REACH_DANGEROUS_ACTIONS))

/**
 * The actions that add, remove and check a model provider's key from an approved device (A380). Each is allowed to a
 * device without an unlock and, while PIN mode is on, only to a Peer of an unlocked page; a locked page's Peer is refused
 * with `elevation-required: <action>`. A stored key is never sent to a device: `credentials/describe` answers presence
 * and writability only, and the events name the key, never its value.
 */
export const REACH_KEY_ACTIONS = {
  'credentials/describe': 'read whether a provider key is saved, never its value (A380)',
  'credentials/set': 'save or change a provider key, which the device never reads back (A380)',
  'credentials/unset': 'remove a saved provider key (A380)',
  'event:credentials/record-updated': 'follow a change to a saved credential record, naming its key and never its value (A380)',
  'event:credentials/reference-updated': 'follow a change to a saved provider key, naming it and never its value (A380)',
} as const satisfies Partial<Readonly<Record<RemoteAccessAction, string>>>
const KEY_SET: ReadonlySet<string> = new Set(Object.keys(REACH_KEY_ACTIONS))

/**
 * The settings namespaces an approved device writes without an unlock (A381): the everyday settings the computer's
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
} as const satisfies Readonly<Record<string, string>>

/**
 * The plugin rows of Delorun's own profile an approved device turns on or off through `pluginManager/setPluginEnabled`
 * without an unlock (A381), by row id: the optional rows onboarding offers. The plugin manager still refuses a
 * protected row (see {@link PROTECTED_ROW_REFUSAL}).
 */
export const REACH_SHIPPED_ROWS = {
  'delorun-thinking-rsvp': 'the Thinking tab',
  'delorun-cost-meter': 'the cost meter',
} as const satisfies Readonly<Record<string, string>>

/**
 * The installed packages an approved device turns on or off through `pluginManager/setBundleEnabled` without an
 * unlock (A381), by package name: the plugins onboarding recommends. Installing a package that is not on the
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
  if (SETTINGS_WRITES.has(action)) return typeof args.ns === 'string' && Object.hasOwn(REACH_EVERYDAY_SETTINGS, args.ns)
  if (action === 'pluginManager/setPluginEnabled') return typeof args.id === 'string' && Object.hasOwn(REACH_SHIPPED_ROWS, args.id)
  if (action === 'pluginManager/setBundleEnabled') return typeof args.name === 'string' && Object.hasOwn(REACH_SHIPPED_BUNDLES, args.name)
  return false
}

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
  'terminal/environment': TERMINAL,
  'terminal/list': TERMINAL,
  'terminal/rename': TERMINAL,
  'terminal/retain': TERMINAL,
  'terminal/shells': TERMINAL,
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
 * A boolean setting only the home's own computer turns off, such as the external-agent consent (A299): a device's
 * settings write to its namespace is refused, unlocked or not, unless it leaves the field a literal `true`. The plugin
 * that owns the field registers it with `HomeAuthService.registerComputerOnlySwitch` while it is mounted.
 */
export interface ComputerOnlySwitch {
  /** The settings namespace, the id of the plugin's profile row. */
  readonly ns: string
  /** The boolean field of the row's configuration, or {@link EVERY_FIELD} to refuse every settings write to the namespace. */
  readonly field: string
  /** What the field turns on, as the refusal names it, such as `the external-agent consent`. */
  readonly label: string
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
 * The reason a settings write that would turn a computer-only switch off is refused to a device, unlocked or not.
 * @param label - the switch's {@link ComputerOnlySwitch.label}.
 * @returns `loopback-required: turning <label> off`.
 */
export function switchOffRefusal(label: string): string {
  return `loopback-required: turning ${label} off`
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
 * Whether one `settings/mutate` operation leaves a switch's field on: an operation on another field, or a `set` that
 * writes a literal `true` to it, directly or in the whole section.
 * @param field - the switch's field.
 * @param op - the operation, as the call sent it.
 * @returns whether it keeps the switch on.
 */
function opKeepsSwitch(field: string, op: unknown): boolean {
  if (!isObject(op) || !Array.isArray(op.path)) return false
  const [head, ...rest] = op.path as unknown[]
  if (head === undefined) return op.op === 'set' && isObject(op.value) && op.value[field] === true
  if (head !== field) return true
  return rest.length === 0 && op.op === 'set' && op.value === true
}

/**
 * Whether a settings write could turn a computer-only switch off. A write to another namespace never does; a write to
 * its namespace does unless its arguments name the field only as a literal `true`, and a `replace`, which rebuilds the
 * section, must name it so. Arguments the condition cannot read count as turning it off.
 * @param action - the settings write.
 * @param args - the call's arguments.
 * @param target - the switch.
 * @returns whether the write is refused to a device.
 */
function turnsSwitchOff(action: RemoteAccessAction, args: Readonly<Record<string, unknown>>, target: ComputerOnlySwitch): boolean {
  if (args.ns !== target.ns) return false
  const { field } = target
  if (field === EVERY_FIELD) return true
  switch (action) {
    case 'settings/mutate':
      return !Array.isArray(args.ops) || !args.ops.every(op => opKeepsSwitch(field, op))
    case 'settings/update':
      return !isObject(args.patch) || (field in args.patch && args.patch[field] !== true)
    default:
      // `settings/replace`, the only other member of SETTINGS_WRITES.
      return !isObject(args.section) || args.section[field] !== true
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
  const switches = facts.computerOnlySwitches().filter(target => DANGEROUS_LIFTABLE_SWITCHES.has(target.ns) && turnsSwitchOff(action, args, target))
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
 * call an unlock admits with the unlock's id. Every `terminal/*` action needs an unlock, always: no switch, workspace grant or
 * dangerous mode waives it (A345).
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
  facts: Pick<ReachAccessFacts, 'workspaces' | 'workspaceRootOf' | 'delorunHome' | 'elevationOf' | 'logElevated' | 'liftedSettings' | 'computerOnlySwitches' | 'protectedEntryIds' | 'defaultPermission' | 'dangerousMode' | 'pageUnlockOf' | 'pinEnabled' | 'pinLiftedSettings'>,
  principal: ReachDevicePrincipal,
): ReachCondition {
  const { deviceId, listener, unlockId } = principal
  /**
   * The running unlock this principal's Peer holds: its page's under PIN mode, otherwise the device's.
   * @returns the unlock's id, or undefined.
   */
  const unlock = (): { readonly id: string } | undefined => unlockId === undefined ? facts.elevationOf(deviceId, listener) : facts.pageUnlockOf(unlockId)
  /**
   * Refuse without an unlock on the principal's listener, and log an admitted call.
   * @param action - the action.
   * @param reason - the refusal.
   * @param call - whether a call's arguments came with the question.
   * @returns the refusal, or undefined when an unlock admits it.
   */
  const unlocked = (action: RemoteAccessAction, reason: string, call: boolean): RemoteAccessDecision | undefined => {
    const elevation = unlock()
    if (elevation === undefined) return { kind: 'deny', reason }
    if (call) facts.logElevated(`home-auth: elevated action: device=${deviceId} listener=${listener} action=${action} elevation=${elevation.id}`)
    return undefined
  }
  return ({ action, resource, args }) => {
    // Dangerous mode lifts the four refusals below for an unlocked device: an elevated action is still refused to a
    // locked one, and the unlock check follows. The mode is read per call, so withdrawing the grant restores them.
    const lifts: SettingsLift[] = []
    // An unlocked PIN page lifts the same refusals as dangerous mode. Its settings writes are recorded in the PIN
    // file when dangerous mode does not hold, and set back when PIN mode turns off.
    const pageUnlocked = unlockId !== undefined && facts.pageUnlockOf(unlockId) !== undefined
    if (args !== undefined) {
      const dangerous = facts.dangerousMode()
      const lifted = dangerous || pageUnlocked
      // A computer-only switch stays on, new chats' permission stays as loose as it is, a protected row stays as it is,
      // and a command a device does not run stays unrun, so no unlock admits any of them. The mode lifts a switch only
      // when DANGEROUS_LIFTABLE_SWITCHES lists it: the remote-access settings stay at the computer.
      if (SETTINGS_WRITES.has(action)) {
        const off = facts.computerOnlySwitches().find(target => !(lifted && DANGEROUS_LIFTABLE_SWITCHES.has(target.ns)) && turnsSwitchOff(action, args, target))
        if (off !== undefined) return { kind: 'deny', reason: switchOffRefusal(off.label) }
        const loosens = loosensDefaultPermission(action, args, facts.defaultPermission())
        if (!lifted && loosens) return { kind: 'deny', reason: DEFAULT_PERMISSION_REFUSAL }
        if (lifted) lifts.push(...liftsOf(facts, action, args, loosens))
      }
      if (!lifted) {
        if (ROW_CALLS.has(action) && namesProtectedRow(facts, args)) return { kind: 'deny', reason: PROTECTED_ROW_REFUSAL }
        if (action === 'commands/execute' && !runsDeviceCommand(args)) return { kind: 'deny', reason: UNLISTED_COMMAND_REFUSAL }
      }
    }
    if (DANGEROUS_SET.has(action)) {
      if (!facts.dangerousMode() && !pageUnlocked) return { kind: 'deny', reason: `loopback-required: ${action}` }
      const refused = unlocked(action, `elevation-required: ${action}`, args !== undefined)
      if (refused !== undefined) return refused
    }
    if (KEY_SET.has(action) && facts.pinEnabled() && !pageUnlocked) return { kind: 'deny', reason: `elevation-required: ${action}` }
    if (ELEVATED_SET.has(action) && !(args !== undefined && isEverydayCall(action, args))) {
      const refused = unlocked(action, `elevation-required: ${action}`, args !== undefined)
      if (refused !== undefined) return refused
    }
    // The write proceeds once the unlock admitted it, so the mode's end can set the field back.
    if (lifts.length > 0) {
      const unrecorded = facts.dangerousMode() ? facts.liftedSettings(lifts) : facts.pinLiftedSettings(lifts)
      if (unrecorded !== undefined) return { kind: 'deny', reason: unrecorded }
    }
    if (args === undefined) return ALLOW
    if (action === 'session/create') {
      if (createsInKnownWorkspace(facts, args)) return ALLOW
      return unlocked(action, CREATE_OUTSIDE_WORKSPACES, true) ?? ALLOW
    }
    if (WORKSPACE_PATH_ACTIONS.has(action)) {
      const bounds = boundsOf(facts, resource)
      if (bounds !== undefined && workspacePathsReachable(bounds, args)) return ALLOW
      const outside = `loopback-required: ${action} with a path outside the chat's workspace`
      // Dangerous mode moves the workspace bound for an unlocked device; the Delorun home stays out of reach.
      if (bounds !== undefined && (facts.dangerousMode() || pageUnlocked) && workspacePathsReachable({ ...bounds, confined: false }, args)) {
        return unlocked(action, outside, true) ?? ALLOW
      }
      return { kind: 'deny', reason: outside }
    }
    return ALLOW
  }
}

const GLOBAL_ROLE = role('global')
const WORKSPACE_ROLE = role('workspace')
const SESSION_ROLE = role('session')

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
  readonly elevationOf: (deviceId: string, listener: ReachListenerId) => { readonly id: string } | undefined
  /**
   * The running PIN mode page unlock one Peer was admitted under.
   * @param unlockId - the id in the Peer's principal.
   * @returns the unlock, or undefined once it ended.
   */
  readonly pageUnlockOf: (unlockId: string) => { readonly id: string } | undefined
  /**
   * Whether PIN mode is on, which makes the model key actions ({@link REACH_KEY_ACTIONS}) need an unlocked page.
   * @returns whether it is.
   */
  readonly pinEnabled: () => boolean
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
   * Record the settings an unlocked PIN page is about to loosen, so PIN mode turning off sets them back. Called under the
   * same conditions as {@link liftedSettings}, when dangerous mode does not hold.
   * @param lifts - the fields and the values the call sets.
   * @returns undefined once recorded, or the refusal reason when the record could not be saved, which refuses the write.
   */
  readonly pinLiftedSettings: (lifts: readonly SettingsLift[]) => string | undefined
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
