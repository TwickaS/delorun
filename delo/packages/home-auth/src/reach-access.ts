/**
 * What a device the home approved may do over a reach listener (C14): its caller identity, the actions the owner's
 * rule permits a phone, the actions it refuses with the reason, and the remote access policy that applies them.
 *
 * Every Peer a reach listener admits speaks for a `reach-device` principal, never for the owner, so upstream's Gateway
 * asks this policy before it dispatches a call or forwards an event to it. The policy refuses by default: it binds only
 * the actions of {@link REACH_ALLOWED_ACTIONS}, on the global resource, on every Workspace and on every Session the
 * Host can name synchronously. Any other action, an action of {@link REACH_DENIED_ACTIONS} or one neither table names,
 * is refused with the reason `loopback-required: <action>`: the person takes it at the home's own computer. An allowed
 * action on a Session or Workspace the policy cannot name is refused with `resource-unlisted: <action>`.
 *
 * The two tables name every Remote method and every forwarded event of Delo's default profile; the reach access
 * denial suite fails on a method or event neither names, and on an entry that names none.
 *
 * @module @delo/home-auth/reach-access
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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** One device the home approved, calling over a reach listener. */
    'reach-device': ReachDevicePrincipal
  }
}

/** The principal kind of every Peer a reach listener admits. */
export const REACH_DEVICE = 'reach-device'

/**
 * One device the home approved, as the Peers of its reach sessions speak for it. Session logs record it as the source
 * of the device's prompts, so it carries the device id alone: no credential, label or address.
 */
export interface ReachDevicePrincipal {
  readonly kind: typeof REACH_DEVICE
  /** The device's id in the home's device list. */
  readonly deviceId: string
}

/**
 * The principal of one device.
 * @param deviceId - the device's id in the home's device list.
 * @returns the principal its Peers speak for.
 */
export function reachDevicePrincipal(deviceId: string): ReachDevicePrincipal {
  return { kind: REACH_DEVICE, deviceId }
}

/**
 * Every action a device may take over a reach listener, with what it lets the person do from it. The owner's rule
 * for a phone: read chats, workspaces, the redacted settings, the plugins and the files of a chat's own workspace,
 * start chats, send messages, stop runs, answer ordinary prompts, choose the preset a chat runs with, and rename,
 * pin and unpin chats, which organize the list reversibly and change no run. A read is listed here only when it
 * reaches no secret and no path outside a chat's workspace.
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
  'session/canOpenWorkspacePath': 'read whether the home can open a folder; opening one is refused',
  'session/create': 'start a chat in an existing workspace with the configured preset; a folder or a preset in the request is refused',
  'session/fork': 'start a chat from a point of another',
  'session/prompt': 'send a message',
  'session/updateQueue': 'edit or withdraw a message still waiting in a chat\'s queue',
  'session/cancel': 'stop a run',
  'session/rename': 'rename a chat, which changes no run',
  'fileUploads/upload': 'attach a file to a message',
  'commands/list': 'read the slash commands the composer offers; running one is refused',
  'skills/list': 'read the skills a chat can use',
  'goals/get': 'read a chat\'s goal',
  'toolResults/watch': 'read the tool results a chat shows',
  'sessionReferenceResolver/candidates': 'read the chats the composer can mention',
  'userQuestions/answer': 'answer a question the agent asked',
  'userQuestions/attachWait': 'hold a question open while answering it',
  'subagents/prompt': 'send a message to a chat\'s subagent',
  'subagents/interruptByParent': 'stop a subagent\'s run',
  'agentPresets/list': 'read the agent presets a chat can start with',
  'agentPresets/read': 'read one agent preset',
  'agentPresets/select': 'choose which of the presets you defined at your computer a chat that has not started runs with, which decides its plugins and tools; choosing one grants no access by itself, so the workspace\'s full-access consent and every approval prompt still decide what that chat may do',
  'permissionPresets/catalog': 'read the permission presets; changing one is refused',
  'workspaceFiles/list': 'list one folder inside a chat\'s workspace, which the service confines to that workspace and caps at 2000 entries',
  'workspaceFiles/read': 'read one page of a text file inside a chat\'s workspace; an absolute path or one that leaves the workspace is refused',
  'workspaceFiles/readBytes': 'read a file\'s bytes inside a chat\'s workspace within the service\'s window and size caps; an absolute path or one that leaves the workspace is refused',
  'workspaceFiles/stat': 'read a file\'s identity, version and size inside a chat\'s workspace; an absolute path or one that leaves the workspace is refused',
  'officeToPdf/render': 'render a document inside a chat\'s workspace as a PDF preview, which reads it through the same workspace-file rule',
  'officeToPdf/generation': 'read which rendering configuration the PDF previews are cached against',
  'fileReferences/list': 'search the file names of a chat\'s workspace for the composer\'s mention list',
  'pluginManager/history': 'read the profile changes that can be undone; undoing or restoring one is refused',
  'pluginManager/inspect': 'read what a plugin package contains before it is installed; installing it is refused',
  'pluginManager/listBundles': 'read the installed bundles; changing one is refused',
  'pluginManager/listPlugins': 'read the installed plugins; enabling, disabling or removing one is refused',
  'pluginManager/listVersionExemptions': 'read the pinned plugin versions; changing one is refused',
  'pluginManager/listVersions': 'read a plugin package\'s published versions; installing one is refused',
  'pluginManager/readBundleDetail': 'read an installed bundle\'s files; changing it is refused',
  'pluginManager/registries': 'read which plugin registries are configured',
  'pluginManager/waitForInstall': 'wait on an install your computer started; starting one is refused',
  'pluginInventory/list': 'read the plugins and presets the Host composed',
  'pluginRegistryProbe/fastest': 'measure which configured plugin registry answers fastest',
  'llm/listProviders': 'read the model providers; their credentials are refused',
  'llm/listConfigurableProviders': 'read the model providers; their credentials are refused',
  'job/list': 'read a chat\'s background jobs',
  'job/follow': 'follow a chat\'s background job',
  'job/kill': 'stop a background job, as stopping a run',
  'schedule/catalog': 'read the scheduled follow-ups; creating or editing one is refused',
  'schedule/list': 'read the scheduled follow-ups',
  'schedule/view': 'read one scheduled follow-up',
  'schedule/history': 'read a scheduled follow-up\'s runs',
  'schedule/deliveryLimits': 'read the delivery limits of scheduled follow-ups',
  'workspace/follow': 'read the workspaces and their chats',
  'workspace/pinSession': 'pin a chat to the top of the list, which changes no run',
  'workspace/unpinSession': 'unpin a chat, which changes no run',
  'settings/describe': 'read the settings with every secret redacted, which the studio renders from',
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
  'event:plugin-manager/changed': 'refresh the plugin list after a change made at the computer',
  'event:plugin-market/changed': 'refresh the plugin market after a change made at the computer',
  'event:settings/document-updated': 'refresh the redacted settings',
  'event:schedule/changed': 'refresh the scheduled follow-ups',
} as const satisfies Readonly<Record<RemoteAccessAction, string>>

const PLUGIN_MANAGEMENT = 'plugin management installs, enables or removes code that runs in the Host outside any sandbox'
const PROFILE_HISTORY = 'profile history undo and restore can turn a guard plugin off'
const SETTINGS_WRITE = 'a settings write changes the Host\'s configuration; no settings namespace is writable from a device'
const CREDENTIALS = 'credentials are secrets of the home'
const ACCOUNT = 'account sign-in is off in Delo, and an account change belongs to the home\'s own computer'
const TERMINAL = 'a terminal is a shell on the home\'s computer outside the sandbox'
const DIRECTORY_PICKER = 'the directory picker browses and creates folders on the home\'s computer'
const WORKSPACE_MANAGEMENT = 'workspace management registers or removes folders of the home\'s computer'
const OPEN_ON_COMPUTER = 'opens an application on the home\'s computer'
const DYNAMIC_PLUGIN = 'runs model-authored plugin code in the Host'
const FEEDBACK = 'feedback leaves the home, and Delo turns it off'

/**
 * Every action a device never takes over a reach listener, elevated or not, with why it belongs to the home's own
 * computer: each reaches the home's credentials or account, its device list, or code that runs outside the sandbox.
 * The refusal names the action; this table tells a deliberate refusal from an action nobody classified.
 */
export const REACH_DENIED_ACTIONS = {
  'pluginManager/cancelInstall': PLUGIN_MANAGEMENT,
  'pluginManager/installBundle': PLUGIN_MANAGEMENT,
  'pluginManager/removeBundle': PLUGIN_MANAGEMENT,
  'pluginManager/restore': PROFILE_HISTORY,
  'pluginManager/setBundleEnabled': PLUGIN_MANAGEMENT,
  'pluginManager/setPluginEnabled': PLUGIN_MANAGEMENT,
  'pluginManager/setVersionExemption': PLUGIN_MANAGEMENT,
  'pluginManager/undo': PROFILE_HISTORY,
  'pluginManager/updateBundle': PLUGIN_MANAGEMENT,
  'event:plugin-manager/install-log': PLUGIN_MANAGEMENT,
  'event:plugin-manager/install-state': PLUGIN_MANAGEMENT,
  'event:plugin-manager/update-state': PLUGIN_MANAGEMENT,
  'settings/mutate': SETTINGS_WRITE,
  'settings/replace': SETTINGS_WRITE,
  'settings/update': SETTINGS_WRITE,
  'settings/openSettingsDocument': 'opens the settings document in an editor on the home\'s computer',
  'credentials/describe': CREDENTIALS,
  'credentials/set': CREDENTIALS,
  'credentials/unset': CREDENTIALS,
  'event:credentials/record-updated': CREDENTIALS,
  'event:credentials/reference-updated': CREDENTIALS,
  'llm/discoverModels': 'calls a model provider with the stored credentials',
  'account/ackBonusNotified': ACCOUNT,
  'account/cancelSignIn': ACCOUNT,
  'account/getBalance': ACCOUNT,
  'account/getProfile': ACCOUNT,
  'account/getState': ACCOUNT,
  'account/getUnnotifiedBonuses': ACCOUNT,
  'account/hasRunningAccountTasks': ACCOUNT,
  'account/signOut': ACCOUNT,
  'account/startSignIn': ACCOUNT,
  'account/watch': ACCOUNT,
  'account/watchExpiry': ACCOUNT,
  'event:deepseek-account/session-expired': ACCOUNT,
  'event:deepseek-account/model-sign-in-required': ACCOUNT,
  'terminal/attach': TERMINAL,
  'terminal/close': TERMINAL,
  'terminal/create': TERMINAL,
  'terminal/environment': TERMINAL,
  'terminal/list': TERMINAL,
  'terminal/rename': TERMINAL,
  'terminal/retain': TERMINAL,
  'terminal/shells': TERMINAL,
  'directoryPicker/createDirectory': DIRECTORY_PICKER,
  'directoryPicker/list': DIRECTORY_PICKER,
  'directoryPicker/pick': DIRECTORY_PICKER,
  'workspace/create': WORKSPACE_MANAGEMENT,
  'session/openWorkspacePath': OPEN_ON_COMPUTER,
  'session/workspacePathApplications': OPEN_ON_COMPUTER,
  'commands/execute': 'a slash command can change settings, plugins or the profile',
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
  'sessionFeedback/record': FEEDBACK,
  'messageFeedback/delete': FEEDBACK,
  'messageFeedback/list': FEEDBACK,
  'messageFeedback/put': FEEDBACK,
} as const satisfies Readonly<Record<RemoteAccessAction, string>>

/**
 * Every action a device takes only while it holds an elevation the person approved at the home's own computer (C14,
 * "Elevation"), with what it lets the person do. Each is ordinary work at the computer that reaches no credential, no
 * device approval and no code outside the sandbox; without an elevation it is refused with
 * `elevation-required: <action>`. An action is elevated only by being listed here: a new refused action is never.
 */
export const REACH_ELEVATED_ACTIONS = {
  'workspaceFiles/changes': 'read the Changes surface, the working tree of a chat\'s workspace',
  'workspace/delete': 'move a workspace to the trash, from which the computer restores it',
  'workspace/initializeDefault': 'create the default workspace in its configured folder',
  'workspace/insertBefore': 'reorder the workspaces',
  'workspace/rename': 'rename a workspace',
  'workspace/archiveSession': 'archive a chat',
  'workspace/unarchiveSession': 'restore an archived chat',
  'workspace/insertSessionBefore': 'reorder the chats',
  'session/selectModel': 'choose a chat\'s model and save it as the default',
  'session/initializeDefaultModel': 'save the default model',
  'goals/clear': 'clear a chat\'s goal',
  'goals/complete': 'mark a chat\'s goal done',
  'goals/create': 'set a chat\'s goal',
  'goals/edit': 'edit a chat\'s goal',
  'goals/pause': 'pause a chat\'s goal',
  'goals/resume': 'resume a chat\'s goal',
  'schedule/create': 'schedule a follow-up, which runs its prompt later with the chat\'s own permissions',
  'schedule/edit': 'edit a scheduled follow-up',
  'schedule/run': 'run a scheduled follow-up now',
  'schedule/deleteInactive': 'delete the scheduled follow-ups that no longer run',
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
  if (both.length > 0) throw new TypeError(`@delo/home-auth: reach access lists ${JSON.stringify(both.sort())} in two tables`)
}

assertDisjoint({ allowed: REACH_ALLOWED_ACTIONS, elevated: REACH_ELEVATED_ACTIONS, never: REACH_DENIED_ACTIONS })

/** The allowed actions, which every role of the policy lists. */
const ALLOWED: readonly RemoteAccessAction[] = Object.freeze(Object.keys(REACH_ALLOWED_ACTIONS) as (keyof typeof REACH_ALLOWED_ACTIONS)[])
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED)
const ELEVATED_SET: ReadonlySet<string> = new Set(Object.keys(REACH_ELEVATED_ACTIONS))
/** The actions every role lists: the allowed ones, and the elevated ones, which the condition refuses without one. */
const ROLE_ACTIONS: readonly RemoteAccessAction[] = Object.freeze([...ALLOWED, ...(Object.keys(REACH_ELEVATED_ACTIONS) as (keyof typeof REACH_ELEVATED_ACTIONS)[])])

/**
 * The role over one resource kind.
 * @param resource - the kind.
 * @returns the role listing every allowed and every elevated action.
 */
function role<K extends RemoteAccessResourceKind>(resource: K): RemoteAccessRole<K> {
  return { name: `delo:reach-device-${resource}`, resource, actions: ROLE_ACTIONS }
}

const ALLOW: RemoteAccessDecision = { kind: 'allow' }

/**
 * The actions that read a chat's workspace by a path the device names. The workspace-file service reads an absolute
 * path wherever it points and follows a symbolic link in any directory of a read's path, so the policy resolves each
 * path itself before the service runs: a device reaches a file or folder only when its real path lies inside the real
 * path of the chat's workspace and outside the Delo home.
 */
const WORKSPACE_PATH_ACTIONS: ReadonlySet<string> = new Set([
  'workspaceFiles/list', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat', 'officeToPdf/render',
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

/** Where a device's workspace-file call may reach: the chat's real workspace root, and the Delo home it never reaches. */
interface WorkspaceBounds {
  readonly root: string
  readonly deloHome: string
}

/**
 * The real path of an absolute path when it lies inside the chat's workspace and outside the Delo home.
 * @param bounds - the real workspace root and the real Delo home.
 * @param path - the absolute path.
 * @returns the real path, or undefined when it does not resolve or resolves outside.
 */
function reachableReal(bounds: WorkspaceBounds, path: string): string | undefined {
  const real = realPathOf(path)
  if (real === undefined || !within(bounds.root, real) || within(bounds.deloHome, real)) return undefined
  return real
}

/**
 * The real path a device's path names, resolved as the workspace-file service resolves it: an absolute path as it is,
 * a relative one from the workspace root.
 * @param bounds - the real workspace root and the real Delo home.
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
 * @param bounds - the real workspace root and the real Delo home.
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
 * @returns the bounds, or undefined when the Host cannot name the chat's workspace, or it or the Delo home does not resolve.
 */
function boundsOf(facts: Pick<ReachAccessFacts, 'workspaceRootOf' | 'deloHome'>, resource: RemoteAccessResource): WorkspaceBounds | undefined {
  if (resource.kind !== 'session') return undefined
  const workspace = facts.workspaceRootOf(resource.id)
  const root = workspace === undefined ? undefined : realPathOf(workspace)
  const deloHome = realPathOf(facts.deloHome)
  if (root === undefined || deloHome === undefined) return undefined
  return { root, deloHome }
}

/** The condition every binding of a device carries: one call's action, the resource it is decided on and its arguments. */
type ReachCondition = (request: {
  readonly action: RemoteAccessAction
  readonly resource: RemoteAccessResource
  readonly args?: Readonly<Record<string, unknown>>
}) => RemoteAccessDecision

/**
 * The condition of one device's bindings, the single place an elevated action is decided. It refuses an action of
 * {@link REACH_ELEVATED_ACTIONS} with `elevation-required: <action>` unless the device holds a running elevation, for a
 * call and for an event, a snapshot or a list filter alike, and logs each elevated call with the elevation that admits
 * it. It refuses a `session/create` that names a folder or a preset, elevated or not: a device starts a chat only in a
 * Workspace the person registered at the computer, with the configured preset, because a folder decides where the
 * chat's commands may write and a preset decides its tools. It refuses a workspace-file call unless every path it names
 * is one a device may reach (see {@link WORKSPACE_PATH_ACTIONS}). Every other action is allowed as its role lists it,
 * and so is every other question asked without a call's arguments.
 * @param facts - the Host state the policy reads.
 * @param deviceId - the device whose bindings carry the condition.
 * @returns the condition.
 */
export function createCondition(facts: Pick<ReachAccessFacts, 'workspaceRootOf' | 'deloHome' | 'elevationOf' | 'logElevated'>, deviceId: string): ReachCondition {
  return ({ action, resource, args }) => {
    if (ELEVATED_SET.has(action)) {
      const elevation = facts.elevationOf(deviceId)
      if (elevation === undefined) return { kind: 'deny', reason: `elevation-required: ${action}` }
      if (args !== undefined) facts.logElevated(`home-auth: elevated action: device=${deviceId} listener=${elevation.listener} action=${action} elevation=${elevation.id}`)
    }
    if (args === undefined) return ALLOW
    if (action === 'session/create') {
      for (const value of Object.values(args)) {
        if (typeof value === 'object' && value !== null && (Reflect.get(value, 'cwd') !== undefined || Reflect.get(value, 'agentPreset') !== undefined)) {
          return { kind: 'deny', reason: 'loopback-required: session/create with a folder or a preset' }
        }
      }
      return ALLOW
    }
    if (WORKSPACE_PATH_ACTIONS.has(action)) {
      const bounds = boundsOf(facts, resource)
      if (bounds === undefined || !workspacePathsReachable(bounds, args)) {
        return { kind: 'deny', reason: `loopback-required: ${action} with a path outside the chat's workspace` }
      }
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
   * @returns whether it does.
   */
  readonly admitted: (deviceId: string) => boolean
  /**
   * The Workspaces of the Host with their Sessions, empty while no Workspace registry is active.
   * @returns the Workspaces in registry order.
   */
  readonly workspaces: () => readonly Pick<Workspace, 'id' | 'sessionIds'>[]
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
  /** The Delo home, which holds the home's secrets and tokens; no device read reaches a path inside it. */
  readonly deloHome: string
  /**
   * The running elevation of one device on a listener the home serves, read before each elevated action.
   * @param deviceId - the device.
   * @returns its id and listener, or undefined.
   */
  readonly elevationOf: (deviceId: string) => { readonly id: string; readonly listener: string } | undefined
  /**
   * Record one line in the operational log, for each call an elevation admits.
   * @param line - the line.
   */
  readonly logElevated: (line: string) => void
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
 * Build the `reach-device` policy. A device a reach listener admits holds the allowed actions on the global resource,
 * on every Workspace and on every Session the facts name: a Session of a Workspace or a live one. It holds nothing
 * once no reach listener holds a Peer for it.
 * @param facts - the Host state the policy reads.
 * @returns the policy the authenticator registers for {@link REACH_DEVICE}.
 */
export function createReachAccessPolicy(facts: ReachAccessFacts): RemoteAccessPolicy<ReachDevicePrincipal> {
  return {
    bindings(device): readonly RemoteAccessBinding[] {
      if (!facts.admitted(device.deviceId)) return []
      const condition = createCondition(facts, device.deviceId)
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
