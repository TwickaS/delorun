/**
 * The check that a state-changing request came from the studio's own page, shared by the routes that change the home.
 *
 * @module @delorun/bundle-local/studio-page
 */
import type { IncomingMessage } from 'node:http'
import { isForeignFetchSite, isSameLoopbackOrigin } from '@delorun/home-auth'

/**
 * Whether a state-changing request came from the studio's own page: no foreign `Sec-Fetch-Site`, and an `Origin`, when
 * sent, naming the request's own loopback host.
 * @param request - the request.
 * @param atComputer - whether the request arrived on the loopback listener.
 * @returns whether the studio's page made it.
 */
export function fromStudioPage(request: Pick<IncomingMessage, 'headers'>, atComputer: boolean): boolean {
  const site = request.headers['sec-fetch-site']
  if (isForeignFetchSite(Array.isArray(site) ? site[0] : site)) return false
  const { origin, host } = request.headers
  if (origin === undefined) return true
  if (atComputer) return isSameLoopbackOrigin(origin, host)
  // A device's page is served from its reach address: its `Origin` must name the request's own `Host`.
  return host !== undefined && URL.canParse(origin) && new URL(origin).host.toLowerCase() === host.toLowerCase()
}
