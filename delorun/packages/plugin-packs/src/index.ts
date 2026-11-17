/**
 * @delorun/plugin-packs: the Host side of plugin packs (A403, A404). A pack is a plugin outside the default install that
 * the release publishes as a separate signed file. This plugin keeps the Host's one install queue
 * (`@delorun/install-queue`), runs each item through the runtime store's verified pack install, loads the result
 * through the plugin manager's `installBundle('link:<pack directory>')`, serves the install list through Host fetch routes
 * ({@link PACK_ROUTES}) and announces progress on `plugin-manager/install-state`. The idle signal is the chat gate that `delorun`'s Host attaches through `delorunChatGate`; the
 * plugin manager's `packInstallTargets` service lets Plugins' official installs resolve an installed pack to its
 * directory.
 *
 * @module @delorun/plugin-packs
 */
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-hmr'
import z from '@deepseek-ai/schemastery'
import { reloadProfile } from '@delorun/changes'
import type { ChatGate } from '@delorun/home-process'
import { packRequestId } from './wire.ts'
import { DEFAULT_STALL_SECONDS, hostPacksEnvironment, type PacksEnvironment } from './environment.ts'
import { PacksHub } from './hub.ts'
import type { PluginInstallRequestId } from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { registerPackRoutes } from './routes.ts'

export type * from './wire.ts'
export { PACK_ELEVATED_ROUTES, PACK_ROUTES, packRequestId, packView } from './wire.ts'
export { hostPacksEnvironment, type PacksEnvironment } from './environment.ts'
export { PacksHub } from './hub.ts'
export { createPackRunner, failureOf } from './runner.ts'
export { registerPackRoutes } from './routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Where the Host attaches its chat gate; present while `@delorun/plugin-packs` is mounted. */
    delorunChatGate: ChatGateSlot
    /** Overrides the environment read from the process; a specification provides it. */
    packsEnvironment: PacksEnvironment | { readonly unsupported: string }
    /** Resolves an installed pack to the spec the plugin manager installs; read by the plugin manager's official installs. */
    packInstallTargets: PackInstallTargets
  }
}

/** The slot `delorun`'s Host fills with its chat gate. */
export interface ChatGateSlot {
  /**
   * Attach the gate.
   * @param gate - the Host's chat gate.
   * @returns the detach function.
   */
  attach(gate: Pick<ChatGate, 'running'>): () => void
  /**
   * The chats running now.
   * @returns their number, 0 while no gate is attached.
   */
  running(): number
  /** Tell the plugin a chat ended; the Host calls it when a counted chat settles. */
  chatEnded(): void
  /**
   * Follow chat ends.
   * @param listener - called after each {@link chatEnded}.
   * @returns the unsubscribe function.
   */
  onChatEnded(listener: () => void): () => void
}

/** The pack install targets the plugin manager asks. */
export interface PackInstallTargets {
  /**
   * The spec for an installed pack.
   * @param name - the package name.
   * @param version - the running Delorun version.
   * @returns the `link:` spec and version, or `undefined` when the pack is not installed here.
   */
  resolve(name: string, version: string): { readonly spec: string, readonly version: string } | undefined
  /**
   * The only spec through which a pack may be installed.
   * @param name - the package name.
   * @returns the `link:` spec through `packs/current`, or `undefined` before the release is known.
   */
  linkSpec(name: string): string | undefined
  /**
   * Whether the release's packs file lists a package, as far as it is known now.
   * @param name - the package name.
   * @returns whether it is a pack; `undefined` before the file was read.
   */
  listed(name: string): boolean | undefined
  /**
   * Whether this Host still runs the release `runtimes/current` names, which an update switches away from.
   * @returns false once an update switched; a pack installed then would be linked through `packs/current` to another release.
   */
  runsCurrentRelease(): Promise<boolean>
  /**
   * Whether the release's packs file lists a package, waiting for the file to be read.
   * @param name - the package name.
   * @returns whether it is a pack.
   */
  isPack(name: string): Promise<boolean>
}

/**
 * A failure as the Host's log states it: the message and its causes, which name the address that failed.
 * @param error - what the install raised.
 * @returns the message followed by each cause's message.
 */
function describeFailure(error: unknown): string {
  const parts: string[] = []
  for (let current: unknown = error; current !== undefined && parts.length < 4; current = (current as { cause?: unknown }).cause) {
    parts.push(current instanceof Error ? current.message : String(current))
  }
  return parts.join(' <- ')
}

/** The plugin's name in the loader's diagnostics. */
export const name = 'packs'

/** The plugin's configuration. */
export interface Config {
  /** How many pack downloads and installs run at once; at least 1. */
  readonly concurrency: number
  /** Seconds a pack download may receive nothing before it fails; a download that keeps receiving is never cut off. At least 1. */
  readonly stallSeconds: number
  /** The least time between two progress reports of one download, in milliseconds, so a large download does not rewrite the install list and every device's view at each piece. */
  readonly progressIntervalMs: number
}

/** The plugin's configuration schema. */
export const Config: z<Config> = z.object({
  concurrency: z.number().step(1).min(1).default(2),
  stallSeconds: z.number().min(1).default(DEFAULT_STALL_SECONDS),
  progressIntervalMs: z.number().min(0).default(500),
})

/** No required services: a profile without the plugin manager still mounts the plugin and lists no packs. */
export const inject = []

class ChatGateService extends Service implements ChatGateSlot {
  private readonly listeners = new Set<() => void>()
  private gate: Pick<ChatGate, 'running'> | undefined

  constructor(ctx: Context) {
    super(ctx, 'delorunChatGate')
  }

  attach(gate: Pick<ChatGate, 'running'>): () => void {
    this.gate = gate
    return () => { if (this.gate === gate) this.gate = undefined }
  }

  running(): number {
    return this.gate?.running() ?? 0
  }

  chatEnded(): void {
    for (const listener of this.listeners) listener()
  }

  onChatEnded(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/**
 * Mount the queue, the routes and the slots.
 * @param ctx - the Host context.
 * @param config - the validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ChatGateService)
  ctx.inject(['pluginManager', 'profileContext', 'connection', 'delorunChatGate'], (scope) => {
    const profile: ProfileContext = scope.profileContext
    const manager = scope.pluginManager
    const slot = scope.delorunChatGate
    void (async () => {
      const environment = scope.get('packsEnvironment') ?? await hostPacksEnvironment(process.env, { stallSeconds: config.stallSeconds })
      const hub = new PacksHub({
        environment,
        installBundle: (spec, options) => manager.installBundle(spec, { enabled: options.enabled, requestId: options.requestId as PluginInstallRequestId, expected: options.expected }),
        runningChats: () => slot.running(),
        reload: async () => {
          const outcome = await reloadProfile(scope.get('hmr'))
          if (!outcome.ok) throw new Error(outcome.error)
        },
        file: join(profile.home, 'run', profile.name, 'installs.json'),
        concurrency: config.concurrency,
        progressIntervalMs: config.progressIntervalMs,
        logFailure: (key, error) => { ctx.logger.warn(`${name}: installing ${key} failed: ${describeFailure(error)}`) },
        requestId: packRequestId,
      })
      scope.effect(() => slot.onChatEnded(() => { hub.chatsChanged() }))
      scope.provide('packInstallTargets', { resolve: (packName, version) => hub.installedTarget(packName, version), linkSpec: packName => hub.linkSpec(packName), listed: packName => hub.listed(packName), isPack: packName => hub.isPack(packName), runsCurrentRelease: () => hub.runsCurrentRelease() })
      // Each listed item is announced on the plugin manager's install-state under its request id, as an install of Plugins is.
      scope.effect(() => hub.subscribe((snapshot) => {
        for (const item of snapshot.queue) scope.emit('plugin-manager/install-state', { requestId: packRequestId(item.key) as PluginInstallRequestId, phase: item.state === 'ready' || item.state === 'needs-reload' ? 'applying' : 'installing' })
      }))
      registerPackRoutes(scope, hub)
    })()
  })
}
