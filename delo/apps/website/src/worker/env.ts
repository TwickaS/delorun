/**
 * The Worker's bindings and the parts of Cloudflare's runtime types it uses, written out so the Worker and its specs
 * need no Cloudflare type package.
 *
 * @module @delo/website/worker/env
 */

/** A D1 prepared statement. */
export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement
  first<T>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number } }>
  all<T>(): Promise<{ results: T[] }>
}

/** The D1 database binding. */
export interface D1Like {
  prepare(sql: string): D1Statement
}

/** A message for the `send_email` binding. */
export interface OutgoingEmail {
  from: { email: string; name: string }
  to: string
  replyTo: string
  subject: string
  text: string
  html: string
  headers: Record<string, string>
}

/** The `send_email` binding. */
export interface EmailSender {
  send(message: OutgoingEmail): Promise<{ messageId: string }>
}

/** Cloudflare's rate-limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** The static assets binding. */
export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>
}

/** What the stack binds to the Worker. */
export interface Env {
  DB: D1Like
  ASSETS: AssetsFetcher
  RATE_LIMIT: RateLimiter
  /** The Turnstile widget's public key, which the form fetches before it shows the check. */
  TURNSTILE_SITEKEY: string
  /** The Turnstile widget's secret, which only Siteverify calls use. */
  TURNSTILE_SECRET: string
  /** `on` sends confirmation messages; `off` leaves sign-ups pending and sends nothing. */
  SEND_CONFIRMATION: 'on' | 'off'
  /** The address confirmation messages come from. */
  SENDER_ADDRESS: string
  /** The address that receives replies and deletion requests. */
  SUPPORT_ADDRESS: string
  /** The origin of the links in messages; absent, the request's own origin is used. */
  PUBLIC_ORIGIN?: string
  /** Present only when sending is on. */
  EMAIL?: EmailSender
}
