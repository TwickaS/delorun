/**
 * @delo/plugin-changes: the agent's plugin changes wait for the person, and no recomposition of the profile loads
 * content the person did not approve. With the C16 switch `plugin_changes_pending` on, a `plugin_manager` call whose
 * action is `install_bundle` or `remove_bundle` does not run: a `tools/pre-execute` listener records it in the
 * profile's change log as a pending change and denies the call with a result the model reads, which names the change
 * and says nothing was installed. A call whose action changes which plugins run, their settings or the profile's
 * history in another way (`set_bundle`, `set_plugin`, `configure`, `set_version_exemption`, `undo`, `restore`) does not
 * run either and records nothing: the model reads that the person makes that change at their computer. The tool never
 * reaches its own full-access approval for these actions, and the person applies or discards a recorded change at
 * their computer with `delorun changes`. The tool offers no update action: the agent asks for an update by installing
 * a version of a plugin the profile has, which records a `plugin-update`.
 *
 * A tool guard backs the listener: a `pre-execute` listener that allowed such a call without calling `next()` would
 * skip the listener, and the guard, which runs after every listener and cannot be overruled, denies every such call the
 * listener did not handle.
 *
 * Whatever the switch says, the plugin provides upstream hot reload's `profileReconcileCheck`, which runs before every
 * recomposition of the profile, whether the person's studio, `delorun plugin`, `delorun changes`, a work session or the
 * profile's own file watch caused it: `@delo/changes`' `prepareReload` moves a `link:` dependency that names a folder to
 * the plugin's active directory and refuses the recomposition when a link or an active directory is not what Changes
 * keeps. A link is the harness's own when it is into the runtime store, or names the directory the running Host already
 * loads that package from: a start brought every other link under Changes.
 *
 * Off, the parity value and the default, the plugin registers no listener or guard, and the tool runs and asks as
 * upstream's does.
 *
 * Whatever the switch says, once the web server and Connection are present the plugin registers the studio's Changes
 * routes ([routes](./routes.ts)) under `/delo/changes/`, which the recovery screen and the studio read and act through;
 * an action needs the person at their computer, and safe mode keeps the bundles `installationBundles` names.
 * @module @delo/plugin-changes
 */
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-hmr'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { PACKAGE_NAME_PATTERN, prepareReload, reloadProfile, startNotice, type ChangeEntry } from '@delo/changes'
import { recordPluginRequest, type PluginRequest } from '@delo/changes/install'
import { CHANGES_ROUTE_PREFIX, changesRoutes } from './routes.ts'

/**
 * The page global upstream's boot page reads the Changes routes' prefix from (`dshRecoveryRoutes` in
 * `@deepseek-ai/dsh-client-web`'s boot page); without it the boot page shows no recovery screen.
 */
export const RECOVERY_ROUTES_GLOBAL = 'dshRecoveryRoutes'

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
  /**
   * The bundles the installation itself ships, which safe mode from the studio keeps loading: Delo's profile bundle
   * list, which `@delo/bundle-local` restates in its row. Empty, the studio's safe-mode route refuses and points to
   * `delorun recover safe-mode`.
   */
  readonly installationBundles: string[]
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  installationBundles: z.array(z.string().pattern(PACKAGE_NAME_PATTERN)).default([]),
})

/** The tool registry, whose `tools/pre-execute` event and guards the plugin uses. */
export const inject = ['tools']

/** The tool whose actions the plugin holds back. */
export const PLUGIN_MANAGER = 'plugin_manager'

/** The `plugin_manager` actions that change which plugins the profile has, and the request each records. */
const HELD_ACTIONS: Readonly<Record<string, PluginRequest['action']>> = { install_bundle: 'install', remove_bundle: 'remove' }

/**
 * The other `plugin_manager` actions that change what the profile runs: which plugins are on, their settings, the
 * versions allowed, or a version of the profile's history brought back. None records a change; the person makes it.
 */
export const AT_COMPUTER_ACTIONS: ReadonlySet<string> = new Set(['set_bundle', 'set_plugin', 'configure', 'set_version_exemption', 'undo', 'restore'])

/** The stable code of the denial of an action the person makes at their computer. */
export const PLUGIN_CHANGE_AT_COMPUTER = 'PLUGIN_CHANGE_AT_COMPUTER'

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

/**
 * Whether a call is a `plugin_manager` action the person makes at their computer.
 * @param exec - the pending call.
 * @returns whether its action is one of {@link AT_COMPUTER_ACTIONS}.
 */
export function atComputerAction(exec: Pick<ToolExecution, 'name' | 'arguments'>): boolean {
  if (exec.name !== PLUGIN_MANAGER) return false
  const action = (exec.arguments as { action?: unknown } | undefined)?.action
  return typeof action === 'string' && AT_COMPUTER_ACTIONS.has(action)
}

/**
 * The result the model reads for an action the person makes at their computer.
 * @param action - the action.
 * @returns the denial.
 */
function atComputer(action: string): PreToolDecision {
  return {
    kind: 'deny',
    reason: `${action} changes what the person's harness runs, so the person makes it at their computer, in the studio or with delorun plugin. Nothing was changed; tell the person what you would change and why.`,
    info: { name: 'PluginChangeAtComputer', code: PLUGIN_CHANGE_AT_COMPUTER },
  }
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
 * Provide the check before every recomposition of the profile, and, with the switch on, hold back the agent's plugin
 * changes: every `plugin_manager` install, update or removal is recorded as a pending change in the profile the Host
 * runs and denied with the change's id, one that cannot be recorded is denied too, and every other action that changes
 * what the profile runs is denied as one the person makes at their computer. Off, only the check is provided.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  // Upstream hot reload's `ProfileReconcileCheck`: it awaits `check` before every recomposition of the profile.
  ctx.provide('profileReconcileCheck', { check: (profile: ProfileContext) => checkReload(ctx, profile) })
  ctx.inject(['webServer', 'connection'], (scope) => {
    const routes = changesRoutes({
      connection: scope.connection,
      profile: () => {
        const profile = scope.get('profileContext')
        return profile === undefined ? undefined : { home: profile.home, profile: profile.name, profileDir: profile.dir }
      },
      reload: () => reloadProfile(scope.get('hmr')),
      installationBundles: config.installationBundles,
      logger: scope.logger,
    })
    scope.effect(() => {
      const registered = routes.map(route => scope.webServer.register(route))
      return () => {
        for (const off of registered) off()
      }
    }, 'plugin-changes: studio routes')
    // Upstream's boot page offers its recovery screen only on a page that names the routes, which the index carries
    // whatever any plugin's client code does.
    scope.on('webserver/index-inject', (table) => { table.push({ kind: 'global', name: RECOVERY_ROUTES_GLOBAL, value: CHANGES_ROUTE_PREFIX }) })
  })
  if (!config.enabled) return
  const recorded = new WeakSet<object>()
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (atComputerAction(exec)) {
      recorded.add(exec)
      return atComputer((exec.arguments as { action: string }).action)
    }
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
  ctx.tools.guard(exec => (heldRequest(exec) !== undefined || atComputerAction(exec)) && !recorded.has(exec)
    ? 'Plugin changes wait for the person at their computer; this call was not handled as one, so it does not run.'
    : undefined)
}

/**
 * The check before a recomposition of the profile: `@delo/changes`' `prepareReload`, with the links the running Host
 * already loads as the harness's own; what it moved is logged.
 * @param ctx - the plugin context.
 * @param profile - the profile about to be recomposed.
 * @throws {ChangesError} `LOAD_REFUSED` when a link or an active directory is not what Changes keeps, which refuses the
 *   recomposition.
 */
async function checkReload(ctx: Context, profile: ProfileContext): Promise<void> {
  const harnessLink = loadedLinks(ctx.get('pluginPackages')?.resolution?.linkedRoots ?? [])
  const changes = await prepareReload({ home: profile.home, profile: profile.name, profileDir: profile.dir, harnessLink })
  const notice = startNotice(changes)
  if (notice !== '') ctx.logger.info(notice.trimEnd())
}

/**
 * The harness's own links as the running Host knows them: a link whose target is the directory the Host already loads
 * that package from, which a start left alone.
 * @param linkedRoots - the profile's links to directories outside the profiles tree, from the runtime resolution the
 *   Host last published.
 * @returns whether a link names the package's loaded directory.
 */
export function loadedLinks(linkedRoots: readonly { readonly name: string, readonly realPath: string }[]): (name: string, target: string) => boolean {
  return (name, target) => {
    const real = realTarget(target)
    return real !== undefined && linkedRoots.some(root => root.name === name && root.realPath === real)
  }
}

/**
 * @param path - a link's target.
 * @returns its real path, or undefined when it does not resolve.
 */
function realTarget(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    // ENOENT, ENOTDIR or ELOOP: a target that does not resolve is not where the Host loads a package from.
    return undefined
  }
}
