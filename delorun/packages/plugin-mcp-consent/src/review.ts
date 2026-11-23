/**
 * The pending reviews of the add-time consent: each stdio server start the consent refused, kept so the studio and
 * `delorun mcp` can show it and the person can accept or decline it at the home's own computer. A review's id is a
 * digest of the whole start, the environment's values only through their digest, so an answer that carries the id of
 * an earlier review of a server — one shown before its start changed — is refused as stale. A review shows an
 * environment variable's value only where {@link showsEnvValue} allows it.
 *
 * Free of Cordis at run time, so the review id is testable without a mounted plugin.
 *
 * @module @delorun/plugin-mcp-consent/review
 */
import { createHash } from 'node:crypto'
import { sortedEnvEntries } from '@deepseek-ai/dsh-mcp-client/consent'
import { isRunAffectingEnv } from '@deepseek-ai/dsh-mcp-client/templates'
import type { PinnedStart } from './pins.ts'
import { envDigests } from './store.ts'
import type { AcceptedServer, EnvVariable, McpConsentRefusalCode, PendingServer, ServerChange, ServerOrigin, ServerState } from './wire.ts'

/**
 * Whether a surface shows an environment variable's value: only for a variable that changes which program, library or
 * startup script runs, by the one list `isRunAffectingEnv` of `@deepseek-ai/dsh-mcp-client` holds (`PATH`, `NODE_*`,
 * `LD_*`, `DYLD_*`, `PYTHON*`, `BASH_ENV`, `JAVA_TOOL_OPTIONS` and the rest of it). Every other value may be a secret
 * and is never shown; the acceptance store keeps only digests of every value.
 * @param name - the variable's name.
 * @returns true when the value is shown.
 */
export function showsEnvValue(name: string): boolean {
  return isRunAffectingEnv(name)
}

/** The length of a review id: hexadecimal digits of a SHA-256. */
export const MCP_REVIEW_ID_LENGTH = 32

/** A review id's form: {@link MCP_REVIEW_ID_LENGTH} lowercase hexadecimal digits. */
export const MCP_REVIEW_ID_PATTERN = /^[0-9a-f]{32}$/

/** One refused start as the service keeps it: what a surface shows, and the start an acceptance records. */
export interface PendingReview {
  /** What a surface shows. */
  readonly shown: PendingServer
  /** The start the review judged, with the files it pinned, which an acceptance records as it was shown. */
  readonly start: PinnedStart
}

/**
 * The id of a review of one server start: a digest of every field the start carries, sorted by name, with the
 * environment replaced by each variable's digest. A field the mcp-client adds to the start changes the id with it, and so do the
 * pinned files.
 * @param start - the start under review, with the files it pinned.
 * @returns {@link MCP_REVIEW_ID_LENGTH} hexadecimal digits.
 */
export function mcpReviewId(start: PinnedStart): string {
  const fields = Object.entries({ ...start, env: envDigests(start.env) }).sort(([left], [right]) => (left < right ? -1 : 1))
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, MCP_REVIEW_ID_LENGTH)
}

/**
 * What a refusal adds after its reason, so a person who reads it in a log or a terminal knows the exact way to start the
 * server: accept it at the home's own computer.
 * @param serverName - the refused server.
 * @returns the clause, starting with `; `.
 */
export function acceptHint(serverName: string): string {
  return `; to start it, accept it at the home's computer with \`delorun mcp accept ${serverName}\` while Delorun runs, or in the studio's Settings, Permissions`
}

/**
 * A configured environment as a surface shows it.
 * @param env - the configured environment entries.
 * @returns each variable sorted by name, with its value only where {@link showsEnvValue} allows it.
 */
export function shownEnv(env: Readonly<Record<string, string>>): readonly EnvVariable[] {
  return sortedEnvEntries(env).map(([name, value]) => (showsEnvValue(name) ? { name, value } : { name }))
}

/** What the consent found when it refused a start. */
export interface RefusedStart {
  /** Why the consent refused it, naming no environment value. */
  readonly reason: string
  /** What the review asks about. */
  readonly change: ServerChange
  /** The variables added, removed or given another value, sorted; empty unless the change is `environment`. */
  readonly changedVariables: readonly string[]
  /** Whether the review waits for an answer or the person set the start aside. */
  readonly state: ServerState
}

/**
 * The pending review of a refused start.
 * @param start - the refused start, with the files the review pinned.
 * @param refused - what the consent found.
 * @param reviewedAt - when, in milliseconds since the epoch.
 * @param writableByChats - the working directory and pinned files that lie where chats can write.
 * @param origin - where the server's definition lives, which an acceptance of the review records.
 * @returns the review, whose shown fields name the resolved executable path, working directory and command shell, the
 *   environment's variables and only the values a surface may show, the pinned files, and the paths chats can write.
 */
export function pendingReviewOf(start: PinnedStart, refused: RefusedStart, reviewedAt: number, writableByChats: readonly string[], origin: ServerOrigin): PendingReview {
  return {
    start,
    shown: {
      serverName: start.serverName,
      reviewId: mcpReviewId(start),
      origin,
      command: start.command,
      args: [...start.args],
      cwd: start.cwd,
      resolvedCommand: start.resolvedCommand,
      resolvedCwd: start.resolvedCwd,
      ...start.resolvedShell === undefined ? {} : { resolvedShell: start.resolvedShell },
      env: shownEnv(start.env),
      files: start.files.map(file => ({ ...file })),
      writableByChats: [...writableByChats],
      reason: refused.reason,
      change: refused.change,
      changedVariables: [...refused.changedVariables],
      state: refused.state,
      reviewedAt,
    },
  }
}

/** An answer to a pending review that the service refused, recording nothing. */
export class McpReviewError extends Error {
  /** Why the answer was refused; the routes answer it as the refusal's `error`. */
  readonly code: McpConsentRefusalCode

  /**
   * @param code - why the answer was refused.
   * @param message - the sentence a surface shows.
   * @param options - the cause, when another failure stands behind the refusal.
   */
  constructor(code: McpConsentRefusalCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpReviewError'
    this.code = code
  }
}

/**
 * The pending reviews of the add-time consent, as the `mcpReviews` service the studio's routes and the home process's
 * `mcp.*` operations call: the add-time consent service's `pending`, `acceptReview` and `declineReview`.
 */
export interface McpReviews {
  /**
   * The pending reviews in every state, sorted by server name.
   * @returns what a surface shows of each.
   */
  pending(): readonly PendingServer[]
  /**
   * Accept one pending review, after the person confirmed it at the home's own computer.
   * @param serverName - the server.
   * @param reviewId - the review shown.
   * @param confirmed - the person's answer.
   * @returns how many refused rows started again.
   * @throws {McpReviewError} for an unconfirmed or stale answer, or a store that cannot be written.
   */
  acceptReview(serverName: string, reviewId: string, confirmed: boolean): Promise<{ readonly started: number }>
  /**
   * Set one pending review aside at the home's own computer: it stays listed as `declined` and its server stopped.
   * @param serverName - the server.
   * @param reviewId - the review shown.
   * @returns when the review is set aside.
   * @throws {McpReviewError} for a stale answer.
   */
  declineReview(serverName: string, reviewId: string): Promise<void>
  /**
   * The accepted starts, one per server name.
   * @returns them sorted by server name; none while the store cannot be read.
   */
  accepted(): Promise<readonly AcceptedServer[]>
  /**
   * Withdraw one acceptance at the home's own computer and stop the running rows of its server.
   * @param acceptanceId - the acceptance id the list showed.
   * @param confirmed - the person's answer.
   * @returns how many running rows were stopped.
   * @throws {McpReviewError} for an unconfirmed or stale answer, or a store that cannot be written.
   */
  revokeAcceptance(acceptanceId: string, confirmed: boolean): Promise<{ readonly stopped: number }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The pending reviews of Delorun's MCP add-time consent, mounted while the `mcp_add_consent` switch is on. */
    mcpReviews: McpReviews
  }
}
