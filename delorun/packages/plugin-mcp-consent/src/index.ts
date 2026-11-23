/**
 * @delorun/plugin-mcp-consent: the `mcpAddConsent` provider of Delorun's MCP
 * add-time consent. A stdio MCP server command runs as a local child process
 * outside the agent sandbox, so before such a server starts, the mcp-client
 * plugin asks the mounted `mcpAddConsent` service ([`McpAddConsent`] of
 * `@deepseek-ai/dsh-mcp-client`) whether the configured start is granted.
 * This plugin's service answers from the acceptance store, the JSON file under
 * the home's protected state ([`./store.ts`](./store.ts)), which holds one
 * acceptance per configured server name: a server whose acceptance covers
 * exactly the command, arguments, working directory and configured
 * environment under review, and the absolute executable path, canonical
 * working directory and, on Windows, command shell the mcp-client resolved them
 * to, starts at once, and every other review — a server never accepted, a
 * changed command, argument list, working directory or environment, a start
 * that now resolves to another executable, directory or command shell, a
 * store that is missing, unreadable or not this version's format —
 * holds the server stopped and asks the person to accept the start, which the
 * service records with {@link DelorunMcpConsent.accept}.
 * Different server names never share an acceptance.
 *
 * The module declares itself an `mcpAddConsent` provider
 * ({@link providesMcpAddConsent}), so an mcp-client row waits for this row
 * whatever the order in which the loader starts them. Every registration sits
 * behind the C16 switch `mcp_add_consent` ({@link Config.enabled}), off by
 * default: off, or without a mounted provider, an mcp-client starts every
 * configured server exactly as upstream does.
 * @module @delorun/plugin-mcp-consent
 */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// The ctx.loader merge, read to start a server row again, and the type of its rows.
import type { Entry as LoaderEntry } from '@deepseek-ai/cordis-plugin-loader'
import { McpAddConsent } from '@deepseek-ai/dsh-mcp-client'
import { resolveServerStart } from '@deepseek-ai/dsh-mcp-client/server-start'
import type { McpConsentDecision, McpServerCommand, StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import schema from '@deepseek-ai/schemastery'
// Type-only: the ctx.workspaceRegistry merge, read for the places a chat can write.
import type {} from '@deepseek-ai/dsh-workspace'
// Declares `ctx.mcpManager`, whose servers a refusal stopped start again on acceptance.
import type {} from '@deepseek-ai/dsh-mcp-manager'
import { resolveDelorunHome } from '@delorun/home'
import {
  acceptanceIdOf,
  acceptanceCovers,
  acceptanceOfStart,
  acceptanceStorePath,
  acceptedStartDigest,
  changeOf,
  EMPTY_ACCEPTANCE_STORE,
  envDigests,
  filesChangeOf,
  readAcceptanceStore,
  startDigest,
  withAcceptanceStoreLock,
  writeAcceptanceStore,
} from './store.ts'
import type { AcceptanceStore, AcceptanceStoreRead, SetAsideState } from './store.ts'
import { acceptHint, McpReviewError, pendingReviewOf, showsEnvValue, type McpReviews, type PendingReview, type RefusedStart } from './review.ts'
import { changedPin, pinsOf, spawnArgsOf, type PinnedStart } from './pins.ts'
import { chatWritableRoots, writableByChats } from './writable.ts'
import { asksFor, MCP_ASK_MODES, originKey, type AcceptedServer, type EnvVariable, type McpAskMode, type PendingServer, type PinnedFile, type ServerOrigin } from './wire.ts'
import { readRowSources } from './layers.ts'
import { originOf } from './origin.ts'
import type { ComputerOnlySwitch } from '@delorun/home-auth'
import { registerMcpConsentRoutes } from './routes.ts'

export { readRowSources, rowsOfPatches, type DelorunPackLayers, type LayerKind, type LayerSource, type RowLayer, type RowSources } from './layers.ts'
export {
  acceptHint, mcpReviewId, MCP_REVIEW_ID_LENGTH, MCP_REVIEW_ID_PATTERN, McpReviewError, pendingReviewOf, shownEnv, showsEnvValue,
  type McpReviews, type PendingReview, type RefusedStart,
} from './review.ts'
export {
  MAX_MCP_CONSENT_REQUEST_BYTES, MCP_CONSENT_REFUSAL_CODES, MCP_CONSENT_ROUTES, SERVER_CHANGES, SERVER_NAME_PATTERN, SERVER_STATES,
  type AcceptServerAnswer, type PinnedFile, type AcceptServerRequest, type AcceptedServer, type DeclineServerAnswer,
  type DeclineServerRequest, type EnvVariable, type McpConsentRefusalCode, type PendingServer, type PendingServersAnswer,
  type RevokeServerAnswer, type RevokeServerRequest, type ServerChange, type ServerState,
} from './wire.ts'

/** The plugin's name in the loader's diagnostics. */
export const name = 'mcp-consent'

/**
 * The declaration, under the mcp-client's `MCP_ADD_CONSENT_PROVIDER_EXPORT` name, that this plugin's row may register
 * the `mcpAddConsent` service: an mcp-client row whose start finds no service yet waits until this row has started,
 * so a server never starts unreviewed because its row started first.
 */
export const providesMcpAddConsent = true

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `mcp_add_consent`: whether the plugin registers the
   * `mcpAddConsent` service, whose review a stdio MCP server command waits
   * for at every boot. Off, the parity value and the default, the plugin
   * registers nothing and every configured server starts exactly as upstream
   * starts it. Delorun's composition turns it on.
   */
  readonly enabled: boolean
  /**
   * Which stdio servers wait for the person before they start (A631): `outside`, the default, only servers from outside
   * the person's own configuration and Delorun's packs; `always` every server; `never` none. A setting only the home's
   * own computer changes.
   */
  readonly ask: McpAskMode
}

/** Validated configuration. */
export const Config: schema<Config> = schema.object({
  enabled: schema.boolean().description('C16 switch mcp_add_consent: review the command of every stdio MCP server before it starts.').default(false),
  ask: schema.union(MCP_ASK_MODES).description('Which MCP servers ask first: outside (servers from other plugins, an editor or an unknown place), always, or never.').default('outside'),
})

/** The consent row's settings as switches only the home's own computer changes: turning the consent off, and the ask mode. */
export const MCP_CONSENT_SWITCHES: readonly ComputerOnlySwitch[] = [
  Object.freeze({ ns: 'delorun-mcp-consent', field: 'enabled', label: 'the MCP server consent' }),
  Object.freeze({ ns: 'delorun-mcp-consent', field: 'ask', label: 'which MCP servers ask first' }),
]

/** A Loader row configured as a stdio server, with its server name and configured environment. */
interface ServerRow {
  readonly id: string
  readonly serverName: string
  readonly env: Readonly<Record<string, string>>
  readonly fiber: NonNullable<LoaderEntry['fiber']>
}

/**
 * The `mcpAddConsent` provider: the add-time consent that answers from the
 * acceptance store. The review never waits for a person — it answers at once,
 * allowing a start the store holds the server name's acceptance of and
 * refusing every other start with the reason that asks the person to accept
 * it, so a boot never hangs on an unanswered question. A refusal repeats at
 * every boot of the server row until the start is accepted, and an acceptance
 * given after a refusal lets the next boot start the server.
 */
export class DelorunMcpConsent extends McpAddConsent implements McpReviews {
  /**
   * The changes to the store, chained so this service's changes run in order; each also holds the store's lock file,
   * which keeps another profile's process from interleaving.
   */
  private queue: Promise<unknown> = Promise.resolve()
  /** The latest refused review of each server name, until the person accepts it or a review allows the server. */
  private readonly reviews = new Map<string, PendingReview>()
  /** Which servers ask first, from the row's `ask`. */
  private readonly config: Pick<Config, 'ask'>

  /**
   * @param ctx - the plugin context.
   * @param config - the row's ask mode; `outside` when a test mounts the class without one.
   */
  constructor(ctx: Context, config: Pick<Config, 'ask'> = { ask: 'outside' }) {
    super(ctx)
    this.config = config
    // The pending reviews under a name of their own, for the home process's `mcp.*` operations and the studio's routes.
    ctx.provide('mcpReviews', this)
  }

  /**
   * Decide one configured server start from the acceptance store. The
   * person's home is resolved for every review, so a review reads the store
   * of the home the process runs with.
   * @param command - the server start under review: the namespace, the
   *   executable, its arguments, its working directory, its configured
   *   environment, and the absolute executable path, command shell and
   *   canonical working directory the mcp-client resolved them to.
   * @returns `allow: true` when the store holds an acceptance for this server
   *   name of exactly this command, these arguments, this working directory,
   *   these resolved paths, this environment, whatever order the
   *   environment's keys were written in, and these pinned files, with the
   *   canonical path of the pinned executable as the `spawnCommand`, so a
   *   symbolic link retargeted after the review does not change the file that
   *   runs, the arguments with each pinned file written by its canonical path,
   *   and a `verify` that pins the files again for the mcp-client to run just
   *   before it spawns the server; and `allow: false` with the reason it
   *   does not — the server is not accepted, its start or what it resolves to
   *   differs from its acceptance, the person set this
   *   start aside, or the store is missing, unreadable or not this version's
   *   format, which asks the person again. No reason names an
   *   environment value.
   */
  async review(command: McpServerCommand, client?: Context): Promise<McpConsentDecision> {
    // The row sources are read for each review, so a hot reload that changed the profile's layers counts at once.
    const origin = client === undefined ? UNKNOWN_ORIGIN : originOf(client, command.serverName, this.ctx.get('mcpManager'), await readRowSources(this.ctx))
    if (!asksFor(origin, this.config.ask)) {
      this.reviews.delete(command.serverName)
      return { allow: true }
    }
    const { start, verdict } = await this.judge(command, origin)
    if (verdict.allow) {
      this.reviews.delete(command.serverName)
      return { allow: true, spawnCommand: verdict.spawnCommand, spawnArgs: await spawnArgsOf(start), verify: () => changedPin(start.files) }
    }
    if (verdict.staleSetAside) await this.clearSetAside(command.serverName, verdict.staleSetAside)
    this.reviews.set(command.serverName, pendingReviewOf(start, verdict.refused, Date.now(), await this.chatWritablePaths(start), origin))
    return { allow: false, reason: `${verdict.refused.reason}${acceptHint(command.serverName)}` }
  }

  /**
   * The accepted starts the store holds, one per server name. A run-affecting variable's value
   * ({@link showsEnvValue}) is shown when the server's configured row sets the value the acceptance holds the digest of.
   * @returns them sorted by server name; none while no store exists or it cannot be read as this version's format.
   */
  async accepted(): Promise<readonly AcceptedServer[]> {
    let read: AcceptanceStoreRead
    try {
      read = await readAcceptanceStore(await this.path())
    } catch (error) {
      // A home that cannot be resolved holds no acceptance this service can show; every review says so.
      this.ctx.logger.warn(`mcp-consent: the accepted servers cannot be listed: ${reasonOf(error)}`)
      return []
    }
    if (read.kind !== 'readable') return []
    const rows = this.serverRows()
    return [...read.store.acceptances].sort(([left], [right]) => Number(left > right) - Number(left < right)).map(([serverName, accepted]) => {
      const row = rows.find(entry => entry.serverName === serverName)
      const configured = row === undefined ? {} : envDigests(row.env)
      const env = Object.keys(accepted.env).sort().map((name): EnvVariable => {
        const value = row?.env[name]
        return showsEnvValue(name) && value !== undefined && configured[name] === accepted.env[name] ? { name, value } : { name }
      })
      return {
        acceptanceId: acceptanceIdOf(serverName, accepted),
        serverName,
        command: accepted.command,
        args: [...accepted.args],
        cwd: accepted.cwd,
        resolvedCommand: accepted.resolvedCommand,
        resolvedCwd: accepted.resolvedCwd,
        ...accepted.resolvedShell === undefined ? {} : { resolvedShell: accepted.resolvedShell },
        env,
        files: accepted.files.map(file => ({ ...file })),
        acceptedAt: accepted.acceptedAt,
        configured: row !== undefined,
      }
    })
  }

  /**
   * Withdraw one acceptance at the home's own computer, after the person chose to; the route that calls this refuses
   * every other caller first. The store drops the server name's acceptance and records its start as revoked, and every
   * running Loader row configured for the server starts again with its own configuration, so its review refuses it as
   * `revoked` and the server stops until its start changes or the person accepts it again. Another server name's
   * acceptance, of the same command or not, is unchanged.
   * @param acceptanceId - the acceptance id the list showed.
   * @param confirmed - whether the person chose to revoke.
   * @returns how many running rows were stopped.
   * @throws {McpReviewError} `UNCONFIRMED` without the answer, `STALE_REVIEW` when no acceptance has the id, and
   *   `STORE_REFUSED` when the store cannot be read or written; each records nothing.
   */
  async revokeAcceptance(acceptanceId: string, confirmed: boolean): Promise<{ readonly stopped: number }> {
    if (!confirmed) throw new McpReviewError('UNCONFIRMED', 'the person has not confirmed the revoke, so nothing is changed')
    const path = await this.storePath()
    const serverName = await this.serial(() => withAcceptanceStoreLock(path, async () => {
      const read = await readAcceptanceStore(path)
      if (read.kind === 'refused') throw new McpReviewError('STORE_REFUSED', `the acceptance store cannot be read: ${read.problem}`)
      const store = read.kind === 'readable' ? read.store : EMPTY_ACCEPTANCE_STORE
      const found = [...store.acceptances].find(([name, accepted]) => acceptanceIdOf(name, accepted) === acceptanceId)
      if (found === undefined) throw new McpReviewError('STALE_REVIEW', 'this acceptance changed after it was shown; look at the list again')
      const [name, accepted] = found
      const acceptances = new Map(store.acceptances)
      acceptances.delete(name)
      const setAside = new Map(store.setAside).set(name, { state: 'revoked', start: acceptedStartDigest(accepted) })
      await writeAcceptanceStore(path, { ...store, acceptances, setAside })
      return name
    })).catch((error: unknown) => {
      // The store's lock not freed in time, or a write that failed, records nothing.
      throw error instanceof McpReviewError ? error : new McpReviewError('STORE_REFUSED', reasonOf(error), { cause: error })
    })
    this.ctx.logger.info(`mcp-consent: the person revoked the accepted start of the stdio server ${serverName} at the home's computer`)
    let stopped = 0
    for (const row of this.serverRows().filter(entry => entry.serverName === serverName)) {
      // `update` with the row's own configuration applies the row again, so its review refuses the start; nothing is saved.
      const failure = await Promise.resolve().then(() => row.fiber.update(row.fiber.config, true)).then(() => row.fiber.await()).then(() => undefined, (error: unknown) => error)
      if (refusedServer(failure) === row.serverName) stopped++
      else this.ctx.logger.warn(`mcp-consent: the row ${row.id} did not stop after its acceptance was revoked${failure === undefined ? '' : `: ${reasonOf(failure)}`}`)
    }
    return { stopped }
  }

  /**
   * The servers whose latest review the consent refused: one per server name, the latest, so a start that changed
   * after a review replaces that review. A review the person declined, or a server whose acceptance the person revoked,
   * stays listed in its state. The list lives in this process; each start of a server row reviews it again, and the
   * store keeps the declined and revoked starts across restarts.
   * @returns the pending reviews as a surface shows them, sorted by server name; a value only of a run-affecting
   *   environment variable.
   */
  pending(): readonly PendingServer[] {
    return [...this.reviews.values()].map(review => review.shown).sort((left, right) => (left.serverName < right.serverName ? -1 : 1))
  }

  /**
   * Accept one pending review, in any state, at the home's own computer, after the person confirmed the start it
   * shows; the route and the update channel that call this refuse every other caller first. The start's configured
   * command and working directory are resolved again first: when they now resolve to another executable, working
   * directory or command shell than the review showed, or no longer resolve, nothing is accepted, and a start that
   * resolves elsewhere is reviewed again, so the list shows its new paths under a new review id. Otherwise the start
   * is recorded as the server name's acceptance exactly as the review showed it ({@link accept}), the review leaves the
   * list, and each server row this consent refused for that server name is started again, so the server runs without a
   * restart of the studio.
   * @param serverName - the server the person answered for.
   * @param reviewId - the id of the review the person was shown.
   * @param confirmed - whether the person confirmed the start.
   * @returns how many refused server rows started again; a row that fails again stays stopped with its own error.
   * @throws {McpReviewError} `UNCONFIRMED` without the answer, `STALE_REVIEW` when the server has no pending review with
   *   that id or its start now resolves to other paths than the review showed, and `STORE_REFUSED` when the shown start
   *   holds a resolved path that is not absolute or the store cannot be written; each records nothing.
   */
  async acceptReview(serverName: string, reviewId: string, confirmed: boolean): Promise<{ readonly started: number }> {
    if (!confirmed) throw new McpReviewError('UNCONFIRMED', 'the person has not confirmed the server\'s start, so nothing is accepted')
    const review = this.pendingReview(serverName, reviewId)
    try {
      assertAcceptable(review.start)
    } catch (error) {
      throw new McpReviewError('STORE_REFUSED', reasonOf(error), { cause: error })
    }
    await this.refuseMoved(review.start)
    try {
      await this.accept(review.start, review.start.files, review.shown.origin)
    } catch (error) {
      throw new McpReviewError('STORE_REFUSED', reasonOf(error), { cause: error })
    }
    if (this.reviews.get(serverName) === review) this.reviews.delete(serverName)
    this.ctx.logger.info(`mcp-consent: the person accepted the start of the stdio server ${serverName} at the home's computer`)
    await this.ctx.parallel('mcp-client/consent-accepted', serverName)
    return { started: await this.startRefusedRows(serverName) }
  }

  /**
   * Set one pending review aside at the home's own computer: the server stays stopped, the review stays listed as
   * `declined`, and the store records the start as declined, so a restart of the studio reviews it as `declined` again
   * until the server's start changes or the person accepts it. While the store cannot be read or written the review is
   * set aside in this process only, and the warning says so.
   * @param serverName - the server the person answered for.
   * @param reviewId - the id of the review the person was shown.
   * @returns when the review is set aside.
   * @throws {McpReviewError} `STALE_REVIEW` when the server has no pending review with that id.
   */
  async declineReview(serverName: string, reviewId: string): Promise<void> {
    const review = this.pendingReview(serverName, reviewId)
    this.reviews.set(serverName, { ...review, shown: { ...review.shown, state: 'declined', reason: SET_ASIDE_REASONS.declined } })
    try {
      await this.setAside(serverName, 'declined', startDigest(review.start))
    } catch (error) {
      this.ctx.logger.warn(`mcp-consent: the declined start of the stdio server ${serverName} is not recorded, so it waits for an answer again after a restart: ${reasonOf(error)}`)
    }
    this.ctx.logger.info(`mcp-consent: the person declined the start of the stdio server ${serverName}; it stays stopped`)
  }

  /**
   * Record that the person accepted a server start, as the server name's acceptance the reviews allow. Accepting a
   * changed start of the server replaces its earlier acceptance; another server name's acceptance is unchanged. The
   * acceptance clears the server's declined or revoked start.
   * @param start - the start the person accepted, as a review was shown it: the server name, the executable, its
   *   arguments in order, its working directory, its configured environment, of which the store keeps each variable's
   *   name and value digest, and the absolute executable path, command shell and working directory they resolved to.
   * @param files - the files the review pinned; omitted, the files the start runs are pinned now.
   * @param origin - where the accepted server's definition lives ({@link originKey}); the acceptance covers the server
   *   name from that origin only. Omitted, the origin is `unknown`.
   * @returns when the store holds the acceptance.
   * @throws when the command is empty or a resolved path is not absolute, which no review is shown, when a file the
   *   start runs cannot be pinned, or when the store cannot be read as this version's format or written.
   */
  accept(start: McpServerCommand, files?: readonly PinnedFile[], origin: ServerOrigin = UNKNOWN_ORIGIN): Promise<void> {
    return this.serial(async () => {
      assertAcceptable(start)
      const pinned: PinnedStart = { ...start, files: files ?? await pinsOf(start) }
      const path = await this.path()
      await withAcceptanceStoreLock(path, async () => {
        const store = await this.writableStore(path)
        const acceptances = new Map(store.acceptances).set(start.serverName, acceptanceOfStart(pinned, Date.now(), originKey(origin)))
        const setAside = new Map(store.setAside)
        setAside.delete(start.serverName)
        await writeAcceptanceStore(path, { acceptances, setAside })
      })
    })
  }

  /**
   * Refuse an answer to a review whose start no longer resolves to the paths, or runs the file contents, the review
   * showed. The configured start is resolved as the mcp-client resolves it before a review and its files are pinned
   * again; a start that resolves elsewhere or runs other contents is reviewed again, which replaces the pending review
   * with one that shows the new paths and files.
   * @param shown - the start the review showed, with the files it pinned.
   * @returns when the start still resolves to the shown paths and its files hold the shown contents.
   * @throws {McpReviewError} `STALE_REVIEW` when the start resolves to another executable, working directory or command
   *   shell, a file it runs differs from the pinned one, or the start or a file cannot be resolved or read.
   */
  private async refuseMoved(shown: PinnedStart): Promise<void> {
    let current: McpServerCommand
    let files: readonly PinnedFile[]
    try {
      current = await resolveServerStart(stdioConfigOf(shown))
      files = await pinsOf(current)
    } catch (error) {
      throw new McpReviewError('STALE_REVIEW', `the start of the server ${shown.serverName} no longer resolves or reads as it was shown, so nothing is accepted: ${reasonOf(error)}`, { cause: error })
    }
    const samePaths = current.resolvedCommand === shown.resolvedCommand && current.resolvedCwd === shown.resolvedCwd && current.resolvedShell === shown.resolvedShell
    if (samePaths && filesChangeOf(shown.files, files) === undefined) return
    await this.review(current)
    throw new McpReviewError('STALE_REVIEW', `the server ${shown.serverName} now resolves to other paths or runs other file contents than this review showed, so nothing is accepted; look at its review again`)
  }

  /**
   * Record a server's start as set aside.
   * @param serverName - the server.
   * @param state - how the person set it aside.
   * @param start - {@link startDigest} of the start.
   * @returns when the store holds it.
   * @throws when the home cannot be resolved, or the store cannot be read or written.
   */
  private setAside(serverName: string, state: SetAsideState, start: string): Promise<void> {
    return this.serial(async () => {
      const path = await this.path()
      await withAcceptanceStoreLock(path, async () => {
        const store = await this.writableStore(path)
        await writeAcceptanceStore(path, { ...store, setAside: new Map(store.setAside).set(serverName, { state, start }) })
      })
    })
  }

  /**
   * Drop a server's set-aside start once a review found another start of the server, so the set-aside state holds
   * only until the start changes. A store that cannot be written keeps it, and the warning says so.
   * @param serverName - the server.
   * @param start - the digest of the set-aside start the review found.
   */
  private async clearSetAside(serverName: string, start: string): Promise<void> {
    try {
      await this.serial(async () => {
        const path = await this.path()
        await withAcceptanceStoreLock(path, async () => {
          const read = await readAcceptanceStore(path)
          if (read.kind !== 'readable' || read.store.setAside.get(serverName)?.start !== start) return
          const setAside = new Map(read.store.setAside)
          setAside.delete(serverName)
          await writeAcceptanceStore(path, { ...read.store, setAside })
        })
      })
    } catch (error) {
      this.ctx.logger.warn(`mcp-consent: the set-aside start of the stdio server ${serverName} could not be dropped: ${reasonOf(error)}`)
    }
  }

  /**
   * The store's content to change.
   * @param path - the store's path.
   * @returns the store, or an empty one when none exists.
   * @throws when the store exists but is not this version's format: changing a refused store would look
   *   like an answer the file cannot state, so the person fixes or removes the store first, and the review keeps
   *   asking until then.
   */
  private async writableStore(path: string): Promise<AcceptanceStore> {
    const read = await readAcceptanceStore(path)
    if (read.kind === 'refused') throw new Error(`the acceptance store is refused, so nothing is recorded: ${read.problem}`)
    return read.kind === 'readable' ? read.store : EMPTY_ACCEPTANCE_STORE
  }

  /**
   * The pending review an answer names.
   * @param serverName - the server.
   * @param reviewId - the review id the answer carries.
   * @returns the review.
   * @throws {McpReviewError} `STALE_REVIEW` when the server's pending review has another id, or it has none.
   */
  private pendingReview(serverName: string, reviewId: string): PendingReview {
    const review = this.reviews.get(serverName)
    if (review === undefined || review.shown.reviewId !== reviewId) {
      throw new McpReviewError('STALE_REVIEW', `the server ${serverName} has no pending review with this id: its start was reviewed again or accepted since it was shown`)
    }
    return review
  }

  /**
   * Review again every server this consent's predecessor left stopped, once the consent starts: a Loader row that failed
   * with a consent refusal and an MCP manager server whose start failed. A change of the ask mode restarts the consent,
   * so a server the new mode no longer asks for starts without a restart of the studio; one it still asks for is
   * refused again and listed. Failures are logged; each row keeps its own error.
   * @returns how many stopped servers started again.
   */
  async startRefused(): Promise<number> {
    const names = new Set<string>()
    for (const entry of this.ctx.get('loader')?.entries() ?? []) {
      const fiber = entry.fiber
      if (fiber === undefined || typeof Reflect.get(Object(fiber.config), 'serverName') !== 'string') continue
      const failure = await fiber.await().then(() => undefined, (error: unknown) => error)
      const refused = refusedServer(failure)
      if (refused !== undefined) names.add(refused)
    }
    for (const server of this.ctx.get('mcpManager')?.list() ?? []) {
      if (server.configured && server.status.state === 'failed' && server.status.reason === 'load') names.add(server.name)
    }
    let started = 0
    for (const name of names) started += await this.startRefusedRows(name)
    return started
  }

  /**
   * Start again the server of the same name that the MCP manager (Settings, or a plugin's registration) holds stopped
   * because its activation failed, now that its start is accepted. The manager mounts it again with its current entry,
   * so its next review judges the start as it is now and its tools register for every chat's next model request.
   * @param serverName - the accepted server.
   * @returns 1 when the manager started the server again, 0 otherwise.
   */
  private async startRefusedManaged(serverName: string): Promise<number> {
    const manager = this.ctx.get('mcpManager')
    const status = manager?.list().find(server => server.name === serverName && server.configured)?.status
    if (manager === undefined || status?.state !== 'failed' || status.reason !== 'load') return 0
    try {
      await manager.restart(serverName)
      return 1
    } catch (error) {
      this.ctx.logger.warn(`mcp-consent: the server ${serverName} was accepted, and the MCP manager did not start it again: ${reasonOf(error)}`)
      return 0
    }
  }

  /**
   * Start again every server row of the Loader that stopped because this consent refused the server's start, now that
   * the start is accepted: a row that failed with the refusal at its boot, and an active row of the server, whose
   * reconnect the refusal stopped. A row restarts with the configuration it has, so its next review judges its start as
   * it is now; without a Loader nothing restarts, and the next start of the studio starts the server.
   * @param serverName - the accepted server.
   * @returns how many rows became active.
   */
  private async startRefusedRows(serverName: string): Promise<number> {
    let started = 0
    for (const entry of this.ctx.get('loader')?.entries() ?? []) {
      const fiber = entry.fiber
      // Only a row configured for this server name is awaited: a refused row settled when it failed, so its wait ends
      // at once with the refusal, while another row may still be starting.
      if (fiber === undefined || !configuresServer(fiber.config, serverName)) continue
      const failure = await fiber.await().then(() => undefined, (error: unknown) => error)
      if (failure !== undefined && refusedServer(failure) !== serverName) continue
      try {
        // `update` with the row's own configuration clears the refusal and applies the row again; nothing is saved.
        await fiber.update(fiber.config, true)
        started++
      } catch (error) {
        this.ctx.logger.warn(`mcp-consent: the server ${serverName} was accepted, and its row ${entry.id} did not start again: ${reasonOf(error)}`)
      }
    }
    return started + await this.startRefusedManaged(serverName)
  }

  /**
   * The working directory and pinned files of a start that lie where this profile's chats can write.
   * @param start - the start under review, with its pinned files.
   * @returns the paths, the working directory first.
   */
  private async chatWritablePaths(start: PinnedStart): Promise<readonly string[]> {
    const workspaces = this.ctx.get('workspaceRegistry')?.list().map(workspace => workspace.path) ?? []
    return writableByChats([start.resolvedCwd, ...start.files.map(file => file.path)], await chatWritableRoots(workspaces))
  }

  /**
   * The Loader rows configured as stdio servers: a fiber whose configuration names a server and a command.
   * @returns each row with its server name and configured environment.
   */
  private serverRows(): readonly ServerRow[] {
    const rows: ServerRow[] = []
    for (const entry of this.ctx.get('loader')?.entries() ?? []) {
      const fiber = entry.fiber
      const config: unknown = fiber?.config
      if (fiber === undefined || typeof config !== 'object' || config === null || typeof Reflect.get(config, 'command') !== 'string') continue
      const serverName: unknown = Reflect.get(config, 'serverName')
      if (typeof serverName === 'string') rows.push({ id: entry.id, serverName, env: stringEntries(Reflect.get(config, 'env')), fiber })
    }
    return rows
  }

  /**
   * The store's path under the resolved home.
   * @returns the absolute path.
   * @throws the home resolution's refusal, when the home cannot be resolved.
   */
  private async path(): Promise<string> {
    const home = await resolveDelorunHome(process.env)
    return acceptanceStorePath(home.path)
  }

  /**
   * The store's path for an answer to the person.
   * @returns the absolute path.
   * @throws {McpReviewError} `STORE_REFUSED` when the home cannot be resolved.
   */
  private async storePath(): Promise<string> {
    try {
      return await this.path()
    } catch (error) {
      throw new McpReviewError('STORE_REFUSED', reasonOf(error), { cause: error })
    }
  }

  /**
   * Pin the files a start runs and answer its review from the store. A file that cannot be pinned refuses the start
   * with the change `contents` and no pinned file, so no acceptance covers it.
   * @param command - the server start under review.
   * @returns the start with its pinned files, and the decision.
   */
  private async judge(command: McpServerCommand, origin: ServerOrigin): Promise<{ readonly start: PinnedStart, readonly verdict: Verdict }> {
    let files: Awaited<ReturnType<typeof pinsOf>>
    try {
      files = await pinsOf(command)
    } catch (error) {
      const verdict = refusedWith('contents', `a file this server runs could not be read, so no acceptance covers it (${reasonOf(error)})`)
      return { start: { ...command, files: [] }, verdict }
    }
    const start: PinnedStart = { ...command, files }
    return { start, verdict: await this.decide(start, files[0].path, origin) }
  }

  /**
   * Answer one review from the store.
   * @param command - the server start under review, with the files it runs.
   * @param executable - the canonical path of its pinned executable, which an allowed start is spawned with.
   * @param origin - where the server's definition lives; only an acceptance that covers it counts.
   * @returns the decision.
   */
  private async decide(command: PinnedStart, executable: string, origin: ServerOrigin): Promise<Verdict> {
    let path: string
    try {
      path = await this.path()
    } catch (error) {
      return refusedWith('unreadable', `the Delorun home could not be resolved, so no acceptance can be read (${reasonOf(error)})`)
    }
    const read = await readAcceptanceStore(path)
    if (read.kind === 'absent') return refusedWith('new', 'no server is accepted yet (the acceptance store does not exist)')
    if (read.kind === 'refused') return refusedWith('unreadable', `the acceptance store could not be read, so nothing counts as accepted (${read.problem})`)
    const { store } = read
    const recorded = store.acceptances.get(command.serverName)
    // An acceptance given for the same name from another origin does not count: a plugin's server cannot use the
    // acceptance of the person's own server, or of a pack's, by naming itself after it.
    const accepted = recorded !== undefined && acceptanceCovers(recorded, originKey(origin)) ? recorded : undefined
    const change = accepted === undefined ? undefined : changeOf(accepted, command)
    if (accepted !== undefined && change === undefined) return { allow: true, spawnCommand: executable }
    const digest = startDigest(command)
    const setAside = store.setAside.get(command.serverName)
    if (setAside !== undefined && setAside.start === digest) return refusedWith(change?.part ?? 'new', SET_ASIDE_REASONS[setAside.state], setAside.state, change?.changedVariables)
    const verdict = change === undefined
      ? refusedWith('new', 'the acceptance store holds no acceptance for this server')
      : refusedWith(change.part, change.reason, 'waiting', change.changedVariables)
    return setAside === undefined ? verdict : { ...verdict, staleSetAside: setAside.start }
  }

  /**
   * Run a change to the store after the changes queued before it, whatever those did.
   * @param change - the change.
   * @returns the change's result.
   */
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.then(change, change)
    this.queue = next
    return next
  }
}

/** The reason a set-aside start is refused with, by how the person set it aside. */
const SET_ASIDE_REASONS: Readonly<Record<SetAsideState, string>> = {
  declined: 'the person declined this start; it stays stopped until its start changes or the person accepts it',
  revoked: 'the person revoked this server\'s acceptance; it stays stopped until its start changes or the person accepts it again',
}

/**
 * A refusal's verdict.
 * @param change - what the review asks about.
 * @param reason - why the consent refused the start.
 * @param state - where the review stands.
 * @param changedVariables - the variables that changed, for an `environment` change.
 * @returns the verdict.
 */
function refusedWith(change: RefusedStart['change'], reason: string, state: RefusedStart['state'] = 'waiting', changedVariables: readonly string[] = []): Refusal {
  return { allow: false, refused: { reason, change, changedVariables, state } }
}

/**
 * Refuse a start no review shows: an empty command, or a resolved executable path, working directory or command shell
 * that is not absolute.
 * @param start - the start to accept.
 * @throws {Error} naming which of the two it is.
 */
function assertAcceptable(start: McpServerCommand): void {
  if (start.command.length === 0) throw new Error('the command to accept is empty')
  const resolved = [start.resolvedCommand, start.resolvedCwd, ...start.resolvedShell === undefined ? [] : [start.resolvedShell]]
  if (!resolved.every(entry => isAbsolute(entry))) throw new Error('the start to accept holds a resolved path that is not absolute')
}

/**
 * The stdio configuration a shown start was resolved from, for {@link resolveServerStart}, which reads its server
 * name, command, environment and working directory; the call and close timeouts, template expansion and startup flag are not read.
 * @param start - the shown start.
 * @returns the configuration.
 */
function stdioConfigOf(start: McpServerCommand): StdioConfig {
  return {
    transport: 'stdio',
    serverName: start.serverName,
    command: start.command,
    args: [...start.args],
    env: { ...start.env },
    cwd: start.cwd,
    toolCallTimeoutMs: 0,
    closeTimeoutMs: 1,
    expandTemplates: false,
    failOnStartupError: true,
  }
}

/**
 * The string entries of a row's configured environment.
 * @param env - the row's `env` field as the Loader holds it.
 * @returns its string-valued entries; none when it is not an object.
 */
function stringEntries(env: unknown): Readonly<Record<string, string>> {
  if (typeof env !== 'object' || env === null) return {}
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/**
 * With the `mcp_add_consent` switch on: mount the consent service, whose
 * review the mcp-client plugin consults before it starts a stdio server, its
 * pending reviews as the `mcpReviews` service, and, where a Connection serves
 * the studio, the routes of the studio's Permissions section
 * ([`./routes.ts`](./routes.ts)). The
 * mount is the service's own plugin fiber, and the returned promise is this
 * plugin's startup work, so the service is registered before this row is
 * active; an mcp-client row waits for this row to settle
 * ({@link providesMcpAddConsent}). Off, register nothing, and the waiting
 * mcp-client rows start their servers as upstream does.
 * @param ctx - the plugin context.
 * @param config - the switch.
 */
/** The origin of a review that names no mcp-client context. */
const UNKNOWN_ORIGIN: ServerOrigin = Object.freeze({ kind: 'unknown' })

/**
 * Register the row's settings as computer-only switches with `@delorun/home-auth`, whose reach policy then refuses a
 * device's settings write to them: turning the consent off or changing which servers ask lets a server start unasked.
 * The registrations hold whatever `enabled` is, so a device cannot turn the consent off while it is off either.
 * @param ctx - the plugin's scope, which removes the registrations when it is disposed.
 */
function registerSwitches(ctx: Context): void {
  ctx.inject(['homeAuth'], (scope) => {
    for (const target of MCP_CONSENT_SWITCHES) scope.effect(() => scope.homeAuth.registerComputerOnlySwitch(target), `mcp-consent: computer-only ${target.field}`)
  })
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) {
    registerSwitches(ctx)
    return
  }
  registerSwitches(ctx)
  await ctx.plugin(DelorunMcpConsent, { ask: config.ask })
  // A changed ask mode restarts this row; the servers the previous mode left stopped are reviewed again under the new one.
  ctx.inject(['mcpReviews'], (child) => {
    const consent = child.get('mcpAddConsent')
    if (consent instanceof DelorunMcpConsent) void consent.startRefused().catch((error: unknown) => { child.logger.warn(`mcp-consent: the stopped servers were not reviewed again: ${reasonOf(error)}`) })
  })
  // The studio's routes, in a profile that serves a studio.
  ctx.inject(['connection', 'mcpReviews'], (child) => { registerMcpConsentRoutes(child, child.mcpReviews) })
}

/**
 * A review's outcome: the decision the mcp-client reads and, for a refusal, what a surface shows of it, with the
 * digest of a set-aside start of the server that this start no longer matches.
 */
type Verdict = { readonly allow: true, readonly spawnCommand: string } | Refusal

/** A refused review's verdict. */
type Refusal = { readonly allow: false, readonly refused: RefusedStart, readonly staleSetAside?: string }

/**
 * The server a row's failure is this consent's refusal of. The refusal is the mcp-client's `McpConsentRefusedError`,
 * read by its name and its server field rather than by its class, because the row may load the mcp-client from
 * another copy of the module than this plugin imports.
 * @param failure - what the row's fiber failed with.
 * @returns the refused server's name, or undefined for any other failure.
 */
function refusedServer(failure: unknown): string | undefined {
  if (!(failure instanceof Error) || failure.name !== 'McpConsentRefusedError') return undefined
  const serverName: unknown = Reflect.get(failure, 'serverName')
  return typeof serverName === 'string' ? serverName : undefined
}

/**
 * Whether a Loader row's raw configuration names a server.
 * @param config - the row's configuration as the Loader holds it.
 * @param serverName - the server.
 * @returns true for an object whose `serverName` is the server's.
 */
function configuresServer(config: unknown, serverName: string): boolean {
  return typeof config === 'object' && config !== null && Reflect.get(config, 'serverName') === serverName
}

/**
 * The reason a failure gives, in words that may reach the person through the refusal error.
 * @param error - the failure.
 * @returns the failure's message, or a plain one when it has none.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the home could not be resolved'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The add-time consent accepted one server's start. A provider that mounts the server per Session starts it again
     * in the live Sessions the refusal left without its tools; the consent is still checked at that start.
     * @param serverName - the accepted server.
     * @mode parallel
     */
    'mcp-client/consent-accepted'(serverName: string): void | Promise<void>
  }
}
