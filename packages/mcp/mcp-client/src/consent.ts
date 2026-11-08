/**
 * The `mcpAddConsent` Service Definition: the optional add-time consent seam
 * an mcp-client instance consults before it starts a configured MCP server.
 * The service is optional — without a mounted provider the mcp-client plugin
 * starts a server exactly as upstream does — and a stdio server row waits for
 * the mounted service's decision before its command runs. A stdio server
 * command runs as a local child process outside the agent sandbox, so the
 * consent names the command and arguments being granted.
 *
 * A provider implements {@link McpAddConsent} and is loaded as a plugin; the
 * mcp-client reads it with the optional lookup `ctx.get('mcpAddConsent')`.
 * The service sees the configured command at every boot, so a provider that
 * remembers an accepted command lets the same grant start without asking
 * again, and a changed command reaches the provider as a new review.
 *
 * @module @deepseek-ai/dsh-mcp-client/consent
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** The server start a consent review judges. */
export interface McpServerCommand {
  /** The server's configured `serverName` namespace. */
  readonly serverName: string
  /** Executable the server would be started with. */
  readonly command: string
  /** Arguments passed directly to the executable, without shell interpolation. */
  readonly args: readonly string[]
}

/** The decision a consent review returns. */
export type McpConsentDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string }

/**
 * Refusal of one server command by the mounted consent, thrown by the
 * mcp-client plugin's activation so the refused server stays stopped. The
 * message names the command and arguments being granted, carries the
 * provider's reason, and states that a server command runs outside the agent
 * sandbox.
 */
export class McpConsentRefusedError extends Error {
  /** The refused server's configured namespace. */
  readonly serverName: string
  /** The refused executable. */
  readonly command: string
  /** The refused arguments. */
  readonly args: readonly string[]
  /** The consent provider's own reason. */
  readonly reason: string

  /**
   * @param serverName - the refused server's configured namespace.
   * @param command - the executable that was not granted.
   * @param args - the arguments that were not granted.
   * @param reason - the consent provider's reason.
   */
  constructor(serverName: string, command: string, args: readonly string[], reason: string) {
    const granted = [command, ...args].map(part => JSON.stringify(part)).join(' ')
    super(
      `mcp-client(${serverName}): the add-time consent did not allow this server's command, so the server stays stopped — ${reason}. `
        + `The consent covers the command ${granted}. A server command runs outside the agent sandbox.`,
    )
    this.name = 'McpConsentRefusedError'
    this.serverName = serverName
    this.command = command
    this.args = [...args]
    this.reason = reason
  }
}

/**
 * Abstract add-time consent service. Subclass, implement {@link review}, and
 * load the subclass as a plugin — it registers as `ctx.mcpAddConsent` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 */
export abstract class McpAddConsent extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mcpAddConsent')
  }

  /**
   * Review one configured server command before the mcp-client plugin starts
   * that server. The review runs at every boot of the server row, before any
   * child process starts, so the provider can let an accepted command through
   * at once and ask again when the command it is shown differs from the one
   * it accepted before.
   *
   * The returned promise gates the server's start: the mcp-client plugin's
   * activation does not finish, and the server does not start, until it
   * settles, so an implementation that asks a person must settle it when the
   * person answers and when the provider's own plugin unloads.
   *
   * @param command - the server start under review.
   * @returns `allow: true` to start the server, or `allow: false` with the
   *   reason that leaves the server stopped.
   */
  abstract review(command: McpServerCommand): Promise<McpConsentDecision>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpAddConsent: McpAddConsent
  }
}
