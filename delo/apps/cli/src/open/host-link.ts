/**
 * The studio link a booted Host mints for `studio.open-token` (contract C19; contract C4, "Launch tokens"): upstream's
 * connection adds a launch token to the studio's loopback root, or to the same loopback host at a port that forwards
 * to it. With Delo's composition the token is one-time and expires after 60 seconds; with upstream's default it is
 * the Host's reusable process token. A Host whose studio listens on an address other than loopback, or that publishes
 * the studio at a public URL, gives no link: the browser at this computer would not reach the studio through it.
 *
 * @module @delo/cli/open/host-link
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-web-app'
import type { StudioLinkResult } from '@delo/home-process'
import type {} from '@delo/logs/cordis'

/**
 * Mint a studio link on a booted Host.
 * @param ctx - the Host's root context.
 * @param port - a loopback port that forwards to the studio, or `undefined` for the studio's own port.
 * @returns the link to the loopback listener, or why none can be made for this computer.
 */
export function hostStudioLink(ctx: Context, port: number | undefined): StudioLinkResult {
  const server = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (server?.port === undefined || connection === undefined) return { kind: 'unavailable', reason: 'the Host serves no studio' }
  if (!isLoopbackHost(server.host)) return { kind: 'unavailable', reason: `the studio listens on ${server.host}, which is not a loopback address` }
  const advertised = ctx.get('webApp')?.getAdvertisedUrl()
  if (advertised !== undefined && advertised !== server.getOrigin()) {
    return { kind: 'unavailable', reason: `the studio is published at ${advertised}; open that address instead` }
  }
  const host = server.host.includes(':') ? `[${server.host}]` : server.host
  const link = connection.authenticatedUrl(`${server.protocol}//${host}:${String(port ?? server.port)}/`)
  holdLaunchToken(ctx, link, connection.oneTimeLaunchTokens)
  return { kind: 'link', link: { url: link, oneTime: connection.oneTimeLaunchTokens } }
}

/** How long a one-time launch token stays registered: past its 60 seconds of life. */
const ONE_TIME_TOKEN_REGISTERED_MS = 120_000

/**
 * Register the launch token a studio link carries with the home log's redactor. A reusable process token stays
 * registered; a one-time token is dropped once it has expired.
 * @param ctx - the Host's root context.
 * @param link - the minted link.
 * @param oneTime - whether the token is one-time.
 */
function holdLaunchToken(ctx: Context, link: string, oneTime: boolean): void {
  const token = new URL(link).searchParams.get('token')
  const release = token === null ? undefined : ctx.get('deloSecrets')?.register(token, 'session-secret')
  if (release !== undefined && oneTime) setTimeout(release, ONE_TIME_TOKEN_REGISTERED_MS).unref()
}
