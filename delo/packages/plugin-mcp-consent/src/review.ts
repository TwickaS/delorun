/**
 * The pending reviews of the add-time consent: each stdio server start the consent refused, kept so the studio and
 * `delorun mcp` can show it and the person can accept or decline it at the home's own computer. A review's id is a
 * digest of everything the review was shown, the environment's values only through their digest, so an answer that
 * carries the id of an earlier review of a server — one shown before its start changed — is refused as stale.
 *
 * Free of Cordis at run time, so the review id is testable without a mounted plugin.
 *
 * @module @delo/plugin-mcp-consent/review
 */
import { createHash } from 'node:crypto'
import { sortedEnvEntries, type McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { envDigest } from './store.ts'
import type { McpConsentRefusalCode, PendingServer } from './wire.ts'

/** The length of a review id: hexadecimal digits of a SHA-256. */
export const MCP_REVIEW_ID_LENGTH = 32

/** A review id's form: {@link MCP_REVIEW_ID_LENGTH} lowercase hexadecimal digits. */
export const MCP_REVIEW_ID_PATTERN = /^[0-9a-f]{32}$/

/** One refused start as the service keeps it: what a surface shows, and the start an acceptance records. */
export interface PendingReview {
  /** What a surface shows. */
  readonly shown: PendingServer
  /** The start the review judged, which an acceptance records as it was shown. */
  readonly start: McpServerCommand
}

/**
 * The id of a review of one server start: a digest of every field the start carries, sorted by name, with the
 * environment replaced by its digest. A field the mcp-client adds to the start changes the id with it.
 * @param start - the start under review.
 * @returns {@link MCP_REVIEW_ID_LENGTH} hexadecimal digits.
 */
export function mcpReviewId(start: McpServerCommand): string {
  const fields = Object.entries({ ...start, env: envDigest(start.env) }).sort(([left], [right]) => (left < right ? -1 : 1))
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, MCP_REVIEW_ID_LENGTH)
}

/**
 * The pending review of a refused start.
 * @param start - the refused start.
 * @param reason - why the consent refused it.
 * @param reviewedAt - when, in milliseconds since the epoch.
 * @returns the review, whose shown fields name the environment's variables but none of their values.
 */
export function pendingReviewOf(start: McpServerCommand, reason: string, reviewedAt: number): PendingReview {
  return {
    start,
    shown: {
      serverName: start.serverName,
      reviewId: mcpReviewId(start),
      command: start.command,
      args: [...start.args],
      cwd: start.cwd,
      envNames: sortedEnvEntries(start.env).map(([name]) => name),
      reason,
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
   * The pending reviews, sorted by server name.
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
   * Set one pending review aside at the home's own computer.
   * @param serverName - the server.
   * @param reviewId - the review shown.
   * @throws {McpReviewError} for a stale answer.
   */
  declineReview(serverName: string, reviewId: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The pending reviews of Delo's MCP add-time consent, mounted while the `mcp_add_consent` switch is on. */
    mcpReviews: McpReviews
  }
}
