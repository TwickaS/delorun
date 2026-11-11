/**
 * @delo/plugin-mcp-consent: the `mcpAddConsent` provider of Delo's MCP
 * add-time consent. A stdio MCP server command runs as a local child process
 * outside the agent sandbox, so before such a server starts, the mcp-client
 * plugin asks the mounted `mcpAddConsent` service ([`McpAddConsent`] of
 * `@deepseek-ai/dsh-mcp-client`) whether the configured command is granted.
 * This plugin's service answers from the acceptance store, the JSON file under
 * the home's protected state ([`./store.ts`](./store.ts)): a command the
 * person accepted with exactly the arguments, working directory, resolved
 * executable path, command shell, resolved working directory and configured
 * environment under review starts at once, and every other review — an
 * unknown command, a changed argument list, working directory or environment,
 * a bare command that a PATH lookup now finds elsewhere, a Windows batch file
 * run through another `COMSPEC`, an empty or relative working
 * directory that now resolves elsewhere, a store that is missing, unreadable,
 * superseded or not this version's format — holds the server stopped and asks
 * the person to accept the command, which the service records with
 * {@link DeloMcpConsent.accept}.
 *
 * The module declares itself an `mcpAddConsent` provider
 * ({@link providesMcpAddConsent}), so an mcp-client row waits for this row
 * whatever the order in which the loader starts them. Every registration sits
 * behind the C16 switch `mcp_add_consent` ({@link Config.enabled}), off by
 * default: off, or without a mounted provider, an mcp-client starts every
 * configured server exactly as upstream does.
 * @module @delo/plugin-mcp-consent
 */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// The ctx.loader merge, read to start a server row again, and the type of its rows.
import type { Entry as LoaderEntry } from '@deepseek-ai/cordis-plugin-loader'
import { McpAddConsent } from '@deepseek-ai/dsh-mcp-client'
import type { McpConsentDecision, McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import schema from '@deepseek-ai/schemastery'
import { resolveDeloHome } from '@delo/home'
import {
  acceptanceOfStart,
  acceptanceStorePath,
  changedPartOf,
  mismatchOf,
  readAcceptanceStore,
  writeAcceptanceStore,
} from './store.ts'
import type { AcceptedCommand, ServerStart } from './store.ts'
import { acceptHint, McpReviewError, pendingReviewOf, type McpReviews, type PendingReview } from './review.ts'
import type { AcceptedServer, PendingServer, ServerChange } from './wire.ts'
import { registerMcpConsentRoutes } from './routes.ts'

export { acceptHint, mcpReviewId, MCP_REVIEW_ID_LENGTH, MCP_REVIEW_ID_PATTERN, McpReviewError, pendingReviewOf, type McpReviews, type PendingReview } from './review.ts'
export {
  MAX_MCP_CONSENT_REQUEST_BYTES, MCP_CONSENT_REFUSAL_CODES, MCP_CONSENT_ROUTES, SERVER_NAME_PATTERN,
  type AcceptServerAnswer, type AcceptServerRequest, type DeclineServerAnswer, type DeclineServerRequest,
  type AcceptedServer, type McpConsentRefusalCode, type PendingServer, type PendingServersAnswer, type RevokeServerAnswer,
  type RevokeServerRequest, type ServerChange, SERVER_CHANGES,
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
   * starts it. Delo's composition turns it on.
   */
  readonly enabled: boolean
}

/** Validated configuration. */
export const Config: schema<Config> = schema.object({
  enabled: schema.boolean().description('C16 switch mcp_add_consent: review the command of every stdio MCP server before it starts.').default(false),
})

/**
 * The `mcpAddConsent` provider: the add-time consent that answers from the
 * acceptance store. The review never waits for a person — it answers at once,
 * allowing a command the store holds an acceptance for and refusing every
 * other command with the reason that asks the person to accept it, so a boot
 * never hangs on an unanswered question. A refusal repeats at every boot of
 * the server row until the command is accepted, and an acceptance given after
 * a refusal lets the next boot start the server.
 */
export class DeloMcpConsent extends McpAddConsent implements McpReviews {
  /** The writes to the store, chained so a grant and a review's write never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  /** The latest refused review of each server name, until the person answers it or a review allows the server. */
  private readonly reviews = new Map<string, PendingReview>()

  /**
   * @param ctx - the plugin context.
   */
  constructor(ctx: Context) {
    super(ctx)
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
   * @returns `allow: true` when the store holds an acceptance of this
   *   command with exactly these arguments, this working directory, this
   *   resolved executable path, command shell and working directory, and
   *   this environment,
   *   whatever order the environment's keys were written in, and
   *   `allow: false` with the reason it does not — the command, its
   *   arguments, its working directory, what they resolve to or its
   *   environment are not accepted, or the store is missing, unreadable,
   *   superseded or not this version's format, which asks the person again.
   *   No reason names an environment value.
   */
  async review(command: McpServerCommand): Promise<McpConsentDecision> {
    const verdict = await this.decide(command)
    if (verdict.allow) {
      this.reviews.delete(command.serverName)
      return { allow: true }
    }
    this.reviews.set(command.serverName, pendingReviewOf(command, verdict.reason, verdict.change, Date.now()))
    return { allow: false, reason: `${verdict.reason}${acceptHint(command.serverName)}` }
  }

  /**
   * The accepted starts the store holds, each with the configured servers of the Loader that start its command.
   * @returns them sorted by command; none while no store exists or it cannot be read as this version's format.
   */
  async accepted(): Promise<readonly AcceptedServer[]> {
    let read: Awaited<ReturnType<typeof readAcceptanceStore>>
    try {
      read = await readAcceptanceStore(await this.path())
    } catch (error) {
      // A home that cannot be resolved holds no acceptance this service can show; every review says so.
      this.ctx.logger.warn(`mcp-consent: the accepted servers cannot be listed: ${reasonOf(error)}`)
      return []
    }
    if (read.kind !== 'readable') return []
    return [...read.entries].sort(([left], [right]) => (left < right ? -1 : 1)).map(([command, accepted]) => ({
      command,
      args: [...accepted.args],
      cwd: accepted.cwd,
      envNames: [...accepted.envNames],
      acceptedAt: accepted.acceptedAt,
      servers: this.rowsStarting(command).map(row => row.serverName).sort(),
    }))
  }

  /**
   * Withdraw one acceptance at the home's own computer, after the person chose to; the route that calls this refuses
   * every other caller first. The store drops the command's acceptance, and every running Loader row that starts the
   * command starts again with its own configuration, so its review refuses it and the server stops until the person
   * accepts it again.
   * @param command - the accepted command, as the list showed it.
   * @param acceptedAt - the acceptance time the list showed.
   * @param confirmed - whether the person chose to revoke.
   * @returns how many running rows were stopped.
   * @throws {McpReviewError} `UNCONFIRMED` without the answer, `STALE_REVIEW` when the store no longer holds that
   *   acceptance, and `STORE_REFUSED` when the store cannot be read or written; each records nothing.
   */
  async revokeAcceptance(command: string, acceptedAt: number, confirmed: boolean): Promise<{ readonly stopped: number }> {
    if (!confirmed) throw new McpReviewError('UNCONFIRMED', 'the person has not confirmed the revoke, so nothing is changed')
    await this.serial(async () => {
      let path: string
      try {
        path = await this.path()
      } catch (error) {
        throw new McpReviewError('STORE_REFUSED', reasonOf(error), { cause: error })
      }
      const read = await readAcceptanceStore(path)
      if (read.kind === 'refused') throw new McpReviewError('STORE_REFUSED', `the acceptance store cannot be read: ${read.problem}`)
      const entries = read.kind === 'readable' ? new Map(read.entries) : new Map<string, AcceptedCommand>()
      if (entries.get(command)?.acceptedAt !== acceptedAt) {
        throw new McpReviewError('STALE_REVIEW', 'this acceptance changed after it was shown; look at the list again')
      }
      entries.delete(command)
      try {
        await writeAcceptanceStore(path, entries)
      } catch (error) {
        throw new McpReviewError('STORE_REFUSED', reasonOf(error), { cause: error })
      }
    })
    this.ctx.logger.info('mcp-consent: the person revoked one accepted stdio server command at the home\'s computer')
    let stopped = 0
    for (const row of this.rowsStarting(command)) {
      // `update` with the row's own configuration applies the row again, so its review refuses the start; nothing is saved.
      const failure = await Promise.resolve().then(() => row.fiber.update(row.fiber.config, true)).then(() => row.fiber.await()).then(() => undefined, (error: unknown) => error)
      if (refusedServer(failure) === row.serverName) stopped++
      else this.ctx.logger.warn(`mcp-consent: the row ${row.id} did not stop after its acceptance was revoked${failure === undefined ? '' : `: ${reasonOf(failure)}`}`)
    }
    return { stopped }
  }

  /**
   * The servers whose latest review the consent refused and the person has not answered yet: one per server name, the
   * latest, so a start that changed after a review replaces that review. The list lives in this process; each start of
   * a server row reviews it again.
   * @returns the pending reviews as a surface shows them, sorted by server name; none names an environment value.
   */
  pending(): readonly PendingServer[] {
    return [...this.reviews.values()].map(review => review.shown).sort((left, right) => (left.serverName < right.serverName ? -1 : 1))
  }

  /**
   * Accept one pending review at the home's own computer, after the person confirmed the start it shows; the route and
   * the update channel that call this refuse every other caller first. The start is recorded exactly as the review
   * judged it ({@link accept}), the review leaves the list, and each server row this consent refused for that server
   * name is started again, so the server runs without a restart of the studio.
   * @param serverName - the server the person answered for.
   * @param reviewId - the id of the review the person was shown.
   * @param confirmed - whether the person confirmed the start.
   * @returns how many refused server rows started again; a row that fails again stays stopped with its own error.
   * @throws {McpReviewError} `UNCONFIRMED` without the answer, `STALE_REVIEW` when the server has no pending review with
   *   that id, and `STORE_REFUSED` when the store cannot be written; each records nothing.
   */
  async acceptReview(serverName: string, reviewId: string, confirmed: boolean): Promise<{ readonly started: number }> {
    if (!confirmed) throw new McpReviewError('UNCONFIRMED', 'the person has not confirmed the server\'s start, so nothing is accepted')
    const review = this.pendingReview(serverName, reviewId)
    try {
      await this.accept(review.start)
    } catch (error) {
      throw new McpReviewError('STORE_REFUSED', reasonOf(error), { cause: error })
    }
    if (this.reviews.get(serverName) === review) this.reviews.delete(serverName)
    this.ctx.logger.info(`mcp-consent: the person accepted the start of the stdio server ${serverName} at the home's computer`)
    return { started: await this.startRefusedRows(serverName) }
  }

  /**
   * Set one pending review aside at the home's own computer: the server stays stopped, nothing is recorded, and the
   * review leaves the list until the server's row starts again and is reviewed again.
   * @param serverName - the server the person answered for.
   * @param reviewId - the id of the review the person was shown.
   * @throws {McpReviewError} `STALE_REVIEW` when the server has no pending review with that id.
   */
  declineReview(serverName: string, reviewId: string): void {
    const review = this.pendingReview(serverName, reviewId)
    this.reviews.delete(serverName)
    this.ctx.logger.info(`mcp-consent: the person declined the start of the stdio server ${review.shown.serverName}; it stays stopped`)
  }

  /**
   * Record that the person accepted a server start, as the acceptance the
   * reviews allow. Accepting a command again replaces its earlier acceptance,
   * so a changed start is granted by accepting it with the arguments, working
   * directory, resolved paths and environment it now carries. Accepting into a superseded
   * store starts a store of this version that holds only this acceptance. The
   * asking surface of Delo's MCP server add flow calls this; until such a
   * surface is mounted, the store only grows through it and every unaccepted
   * start keeps its server stopped.
   * @param start - the start the person accepted, as a review was shown it:
   *   the executable, its arguments in order, its working directory, its
   *   configured environment, of which the store keeps the names and a digest,
   *   and the absolute executable path, command shell and working directory they resolved to.
   * @returns when the store holds the acceptance.
   * @throws when the command is empty or a resolved path is not absolute, which
   *   no review is shown.
   */
  accept(start: ServerStart): Promise<void> {
    return this.serial(async () => {
      if (start.command.length === 0) throw new Error('the command to accept is empty')
      const resolved = [start.resolvedCommand, start.resolvedCwd, ...start.resolvedShell === undefined ? [] : [start.resolvedShell]]
      if (!resolved.every(entry => isAbsolute(entry))) {
        throw new Error('the start to accept holds a resolved path that is not absolute')
      }
      const path = await this.path()
      const read = await readAcceptanceStore(path)
      // A store that exists but is not this version's format is never added to: accepting into a refused store would
      // look like the acceptance the file cannot state. The person fixes or removes the store first, and the review
      // keeps asking until then.
      if (read.kind === 'refused') throw new Error(`the acceptance store is refused, so the command stays unaccepted: ${read.problem}`)
      const entries = read.kind === 'readable' ? new Map(read.entries) : new Map<string, AcceptedCommand>()
      entries.set(start.command, acceptanceOfStart(start, Date.now()))
      await writeAcceptanceStore(path, entries)
    })
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
      throw new McpReviewError('STALE_REVIEW', `the server ${serverName} has no pending review with this id: its start was reviewed again, accepted or set aside since it was shown`)
    }
    return review
  }

  /**
   * Start again every server row of the Loader that stopped because this consent refused the server's start, now that
   * the start is accepted. A row restarts with the configuration it has, so its next review judges its start as it is
   * now; without a Loader nothing restarts, and the next start of the studio starts the server.
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
      if (refusedServer(failure) !== serverName) continue
      try {
        // `update` with the row's own configuration clears the refusal and applies the row again; nothing is saved.
        await fiber.update(fiber.config, true)
        started++
      } catch (error) {
        this.ctx.logger.warn(`mcp-consent: the server ${serverName} was accepted, and its row ${entry.id} did not start again: ${reasonOf(error)}`)
      }
    }
    return started
  }

  /**
   * The Loader rows configured to start a command, with their server names.
   * @param command - the executable.
   * @returns each row with a fiber whose configuration names the command as a stdio start.
   */
  private rowsStarting(command: string): { readonly id: string, readonly serverName: string, readonly fiber: NonNullable<LoaderEntry['fiber']> }[] {
    const rows: { readonly id: string, readonly serverName: string, readonly fiber: NonNullable<LoaderEntry['fiber']> }[] = []
    for (const entry of this.ctx.get('loader')?.entries() ?? []) {
      const fiber = entry.fiber
      const config: unknown = fiber?.config
      if (fiber === undefined || typeof config !== 'object' || config === null || Reflect.get(config, 'command') !== command) continue
      const serverName: unknown = Reflect.get(config, 'serverName')
      if (typeof serverName === 'string') rows.push({ id: entry.id, serverName, fiber })
    }
    return rows
  }

  /**
   * The store's path under the resolved home.
   * @returns the absolute path.
   * @throws the home resolution's refusal, when the home cannot be resolved.
   */
  private async path(): Promise<string> {
    const home = await resolveDeloHome(process.env)
    return acceptanceStorePath(home.path)
  }

  /**
   * Answer one review from the store.
   * @param command - the server start under review.
   * @returns the decision.
   */
  private async decide(command: McpServerCommand): Promise<Verdict> {
    let path: string
    try {
      path = await this.path()
    } catch (error) {
      return { allow: false, change: 'unreadable', reason: `the Delo home could not be resolved, so no acceptance can be read (${reasonOf(error)})` }
    }
    const read = await readAcceptanceStore(path)
    if (read.kind === 'absent') {
      return { allow: false, change: 'new', reason: 'no command is accepted yet (the acceptance store does not exist)' }
    }
    if (read.kind === 'refused') {
      return { allow: false, change: 'unreadable', reason: `the acceptance store could not be read, so nothing counts as accepted (${read.problem})` }
    }
    if (read.kind === 'superseded') {
      return {
        allow: false,
        change: 'new',
        reason: `the acceptance store is of version ${String(read.version)}, recorded before an acceptance covered the executable path, command shell and working directory the command resolves to, so nothing counts as accepted until the command is accepted again`,
      }
    }
    const accepted = read.entries.get(command.command)
    if (accepted === undefined) {
      return { allow: false, change: 'new', reason: 'the acceptance store holds no acceptance for this command' }
    }
    const reason = mismatchOf(accepted, command)
    return reason === undefined ? { allow: true } : { allow: false, change: changedPartOf(accepted, command) ?? 'new', reason }
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

/**
 * With the `mcp_add_consent` switch on: mount the consent service, whose
 * review the mcp-client plugin consults before it starts a stdio server, its
 * pending reviews as the `mcpReviews` service, and, where a Connection serves
 * the studio, the routes of the studio's MCP servers section
 * ([`./routes.ts`](./routes.ts)). The
 * mount is the service's own plugin fiber, and the returned promise is this
 * plugin's startup work, so the service is registered before this row is
 * active; an mcp-client row waits for this row to settle
 * ({@link providesMcpAddConsent}). Off, register nothing, and the waiting
 * mcp-client rows start their servers as upstream does.
 * @param ctx - the plugin context.
 * @param config - the switch.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  await ctx.plugin(DeloMcpConsent)
  // The studio's routes, in a profile that serves a studio.
  ctx.inject(['connection', 'mcpReviews'], (child) => { registerMcpConsentRoutes(child, child.mcpReviews) })
}

/** A review's outcome with what it asks about: the decision the mcp-client reads, and the change a surface names. */
type Verdict = { readonly allow: true } | { readonly allow: false, readonly reason: string, readonly change: ServerChange }

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
