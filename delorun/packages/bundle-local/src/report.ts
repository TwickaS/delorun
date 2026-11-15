/**
 * The `delorun-report` row of `@delorun/bundle-local`: the home's half of "Report a problem". It answers one read-only
 * route with the versions, the system and an excerpt of the newest error records of the home's own log, and the address
 * of the issue form from its configuration. The excerpt goes through `@delorun/logs`' redactor again, so the report
 * holds nothing the log would not. The row makes no outgoing request: the studio opens the issue form in the person's
 * browser, and the person sends it.
 *
 * @module @delorun/bundle-local/report
 */
import { arch, platform, release, type } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge.
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { REACH_DEVICE } from '@delorun/home-auth'
import { readLines, Redactor, resolveSurface } from '@delorun/logs'
import { harnessVersions } from './index.ts'
import { REPORT_ROUTE, type ReportDetails } from './client/report-api.ts'

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-report'

/** The issue form's address and template a row that sets neither uses. */
export const REPORT_DEFAULTS = { issueUrl: 'https://github.com/Delo-Run/delo/issues/new', template: 'bug_report.yml' } as const

/** How many error records the excerpt holds at most. */
export const EXCERPT_RECORDS = 5

/** The longest message kept from one record, in characters. */
export const EXCERPT_MESSAGE_CHARS = 400

/** The plugin's configuration. */
export interface Config {
  /** The issue form's address; the report's link is this address with the template and body added. */
  readonly issueUrl: string
  /** The issue template's file name on the project's issue form. */
  readonly template: string
}

/** The configuration schema. */
export const Config = z.object({
  issueUrl: z.string().default(REPORT_DEFAULTS.issueUrl).description('The address of the issue form that "Report a problem" opens.'),
  template: z.string().default(REPORT_DEFAULTS.template).description('The issue template\'s file name.'),
})

/**
 * Check that the configured address is an absolute https URL.
 * @param issueUrl - the configured address.
 * @throws {TypeError} when it is not, so the row does not load.
 */
function requireHttps(issueUrl: string): void {
  let url: URL
  try {
    url = new URL(issueUrl)
  } catch (cause) {
    throw new TypeError(`delorun-report: issueUrl "${issueUrl}" is not a URL; set an https address in the row's configuration`, { cause })
  }
  if (url.protocol !== 'https:') throw new TypeError(`delorun-report: issueUrl "${issueUrl}" must start with https://; change it in the row's configuration`)
}

/**
 * The newest error records of a home process log as short redacted lines.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param redactor - the log redactor.
 * @returns the lines joined by newlines, or an empty string when the log has no error or cannot be read.
 */
export function recentErrors(home: string, profile: string, redactor: Redactor = new Redactor()): string {
  let lines
  try {
    lines = readLines(resolveSurface({ kind: 'home', home, profile }), EXCERPT_RECORDS, ({ record }) => record?.level === 'error')
  } catch (error) {
    // An unreadable log leaves the excerpt empty; the report still carries the versions.
    console.warn('delorun-report: the log was not read', error)
    return ''
  }
  return lines.flatMap(({ record }) => record === undefined ? [] : [
    redactor.text(`${record.ts} ${record.logger}: ${(record.err?.message ?? record.msg).slice(0, EXCERPT_MESSAGE_CHARS)}`),
  ]).join('\n')
}

/**
 * Answer the details route.
 * @param config - the row's configuration.
 * @param where - the profile's home and name, when the Host has a profile.
 * @returns the response.
 */
export function detailsResponse(config: Config, where: { readonly home: string, readonly name: string } | undefined): Response {
  const versions = harnessVersions()
  const details: ReportDetails = {
    ...versions === undefined ? {} : { delorun: versions.delorun, dsh: versions.dsh },
    os: `${type()} ${release()}`,
    platform: `${platform()} ${arch()}`,
    excerpt: where === undefined ? '' : recentErrors(where.home, where.name),
    issueUrl: config.issueUrl,
    template: config.template,
  }
  return new Response(JSON.stringify(details), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/** Admits a signed-in reach device: the route only reads. */
const admitsReachReader: NonNullable<ConnectionFetchRoute['admitPeer']> = (_request, peer) => peer.principal.kind === REACH_DEVICE

/**
 * Mount the route once the Connection is up.
 * @param ctx - the row's scope.
 * @param config - the row's configuration.
 * @throws {TypeError} when `issueUrl` is not an https URL.
 */
export function apply(ctx: Context, config: Config): void {
  requireHttps(config.issueUrl)
  ctx.inject(['connection'], (scope) => {
    scope.connection.fetch.register({
      path: REPORT_ROUTE, methods: ['GET'], requestBody: 'buffered', admitPeer: admitsReachReader,
      fetch: () => {
        const profile = scope.get('profileContext')
        return Promise.resolve(detailsResponse(config, profile === undefined ? undefined : { home: profile.home, name: profile.name }))
      },
    })
  })
}
