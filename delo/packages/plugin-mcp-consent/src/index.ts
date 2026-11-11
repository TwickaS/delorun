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
import { McpAddConsent } from '@deepseek-ai/dsh-mcp-client'
import type { McpConsentDecision, McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import schema from '@deepseek-ai/schemastery'
import { resolveDeloHome } from '@delo/home'
import {
  acceptanceOfStart,
  acceptanceStorePath,
  mismatchOf,
  readAcceptanceStore,
  writeAcceptanceStore,
} from './store.ts'
import type { AcceptedCommand, ServerStart } from './store.ts'

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
export class DeloMcpConsent extends McpAddConsent {
  /** The writes to the store, chained so a grant and a review's write never interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - the plugin context.
   */
  constructor(ctx: Context) {
    super(ctx)
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
  review(command: McpServerCommand): Promise<McpConsentDecision> {
    return this.decide(command)
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
  private async decide(command: McpServerCommand): Promise<McpConsentDecision> {
    let path: string
    try {
      path = await this.path()
    } catch (error) {
      return { allow: false, reason: `the Delo home could not be resolved, so no acceptance can be read (${reasonOf(error)})` }
    }
    const read = await readAcceptanceStore(path)
    if (read.kind === 'absent') {
      return { allow: false, reason: 'no command is accepted yet (the acceptance store does not exist)' }
    }
    if (read.kind === 'refused') {
      return { allow: false, reason: `the acceptance store could not be read, so nothing counts as accepted (${read.problem})` }
    }
    if (read.kind === 'superseded') {
      return {
        allow: false,
        reason: `the acceptance store is of version ${String(read.version)}, recorded before an acceptance covered the executable path, command shell and working directory the command resolves to, so nothing counts as accepted until the command is accepted again`,
      }
    }
    const accepted = read.entries.get(command.command)
    if (accepted === undefined) {
      return { allow: false, reason: 'the acceptance store holds no acceptance for this command' }
    }
    const mismatch = mismatchOf(accepted, command)
    return mismatch === undefined ? { allow: true } : { allow: false, reason: mismatch }
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
 * review the mcp-client plugin consults before it starts a stdio server. The
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
}

/**
 * The reason a failure gives, in words that may reach the person through the refusal error.
 * @param error - the failure.
 * @returns the failure's message, or a plain one when it has none.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the home could not be resolved'
}
