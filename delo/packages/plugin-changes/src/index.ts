/**
 * @delo/plugin-changes: the agent's plugin installs, updates and removals wait for the person. With the C16 switch
 * `plugin_changes_pending` on, a `plugin_manager` call whose action is `install_bundle` or `remove_bundle` does not
 * run: a `tools/pre-execute` listener records it in the profile's change log as a pending change and denies the call
 * with a result the model reads, which names the change and says nothing was installed. The tool never reaches its own
 * full-access approval for these actions, and the person applies or discards the change at their computer with
 * `delorun changes`. The tool offers no update action: the agent asks for an update by installing a version of a
 * plugin the profile has, which records a `plugin-update`.
 *
 * A tool guard backs the listener: a `pre-execute` listener that allowed such a call without calling `next()` would
 * skip the recording, and the guard, which runs after every listener and cannot be overruled, denies every such call
 * the listener did not record.
 *
 * Off, the parity value and the default, the plugin registers nothing, and the tool runs and asks as upstream's does.
 * @module @delo/plugin-changes
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { ChangeEntry } from '@delo/changes'
import { recordPluginRequest, type PluginRequest } from '@delo/changes/install'

/** The plugin's name in the loader's diagnostics. */
export const name = 'plugin-changes'

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `plugin_changes_pending`: whether an agent's `plugin_manager` install, update or removal records a
   * pending change instead of running. Off, the parity value and the default, the plugin registers nothing and the
   * tool runs and asks as upstream's does. Delo's composition turns it on.
   */
  readonly enabled: boolean
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/** The tool registry, whose `tools/pre-execute` event and guards the plugin uses. */
export const inject = ['tools']

/** The tool whose actions the plugin holds back. */
export const PLUGIN_MANAGER = 'plugin_manager'

/** The `plugin_manager` actions that change which plugins the profile has, and the request each records. */
const HELD_ACTIONS: Readonly<Record<string, PluginRequest['action']>> = { install_bundle: 'install', remove_bundle: 'remove' }

/** The stable code of the denial that reports a recorded change. */
export const PLUGIN_CHANGE_PENDING = 'PLUGIN_CHANGE_PENDING'

/** The stable code of the denial when the request could not be recorded. */
export const PLUGIN_CHANGE_UNRECORDED = 'PLUGIN_CHANGE_UNRECORDED'

/**
 * The request a `plugin_manager` call makes, when it is one the plugin holds back.
 * @param exec - the pending call.
 * @returns the request's action and its raw target, or undefined for another tool or action.
 */
export function heldRequest(exec: Pick<ToolExecution, 'name' | 'arguments'>): { readonly action: PluginRequest['action'], readonly target: unknown } | undefined {
  if (exec.name !== PLUGIN_MANAGER) return undefined
  const args = exec.arguments as { action?: unknown, target?: unknown } | undefined
  const action = args?.action
  if (typeof action !== 'string' || !Object.hasOwn(HELD_ACTIONS, action)) return undefined
  return { action: HELD_ACTIONS[action]!, target: args?.target }
}

/** What the model reads for each kind of recorded change: what did not happen. */
const NOTHING_DONE: Readonly<Record<string, string>> = {
  'plugin-install': 'Nothing was installed.',
  'plugin-update': 'Nothing was installed or updated.',
  'plugin-remove': 'Nothing was removed.',
}

/**
 * The result the model reads for a recorded change.
 * @param entry - the pending change.
 * @returns the denial.
 */
export function pendingDecision(entry: Pick<ChangeEntry, 'id' | 'kind'>): PreToolDecision {
  return {
    kind: 'deny',
    reason: `Recorded as a change waiting for the person's review at their computer: delorun changes show ${entry.id}. ${NOTHING_DONE[entry.kind]!}`,
    info: { name: 'PluginChangePending', code: PLUGIN_CHANGE_PENDING },
  }
}

/**
 * The result the model reads when the request could not be recorded.
 * @param detail - why.
 * @returns the denial.
 */
function unrecorded(detail: string): PreToolDecision {
  return {
    kind: 'deny',
    reason: `Plugin installs, updates and removals wait for the person's review at their computer, and this one could not be recorded: ${detail} Nothing was changed.`,
    info: { name: 'PluginChangeUnrecorded', code: PLUGIN_CHANGE_UNRECORDED },
  }
}

/**
 * Hold back the agent's plugin installs, updates and removals. On, every such `plugin_manager` call is recorded as a
 * pending change in the profile the Host runs and denied with the change's id; one that cannot be recorded is denied
 * too. Off, the plugin registers nothing.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const recorded = new WeakSet<object>()
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const held = heldRequest(exec)
    if (held === undefined) return next()
    recorded.add(exec)
    if (typeof held.target !== 'string' || held.target.trim() === '') return unrecorded('the call names no target.')
    const profile = ctx.get('profileContext')
    if (profile === undefined) return unrecorded('this harness runs no profile whose changes Delo keeps.')
    try {
      const entry = await recordPluginRequest({ home: profile.home, profile: profile.name, profileDir: profile.dir }, { action: held.action, spec: held.target })
      return pendingDecision(entry)
    } catch (error) {
      return unrecorded(`${error instanceof Error ? error.message : String(error)}`)
    }
  }, { prepend: true })
  ctx.tools.guard(exec => heldRequest(exec) !== undefined && !recorded.has(exec)
    ? 'Plugin installs, updates and removals wait for the person\'s review at their computer; this call was not recorded as a change, so it does not run.'
    : undefined)
}
