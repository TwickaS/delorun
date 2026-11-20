/**
 * @delorun/plugin-changes: with protection on, the agent's plugin changes wait for the person, and no recomposition of
 * the profile loads content the person did not approve. With the C16 switch `plugin_changes_pending` on, a
 * `tools/pre-execute` listener reads the protection setting (`readProtection` of the profile the Host runs) at each
 * `plugin_manager` call whose action changes which plugins run, so `delorun changes protection on|off` takes effect at
 * the next call without a restart.
 *
 * With protection on, a call whose action is `install_bundle` or `remove_bundle` does not run: the listener records it
 * in the profile's change log as a pending change and denies the call with a result the model reads, which names the
 * change and says nothing was installed. A call whose action changes which plugins run, their settings or the profile's
 * history in another way (`set_bundle`, `set_plugin`, `configure`, `set_version_exemption`, `undo`, `restore`) does not
 * run either and records nothing: the model reads that the person makes that change at their computer. The tool never
 * reaches its own full-access approval for these actions, and the person applies or discards a recorded change at
 * their computer with `delorun changes` or in the studio. The tool offers no update action: the agent asks for an update
 * by installing a version of a plugin the profile has, which records a `plugin-update`.
 *
 * With protection off, the default, every such call goes to upstream as with the switch off: the listener reads what
 * the call changes from the profile's history and files, writes an entry for it in the profile's agent-action log
 * before the tool runs, calls `next()`, and upstream's full-access approval alone decides. A `tools/post-execute`
 * listener, registered ahead of the others, completes the entry with the history version upstream wrote and the one
 * before it, which `delorun changes undo` and the studio bring back, or removes it when the action changed nothing
 * ([agent actions](../../changes/src/agent-actions.ts)). An action that ran but could not be fully recorded is reported
 * to the model as unrecorded, and one whose records cannot be read or written before it runs is denied. A plugin the agent installs from a folder or links reloads on save, and the check
 * below logs its folder's content as an unreviewed change as it does for the person's.
 *
 * A protection record that cannot be read holds every such call as protection on does: it is denied, naming that the
 * setting cannot be read; an unreadable setting is never read as off.
 *
 * A tool guard backs the listener: a `pre-execute` listener that allowed such a call without calling `next()` would
 * skip the listener, and the guard, which runs after every listener and cannot be overruled, denies every such call the
 * listener did not handle. A call the listener passed through with protection off counts as handled.
 *
 * Whatever the switch says, the plugin provides upstream hot reload's `profileReconcileCheck`, which runs before every
 * recomposition of the profile, whether the person's studio, `delorun plugin`, `delorun changes`, a work session or the
 * profile's own file watch caused it: `@delorun/changes`' `prepareReload` moves a `link:` dependency that names a folder, a missing one included, to
 * the plugin's active directory and refuses the recomposition when a link or an active directory is not what Changes
 * keeps. A link is the harness's own when it is into the runtime store, or names the directory the running Host already
 * loads that package from: a start brought every other link under Changes.
 *
 * With the switch off, the parity value and the default, the plugin registers no listener or guard, and the tool runs
 * and asks as upstream's does.
 *
 * Whatever the switch says, once the web server and Connection are present the plugin registers the studio's Changes
 * routes ([routes](./routes.ts)) under `/delorun/changes/`, which the recovery screen and the studio read and act through;
 * an action needs the person at their computer, and safe mode keeps the bundles `installationBundles` names. Applying an
 * agent's plugin request in the studio runs `@delorun/changes`' shared plugin operation from the Host's directory with the
 * profile launcher's pnpm, its output in the Host's log. The routes tell a remote session by Connection's
 * `isReachPeer`; a Connection without it registers no route.
 * @module @delorun/plugin-changes
 */
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { getDelorunRuntimeVersion, getDshRuntimeVersion, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { HostConnectionAdmission, HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-hmr'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { beginAgentAction, finishAgentAction, PACKAGE_NAME_PATTERN, planAgentAction, prepareReload, readProtection, reloadProfile, startNotice, type AgentActionPlan, type ChangeEntry, type ChangeId, type ChangesContext, type ChangesHarnessHost, type ChangesRestartHost, type PluginOperation, type ProtectionLevel } from '@delorun/changes'
import { REACH_DEVICE, unlockOf, type ReachDevicePrincipal } from '@delorun/home-auth'
import { recordPluginRequest, type PluginRequest } from '@delorun/changes/install'
import { loadUpstreamChecks, upstreamPluginOperation } from '@delorun/changes/plugin-operation'
import type { VersionOutput } from '@delorun/contract-plugin-versions'
import { faceAccessOf } from './face-access.ts'
import { LiveAssets, harnessEffectOf } from './live-apply.ts'
import { restartRoutes, restartStateOf } from './restart-route.ts'
import { CHANGES_ROUTE_PREFIX, changesGate, changesRoutes, type ChangesGate, type RouteConnection, type RouteDevice, type RouteDevices } from './routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The running runtime's harness, which `delorun start`'s home process provides for the Changes routes. */
    changesHarness?: ChangesHarnessHost
    /** The home process's restart and what this Host booted with, which `delorun start`'s home process provides for the Restart route. */
    changesRestart?: ChangesRestartHost
    /** The Changes routes' fence and access table for another plugin's routes, which this plugin provides once the web server and Connection are present. */
    changesGate?: ChangesGate
  }
}

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
   * C16 switch `plugin_changes_pending`: whether, with protection on, an agent's `plugin_manager` install, update or
   * removal records a pending change instead of running. With protection off the tool runs and asks as upstream's does
   * whatever the switch says. Off, the parity value and the default, the plugin registers nothing and the tool runs and
   * asks as upstream's does. Delorun's composition turns it on.
   */
  readonly enabled: boolean
  /**
   * The bundles the installation itself ships, which safe mode from the studio keeps loading: Delorun's profile bundle
   * list, which `@delorun/bundle-local` restates in its row. Empty, the studio's safe-mode route refuses and points to
   * `delorun recover safe-mode`.
   */
  readonly installationBundles: string[]
  /**
   * How long the studio's Restart waits for running chats before it gives up and keeps Delorun running as it is, in
   * seconds. New turns are refused while it waits.
   */
  readonly restartWaitSeconds: number
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  installationBundles: z.array(z.string().pattern(PACKAGE_NAME_PATTERN)).default([]),
  restartWaitSeconds: z.natural().min(10).max(86_400).default(600),
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
 * The result the model reads when the protection setting cannot be read, so whether the call waits for the person is
 * unknown: it is held.
 * @param action - the action.
 * @param detail - why the setting cannot be read.
 * @returns the denial.
 */
function protectionUnreadable(action: string, detail: string): PreToolDecision {
  return {
    kind: 'deny',
    reason: `${action} changes what the person's harness runs, and the protection setting that decides whether it waits for the person cannot be read: ${detail} Nothing was changed; tell the person, who checks it with delorun changes protection.`,
    info: { name: 'PluginChangeUnrecorded', code: PLUGIN_CHANGE_UNRECORDED },
  }
}

/**
 * The result the model reads when an action that ran with protection off is not fully recorded in Changes.
 * @param what - what happened.
 * @returns the block.
 */
function unrecordedBlock(what: string): PostToolDecision {
  return { kind: 'block', feedback: [{ type: 'text', text: `${what} Tell the person, who checks the profile with delorun changes list and delorun recover.` }], info: { name: 'PluginChangeUnrecorded', code: PLUGIN_CHANGE_UNRECORDED } }
}

/**
 * The result the model reads when a call would run with protection off but Changes cannot read the profile it must record
 * the call in, so it does not run.
 * @param action - the action.
 * @param detail - why.
 * @returns the denial.
 */
function unplanned(action: string, detail: string): PreToolDecision {
  return {
    kind: 'deny',
    reason: `${action} changes what the person's harness runs, and every such change is recorded in Changes, whose records cannot be read: ${detail} Nothing was changed; tell the person.`,
    info: { name: 'PluginChangeUnrecorded', code: PLUGIN_CHANGE_UNRECORDED },
  }
}

/**
 * Provide the check before every recomposition of the profile, and, with the switch on, hold back the agent's plugin
 * changes while protection is on: every `plugin_manager` install, update or removal is recorded as a pending change in
 * the profile the Host runs and denied with the change's id, one that cannot be recorded is denied too, and every other
 * action that changes what the profile runs is denied as one the person makes at their computer. With protection off,
 * every such call goes on to upstream, and an action that changed the profile is recorded in Changes afterwards; with a
 * protection record that cannot be read every such call is denied. With the switch off, only
 * the check is provided.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  // Upstream hot reload's `ProfileReconcileCheck`: it awaits `check` before every recomposition of the profile.
  ctx.provide('profileReconcileCheck', { check: (profile: ProfileContext) => checkReload(ctx, profile) })
  ctx.inject(['webServer', 'connection'], (scope) => {
    const restart = (): ChangesRestartHost | undefined => scope.get('changesRestart')
    const harness = (): ReturnType<ChangesHarnessHost['context']> => scope.get('changesHarness')?.context()
    // Only a Host a home process runs serves live files: elsewhere every change waits for the next start.
    const live = restart() === undefined ? undefined : new LiveAssets(scope.webServer, request => scope.connection.requestRejection(request))
    if (live !== undefined) {
      scope.effect(() => () => { live.dispose() }, 'plugin-changes: live studio files')
      // A Host booted again in the same process, after a failed restart or a reload, serves the live files the records
      // compose at once; one that cannot be read leaves the running tree's file served.
      const running = restart()
      const context = harness()
      if (running !== undefined && context !== undefined) {
        live.refresh(context, running.running).catch((error: unknown) => {
          scope.logger.warn(`Delorun serves the studio's own files as this start ran them: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }
    const dependencies = {
      connection: routeConnection(scope.connection),
      profile: () => {
        const profile = scope.get('profileContext')
        return profile === undefined ? undefined : { home: profile.home, profile: profile.name, profileDir: profile.dir, ...runningRelease() }
      },
      reload: () => reloadProfile(scope.get('hmr')),
      pluginOperation: changes => hostPluginOperation(scope, changes),
      installationBundles: config.installationBundles,
      logger: scope.logger,
      loopbackPort: () => scope.webServer.port,
      scaffold: () => {
        const launched = scope.get('profileContext')
        if (launched === undefined) throw new Error('plugin-changes: this Host runs no profile launched by dsh, so it has no installation to scaffold for.')
        return { running: { delorun: getDelorunRuntimeVersion() as VersionOutput['delorun'], dsh: getDshRuntimeVersion() as VersionOutput['dsh'] }, installation: { anchor: launched.installAnchor } }
      },
      workspaces: () => scope.get('workspaceRegistry')?.list().map(({ id, title, path }) => ({ id, title, path })) ?? [],
      reveal: showFolder,
      delorunVersion: () => {
        const version = getDelorunRuntimeVersion()
        if (version === undefined) throw new Error('plugin-changes: this Host was not started by delorun, so it does not know the Delorun version a setup file names.')
        return version
      },
      devices: routeDevices(scope),
      harness,
      harnessEffect: harnessEffectOf({ restart, harness, live, logger: scope.logger }),
      restartState: () => restartStateOf(restart(), harness()),
      clearRestartFailure: () => { restart()?.clearFailure() },
    } satisfies Parameters<typeof changesRoutes>[0]
    scope.effect(() => scope.provide('changesGate', changesGate(dependencies)), 'plugin-changes: gate for other plugins\' routes')
    const routes = [...changesRoutes(dependencies), ...restartRoutes(dependencies, { restart, waitSeconds: config.restartWaitSeconds })]
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
  const planned = new WeakMap<object, { readonly plan: AgentActionPlan, readonly id: ChangeId }>()
  const changesOf = (profile: ProfileContext): ChangesContext => ({ home: profile.home, profile: profile.name, profileDir: profile.dir, ...runningRelease() })
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const held = heldRequest(exec)
    const other = atComputerAction(exec)
    if (held === undefined && !other) return next()
    recorded.add(exec)
    const args = exec.arguments as { action: string, target?: unknown, enabled?: unknown }
    const action = args.action
    const profile = ctx.get('profileContext')
    if (profile === undefined) return held === undefined ? atComputer(action) : unrecorded('this harness runs no profile whose changes Delorun keeps.')
    let level: ProtectionLevel
    try {
      level = await readProtection(profile.home)
    } catch (error) {
      return protectionUnreadable(action, messageOf(error))
    }
    if (level === 'off') {
      // Upstream's full-access approval alone decides. The action is recorded in Changes before it runs, so nothing it loads goes unrecorded, and completed once it ran.
      try {
        const changes = changesOf(profile)
        const plan = await planAgentAction(changes, { action, ...typeof args.target === 'string' ? { target: args.target } : {}, ...typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {} })
        planned.set(exec, { plan, id: await beginAgentAction(changes, plan) })
      } catch (error) {
        return unplanned(action, messageOf(error))
      }
      return next()
    }
    if (held === undefined) return atComputer(action)
    if (typeof held.target !== 'string' || held.target.trim() === '') return unrecorded('the call names no target.')
    try {
      const entry = await recordPluginRequest(changesOf(profile), { action: held.action, spec: held.target })
      return pendingDecision(entry)
    } catch (error) {
      return unrecorded(messageOf(error))
    }
  }, { prepend: true })
  // First among the post-execute listeners, so a listener ahead of this one that blocks the result cannot leave the entry unfinished.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const started = planned.get(exec)
    const profile = ctx.get('profileContext')
    if (started === undefined || profile === undefined) return next()
    const action = (exec.arguments as { action: string }).action
    try {
      const finished = await finishAgentAction(changesOf(profile), started.plan, started.id)
      if (finished.unsaved) return unrecordedBlock(`${action} changed the person's harness, but the profile's history could not save a version of it, so Delorun recorded it in Changes without an undo.`)
    } catch (error) {
      return unrecordedBlock(`${action} ran and may have changed the person's harness, but Delorun could not complete its record in Changes: ${messageOf(error)}`)
    }
    return next()
  }, { prepend: true })
  ctx.tools.guard(exec => (heldRequest(exec) !== undefined || atComputerAction(exec)) && !recorded.has(exec)
    ? 'Plugin changes wait for the person at their computer; this call was not handled as one, so it does not run.'
    : undefined)
}

/**
 * @param error - a thrown value.
 * @returns its words.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The plugin operation the studio's Apply of an agent's plugin request runs in the Host: `@delorun/changes`' shared
 * operation from the Host's directory with the installation anchor and pnpm the profile launcher names, its output in
 * the Host's log.
 * @param ctx - the plugin context, whose `profileContext` names the anchor, the directory and pnpm.
 * @param changes - the profile the request is applied to.
 * @returns the operation.
 * @throws {Error} when the Host runs no profile launched by dsh, which the routes never ask for.
 */
export function hostPluginOperation(ctx: Context, changes: ChangesContext): PluginOperation {
  const launched = ctx.get('profileContext')
  if (launched === undefined) throw new Error('plugin-changes: this Host runs no profile launched by dsh, so it has no plugin operation.')
  const { installAnchor, cwd, packageManager } = launched
  return upstreamPluginOperation(changes, {
    cwd,
    ...packageManager === undefined ? {} : { packageManager },
    output: (text, stream) => { ctx.logger[stream === 'stderr' ? 'warn' : 'info'](text.trimEnd()) },
    upstream: async () => ({ installAnchor, ...await loadUpstreamChecks() }),
  })
}

/**
 * Show a folder in the computer's file manager: the platform's own opener, started detached with the folder as its only
 * argument, so no shell reads the path.
 * @param folder - a created plugin's folder.
 */
function showFolder(folder: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  const child = spawn(command, [folder], { detached: true, stdio: 'ignore' })
  child.on('error', () => { /* the folder is also shown as a path, so a missing opener leaves the person that. */ })
  child.unref()
}

/**
 * The paired devices as the routes read them, from the mounted `homeAuth` service. Without it no session is a paired
 * device's, so a remote session acts on nothing.
 * @param scope - the plugin context, which reads `homeAuth` when a request arrives.
 * @returns the reads.
 */
export function routeDevices(scope: Pick<Context, 'get'>): RouteDevices {
  return {
    deviceOf: async (peer) => {
      const home = scope.get('homeAuth')
      const principal = (peer as { readonly principal?: { readonly kind: string } }).principal
      if (home === undefined || principal?.kind !== REACH_DEVICE) return undefined
      const { deviceId } = principal as ReachDevicePrincipal
      const unlock = unlockOf(home, principal as ReachDevicePrincipal)
      const label = (await home.devices()).devices.find(device => device.id === deviceId)?.label ?? ''
      const device: RouteDevice = {
        id: deviceId,
        label,
        unlock: unlock === undefined ? 'none' : unlock.grace === true ? 'grace' : 'fresh',
        renew: () => { if (unlock !== undefined) home.touchUnlock(unlock.id) },
        face: faceAccessOf(home.faceGrants(), home.deviceHasPasskey(deviceId), { deviceId, listener: (principal as ReachDevicePrincipal).listener, unlockId: (principal as ReachDevicePrincipal).unlockId }),
      }
      return device
    },
  }
}

/**
 * Connection as the routes use it. `ctx.connection` is Connection's `HostConnectionService`, whose `isReachPeer` the
 * Context's `connection` type does not declare.
 * @param connection - `ctx.connection`.
 * @returns the same service, with the admission and `isReachPeer` the routes call.
 * @throws {Error} when the service has no `isReachPeer`, so no route could tell a remote session from the person at
 *   their computer.
 */
export function routeConnection(connection: HostConnectionAdmission): RouteConnection {
  const withReach = connection as HostConnectionAdmission & Partial<Pick<HostConnectionService, 'isReachPeer'>>
  if (typeof withReach.isReachPeer !== 'function') {
    throw new Error('plugin-changes: Connection does not name the sessions a reach listener admitted, so the Changes routes cannot tell a remote session from the person at their computer and are not registered.')
  }
  return withReach as HostConnectionAdmission & Pick<HostConnectionService, 'isReachPeer'>
}

/**
 * The installed release this Host runs from, for every Changes request it makes: the links an action writes and the
 * check before a recomposition name the same release's packages.
 * @returns `{ runningRelease }` from `DELORUN_VERSION`, or nothing when the Host runs from a source checkout.
 */
function runningRelease(): { readonly runningRelease?: string } {
  const release = getDelorunRuntimeVersion()
  return release === undefined ? {} : { runningRelease: release }
}

/**
 * The check before a recomposition of the profile: `@delorun/changes`' `prepareReload`, with the links the running Host
 * already loads as the harness's own; what it moved is logged.
 * @param ctx - the plugin context.
 * @param profile - the profile about to be recomposed.
 * @throws {ChangesError} `LOAD_REFUSED` when a link or an active directory is not what Changes keeps, which refuses the
 *   recomposition.
 */
async function checkReload(ctx: Context, profile: ProfileContext): Promise<void> {
  const harnessLink = loadedLinks(ctx.get('pluginPackages')?.resolution?.linkedRoots ?? [])
  const changes = await prepareReload({ home: profile.home, profile: profile.name, profileDir: profile.dir, harnessLink, ...runningRelease() })
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

export { discardImportReviews } from '@delorun/changes/setup-transfer'
export { changesGate, flag, onlyFields, RouteRefusal, type ChangesGate, type ChangesRoute, type RouteHandler } from './routes.ts'
