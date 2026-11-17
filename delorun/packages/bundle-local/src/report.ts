/**
 * The `delorun-report` row of `@delorun/bundle-local`: the home's half of "Report a problem". It answers one read-only
 * route with the versions, the system and an excerpt of the newest error records of the home's own log, and the address
 * of the issue form from its configuration. The excerpt goes through `@delorun/logs`' redactor again, so the report
 * holds nothing the log would not. The row makes no outgoing request: the studio opens the issue form in the person's
 * browser, and the person sends it.
 *
 * @module @delorun/bundle-local/report
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { arch, homedir, hostname, platform, release, type, userInfo } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseRecord, Redactor, resolveSurface, surfaceFiles } from '@delorun/logs'
import { gateByUnlock } from '@delorun/home-auth'
import { harnessVersions } from './index.ts'
import { REPORT_DEFAULTS, REPORT_ROUTE, type ReportDetails } from './client/report-api.ts'

export { REPORT_DEFAULTS }

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-report'

/** How many error records the excerpt holds at most. */
export const EXCERPT_RECORDS = 5

/** The most bytes read from the end of the active log file for one answer. */
export const EXCERPT_READ_BYTES = 256 * 1024

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
  issueUrl: z.string().default(REPORT_DEFAULTS.issueUrl).description('The https://github.com address of the issue form that "Report a problem" opens.'),
  template: z.string().default(REPORT_DEFAULTS.template).description('The issue template\'s file name.'),
})

/**
 * Check that the configured address is an https URL on github.com, the one host the report's link may carry its text to.
 * @param issueUrl - the configured address.
 * @throws {TypeError} when it is not, so the row does not load.
 */
export function requireGithub(issueUrl: string): void {
  let url: URL
  try {
    url = new URL(issueUrl)
  } catch (cause) {
    throw new TypeError(`delorun-report: issueUrl "${issueUrl}" is not a URL; set an https://github.com address in the row's configuration`, { cause })
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new TypeError(`delorun-report: issueUrl "${issueUrl}" must be an https://github.com address, because the report's text travels in that link; change it in the row's configuration`)
  }
}

/** What {@link scrub} masks beside the home directory. */
export interface ScrubRoots {
  /** The Delorun home, which may lie outside the person's home directory. */
  readonly delorunHome: string
  /** The process's working directory, usually a workspace root. */
  readonly workingDirectory: string
}

/**
 * Take what names the person or the computer out of an excerpt line: the Delorun home and the working directory, the home
 * directory, the user name, the host name, any other `/home/<name>` or `/Users/<name>` path and Tailscale host names.
 * @param text - a line already through the log redactor.
 * @param roots - the directories to mask.
 * @returns the line with placeholders.
 */
export function scrub(text: string, roots: ScrubRoots): string {
  let result = text
  const literal = (value: string, placeholder: string): void => {
    if (value.length >= 3) result = result.split(value).join(placeholder)
  }
  literal(roots.delorunHome, '<delorun-home>')
  literal(roots.workingDirectory, '<workspace>')
  literal(homedir(), '~')
  literal(userInfo().username, '<user>')
  literal(hostname(), '<host>')
  return result
    .replace(/(?:\/home|\/Users)\/[^\s/'"]+/gu, '~')
    .replace(/[A-Za-z]:\\Users\\[^\s'"]+/gu, '~')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gu, '<tailnet-host>')
}

/**
 * The last lines of the active log file, at most {@link EXCERPT_READ_BYTES} bytes.
 * @param file - the active file.
 * @returns its tail's complete lines.
 */
function tailLines(file: string): string[] {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - EXCERPT_READ_BYTES)
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    // The first line is partial when the read began inside the file, and the last has no newline yet.
    return lines.slice(start > 0 ? 1 : 0, -1)
  } finally {
    closeSync(fd)
  }
}

/**
 * The newest error records of a home process log, from the end of its active file, as short redacted lines with names masked.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param redactor - the log redactor.
 * @returns the lines joined by newlines, or an empty string when the log has no error or cannot be read.
 */
export function recentErrors(home: string, profile: string, redactor: Redactor = new Redactor(), roots: ScrubRoots = { delorunHome: home, workingDirectory: process.cwd() }): string {
  let lines: string[]
  try {
    const { active } = surfaceFiles(resolveSurface({ kind: 'home', home, profile }))
    lines = active === undefined ? [] : tailLines(active)
  } catch (error) {
    // An unreadable log leaves the excerpt empty; the report still carries the versions.
    console.warn('delorun-report: the log was not read', error)
    return ''
  }
  const records = lines.flatMap((line) => {
    const record = parseRecord(line)
    return record?.level === 'error' ? [record] : []
  })
  // Redact the whole message, then mask names, then cut: a secret is never cut in half before the redactor sees it.
  return records.slice(-EXCERPT_RECORDS).map(record => `${record.ts} ${record.logger}: ${scrub(redactor.text(record.err?.message ?? record.msg), roots).slice(0, EXCERPT_MESSAGE_CHARS)}`).join('\n')
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

/**
 * Mount the route once the Connection is up. The excerpt can hold home paths, so a device reads it only while unlocked.
 * @param ctx - the row's scope.
 * @param config - the row's configuration.
 * @throws {TypeError} when `issueUrl` is not an https://github.com URL.
 */
export function apply(ctx: Context, config: Config): void {
  requireGithub(config.issueUrl)
  ctx.inject(['connection'], (scope) => {
    scope.connection.fetch.register({
      path: REPORT_ROUTE, methods: ['GET'], requestBody: 'buffered',
      ...gateByUnlock(() => scope.get('homeAuth'), () => {
        const profile = scope.get('profileContext')
        return Promise.resolve(detailsResponse(config, profile === undefined ? undefined : { home: profile.home, name: profile.name }))
      }, { renews: false }),
    })
  })
}
