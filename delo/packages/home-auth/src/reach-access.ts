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
import type {
  RemoteAccessAction,
  RemoteAccessBinding,
  RemoteAccessDecision,
  RemoteAccessPolicy,
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
 * for a phone: read chats, workspaces and the redacted settings, start chats, send messages, stop runs, and answer
 * ordinary prompts. An endpoint whose name ends in a read is listed here only when it reads no secret and no file by
 * path.
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
  'permissionPresets/catalog': 'read the permission presets; changing one is refused',
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
const FILE_BY_PATH = 'reads a file by path on the home\'s computer, outside the sandbox\'s protected-home rule'
const CHANGES = 'the Changes surface reads the working tree of the home\'s computer'
const WORKSPACE_MANAGEMENT = 'workspace management registers or removes folders of the home\'s computer'
const CHAT_ORGANIZATION = 'organizing chats is not in the device rule'
const DEFAULT_MODEL = 'saves the default model, a settings write'
const OPEN_ON_COMPUTER = 'opens an application on the home\'s computer'
const GOAL_CHANGE = 'changing a chat\'s standing goal is not in the device rule'
const SCHEDULE_CHANGE = 'a scheduled follow-up runs prompts later with no person present'
const DYNAMIC_PLUGIN = 'runs model-authored plugin code in the Host'
const FEEDBACK = 'feedback leaves the home, and Delo turns it off'
const PRESET_CHOICE = 'an agent preset decides the tools and access a chat runs with, which is chosen at the home\'s own computer'

/**
 * Every action a device may not take over a reach listener, with why it belongs to the home's own computer. The
 * refusal names the action; this table tells a deliberate refusal from an action nobody classified.
 */
export const REACH_DENIED_ACTIONS = {
  'agentPresets/select': PRESET_CHOICE,
  'pluginManager/cancelInstall': PLUGIN_MANAGEMENT,
  'pluginManager/history': PROFILE_HISTORY,
  'pluginManager/inspect': PLUGIN_MANAGEMENT,
  'pluginManager/installBundle': PLUGIN_MANAGEMENT,
  'pluginManager/listBundles': PLUGIN_MANAGEMENT,
  'pluginManager/listPlugins': PLUGIN_MANAGEMENT,
  'pluginManager/listVersionExemptions': PLUGIN_MANAGEMENT,
  'pluginManager/listVersions': PLUGIN_MANAGEMENT,
  'pluginManager/readBundleDetail': PLUGIN_MANAGEMENT,
  'pluginManager/registries': PLUGIN_MANAGEMENT,
  'pluginManager/removeBundle': PLUGIN_MANAGEMENT,
  'pluginManager/restore': PROFILE_HISTORY,
  'pluginManager/setBundleEnabled': PLUGIN_MANAGEMENT,
  'pluginManager/setPluginEnabled': PLUGIN_MANAGEMENT,
  'pluginManager/setVersionExemption': PLUGIN_MANAGEMENT,
  'pluginManager/undo': PROFILE_HISTORY,
  'pluginManager/updateBundle': PLUGIN_MANAGEMENT,
  'pluginManager/waitForInstall': PLUGIN_MANAGEMENT,
  'pluginInventory/list': PLUGIN_MANAGEMENT,
  'pluginRegistryProbe/fastest': PLUGIN_MANAGEMENT,
  'event:plugin-manager/changed': PLUGIN_MANAGEMENT,
  'event:plugin-manager/install-log': PLUGIN_MANAGEMENT,
  'event:plugin-manager/install-state': PLUGIN_MANAGEMENT,
  'event:plugin-manager/update-state': PLUGIN_MANAGEMENT,
  'event:plugin-market/changed': PLUGIN_MANAGEMENT,
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
  'workspaceFiles/list': FILE_BY_PATH,
  'workspaceFiles/read': FILE_BY_PATH,
  'workspaceFiles/readBytes': FILE_BY_PATH,
  'workspaceFiles/stat': FILE_BY_PATH,
  'workspaceFiles/changes': CHANGES,
  'officeToPdf/render': FILE_BY_PATH,
  'officeToPdf/generation': FILE_BY_PATH,
  'fileReferences/list': 'lists paths by query on the home\'s computer, outside the sandbox\'s protected-home rule',
  'workspace/create': WORKSPACE_MANAGEMENT,
  'workspace/delete': WORKSPACE_MANAGEMENT,
  'workspace/initializeDefault': WORKSPACE_MANAGEMENT,
  'workspace/insertBefore': WORKSPACE_MANAGEMENT,
  'workspace/rename': WORKSPACE_MANAGEMENT,
  'workspace/archiveSession': CHAT_ORGANIZATION,
  'workspace/unarchiveSession': CHAT_ORGANIZATION,
  'workspace/insertSessionBefore': CHAT_ORGANIZATION,
  'workspace/pinSession': CHAT_ORGANIZATION,
  'workspace/unpinSession': CHAT_ORGANIZATION,
  'session/rename': CHAT_ORGANIZATION,
  'session/selectModel': DEFAULT_MODEL,
  'session/initializeDefaultModel': DEFAULT_MODEL,
  'session/openWorkspacePath': OPEN_ON_COMPUTER,
  'session/workspacePathApplications': OPEN_ON_COMPUTER,
  'commands/execute': 'a slash command can change settings, plugins or the profile',
  'goals/clear': GOAL_CHANGE,
  'goals/complete': GOAL_CHANGE,
  'goals/create': GOAL_CHANGE,
  'goals/edit': GOAL_CHANGE,
  'goals/pause': GOAL_CHANGE,
  'goals/resume': GOAL_CHANGE,
  'schedule/create': SCHEDULE_CHANGE,
  'schedule/edit': SCHEDULE_CHANGE,
  'schedule/run': SCHEDULE_CHANGE,
  'schedule/deleteInactive': 'deletes scheduled follow-ups',
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
 * Assert that no action is both allowed and refused.
 * @param allowed - the allowed actions.
 * @param denied - the refused actions.
 * @throws {TypeError} naming every action both tables list.
 */
export function assertDisjoint(allowed: Readonly<Record<string, string>>, denied: Readonly<Record<string, string>>): void {
  const both = Object.keys(allowed).filter(action => Object.hasOwn(denied, action)).sort()
  if (both.length > 0) throw new TypeError(`@delo/home-auth: reach access lists ${JSON.stringify(both)} as both allowed and denied`)
}

assertDisjoint(REACH_ALLOWED_ACTIONS, REACH_DENIED_ACTIONS)

/** The allowed actions, which every role of the policy lists. */
const ALLOWED: readonly RemoteAccessAction[] = Object.freeze(Object.keys(REACH_ALLOWED_ACTIONS) as (keyof typeof REACH_ALLOWED_ACTIONS)[])
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED)

/**
 * The role over one resource kind.
 * @param resource - the kind.
 * @returns the role listing every allowed action.
 */
function role<K extends RemoteAccessResourceKind>(resource: K): RemoteAccessRole<K> {
  return { name: `delo:reach-device-${resource}`, resource, actions: ALLOWED }
}

const ALLOW: RemoteAccessDecision = { kind: 'allow' }

/**
 * Refuse a `session/create` that names a folder or a preset: a device starts a chat only in a Workspace the person
 * registered at the computer, with the configured preset, because a folder decides where the chat's commands may write
 * and a preset decides its tools. Every other action is allowed as its role lists it.
 * @param request - the action and a call's named arguments.
 * @param request.action - the action.
 * @param request.args - the call's named arguments, absent outside a concrete call.
 * @returns allow, or the refusal naming the action.
 */
export function createCondition(request: { readonly action: RemoteAccessAction; readonly args?: Readonly<Record<string, unknown>> }): RemoteAccessDecision {
  if (request.action !== 'session/create' || request.args === undefined) return ALLOW
  for (const value of Object.values(request.args)) {
    if (typeof value === 'object' && value !== null && (Reflect.get(value, 'cwd') !== undefined || Reflect.get(value, 'agentPreset') !== undefined)) {
      return { kind: 'deny', reason: 'loopback-required: session/create with a folder or a preset' }
    }
  }
  return ALLOW
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
}

/**
 * The reason an allowed action was refused on a resource the policy could not name, or the refusal of every other
 * action.
 * @param action - the refused action.
 * @returns `resource-unlisted: <action>` for an allowed action, otherwise `loopback-required: <action>`.
 */
export function reachRefusal(action: RemoteAccessAction): string {
  return ALLOWED_SET.has(action) ? `resource-unlisted: ${action}` : `loopback-required: ${action}`
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
      const bindings: RemoteAccessBinding[] = [{ role: GLOBAL_ROLE, resource: { kind: 'global' }, condition: createCondition }]
      const sessions = new Set<SessionId>()
      for (const workspace of facts.workspaces()) {
        bindings.push({ role: WORKSPACE_ROLE, resource: { kind: 'workspace', id: workspace.id }, condition: createCondition })
        for (const id of workspace.sessionIds) sessions.add(id)
      }
      for (const id of facts.liveSessions()) sessions.add(id)
      for (const id of sessions) bindings.push({ role: SESSION_ROLE, resource: { kind: 'session', id } })
      return bindings
    },
    explain: request => reachRefusal(request.action),
  }
}
