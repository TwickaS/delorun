/**
 * Chromium on Delorun's reach listener (contract C4) for Web e2e scenarios. The reach listener is the self-hosted relay
 * listener, fed by a local TCP server, with a stand-in authenticator provider that admits one session cookie and a
 * certificate from Delorun's test authority; Chromium resolves the studio's name to that TCP server.
 */
import { once } from 'node:events'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LOOPBACK_LISTENER } from '@deepseek-ai/dsh-client-connection/authenticator'
import {
  Authenticator, type Admission, type ConnectionIndexRequest, type ListenerPolicy, type PeerScope, type ReachListener,
} from '@deepseek-ai/dsh-client-connection'
import type { TestAuthority } from '../../../delorun/apps/tools/src/stack/certificates.ts'
import type { WebScaffold } from './scaffold.ts'

/** The studio's name on the reach listener. */
export const STUDIO_HOST = 'studio.example.org'
const RELAY = 'reach-self-hosted-relay'
const SESSION_COOKIE = { name: '__Host-delorun-session', value: 'reach-e2e' }

/** Stand-in for `@delorun/home-auth`: one session cookie admits one Peer on the relay listener; loopback is Connection's own admission. */
class StandInHomeAuth extends Authenticator {
  private peer: PeerScope | undefined

  policy(listener: string): ListenerPolicy | undefined {
    if (listener !== RELAY) return undefined
    return { listener, scheme: 'https', hostRule: { kind: 'equals-bound-name-and-sni', address: `https://${STUDIO_HOST}` }, acceptsLaunchToken: false, preLogin: [] }
  }

  admit(request: ConnectionIndexRequest, listener: string): Admission {
    if (listener === LOOPBACK_LISTENER) return this.ctx.connection.builtinAdmission(request)
    const cookie = request.headers instanceof Headers ? request.headers.get('cookie') : request.headers.cookie
    if (typeof cookie !== 'string' || !cookie.split(';').some(pair => pair.trim() === `${SESSION_COOKIE.name}=${SESSION_COOKIE.value}`)) {
      return { kind: 'refused', status: 401, code: 'NOT_SIGNED_IN' }
    }
    this.peer ??= this.ctx.connection.createPeer({ principal: { kind: 'owner' } })
    return { kind: 'admitted', peer: this.peer }
  }
}

/** A signed-in Chromium context for the studio on a reach listener. */
export interface ReachStudio {
  /** The studio's address on the reach listener. */
  readonly url: string
  readonly browser: Browser
  /** Carries the session cookie; records Content Security Policy violations on every page. */
  readonly context: BrowserContext
  readonly listener: ReachListener
}

/** One Content Security Policy violation a page reported. */
export interface PolicyViolation {
  readonly directive: string
  readonly blocked: string
  readonly sample: string
  /** `<file>:<line>:<column>` of the code the violation names. */
  readonly source: string
}

declare global {
  /** Violations recorded by {@link openReachStudio}'s page script. */
  var __delorunPolicyViolations: PolicyViolation[] | undefined
}

/**
 * Load a stand-in provider into the scaffold, open the relay listener, and launch Chromium signed in to it.
 * @param scaffold - the running Web scaffold.
 * @param authority - Delorun's test authority, which issues the studio's certificate.
 * @param hostRules - further Chromium `--host-resolver-rules` entries.
 * @returns the studio; everything it opened closes when the test finishes.
 */
export async function openReachStudio(
  scaffold: WebScaffold, authority: TestAuthority, hostRules: readonly string[] = [],
): Promise<ReachStudio> {
  const tls = await authority.issue({ dnsNames: [STUDIO_HOST] })
  if (tls.keyPem === undefined) throw new Error('the test authority returned no key')
  await scaffold.ctx.plugin({ inject: ['connection'], apply: (ctx: Context) => { new StandInHomeAuth(ctx) } })
  const listener = await scaffold.ctx.connection.openReachListener({ listener: RELAY, bind: { kind: 'streams', tls: { cert: tls.pem, key: tls.keyPem } } })
  onTestFinished(() => listener.close())
  const relay = createTcpServer((socket) => {
    try {
      listener.accept(socket)
    } catch {
      // A stopped listener takes no stream.
      socket.destroy()
    }
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  onTestFinished(() => new Promise<void>((resolve) => { relay.close(() => { resolve() }) }))
  const relayPort = (relay.address() as AddressInfo).port

  const browser = await chromium.launch({ args: [`--host-resolver-rules=${[`MAP ${STUDIO_HOST}:443 127.0.0.1:${String(relayPort)}`, ...hostRules].join(',')}`] })
  onTestFinished(() => browser.close())
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1280, height: 900 } })
  await context.addCookies([{ ...SESSION_COOKIE, url: `https://${STUDIO_HOST}`, secure: true, httpOnly: true, sameSite: 'Strict' }])
  await context.addInitScript(() => {
    const violations: PolicyViolation[] = []
    globalThis.__delorunPolicyViolations = violations
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({
        directive: event.effectiveDirective, blocked: event.blockedURI, sample: event.sample,
        source: `${event.sourceFile}:${String(event.lineNumber)}:${String(event.columnNumber)}`,
      })
    }, true)
  })
  return { url: `https://${STUDIO_HOST}/`, browser, context, listener }
}

/**
 * The Content Security Policy violations a page reported since it loaded.
 * @param page - a page of a {@link ReachStudio} context.
 * @returns the violations in report order.
 */
export async function policyViolations(page: Page): Promise<PolicyViolation[]> {
  return await page.evaluate(() => globalThis.__delorunPolicyViolations ?? [])
}
