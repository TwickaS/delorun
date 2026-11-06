/**
 * The local stand-in stack for reach and sign-in tests: one test authority for every stand-in's
 * HTTPS, two OpenID Connect provider stand-ins (issuers A and B, for mix-up tests), an ACME
 * stand-in and a Certificate Transparency stand-in that logs every certificate the ACME
 * stand-in issues and marks the ones it revokes. Every stand-in listens on `127.0.0.1`; a spec
 * that must prove nothing leaves loopback installs the network guard before starting the stack.
 *
 * @module @delo/tools/stack
 */
import { startAcmeStandIn, type AcmeStandIn, type AcmeStandInOptions } from './acme.ts'
import { startCtStandIn, type CtStandIn } from './certificate-transparency.ts'
import { createTestAuthority, type TestAuthority } from './certificates.ts'
import { startOidcStandIn, type OidcStandIn, type OidcStandInOptions } from './oidc-provider.ts'

export * from './acme.ts'
export * from './caa.ts'
export * from './certificate-transparency.ts'
export * from './certificates.ts'
export * from './loopback.ts'
export * from './network-guard.ts'
export * from './oidc-provider.ts'

/** The running stack. */
export interface StandInStack {
  /** The authority every stand-in's HTTPS certificate chains to; a client trusts `authority.certificate.pem`. */
  readonly authority: TestAuthority
  /** The person's provider. */
  readonly issuerA: OidcStandIn
  /** A second provider, for issuer mix-up tests. */
  readonly issuerB: OidcStandIn
  readonly acme: AcmeStandIn
  readonly transparency: CtStandIn
  /** Stop every stand-in. */
  readonly close: () => Promise<void>
}

/** How to start the stack. */
export interface StandInStackOptions {
  /** The `sub` both providers sign in; `stand-in-owner` when absent. */
  readonly subject?: string
  /** Options for both providers other than the authority and subject. */
  readonly oidc?: Omit<OidcStandInOptions, 'authority' | 'subject'>
  /** Options for the ACME stand-in other than the authority and the transparency callbacks. */
  readonly acme?: Omit<AcmeStandInOptions, 'authority' | 'onIssued' | 'onRevoked'>
}

/**
 * Start every stand-in on loopback.
 * @param options - the subject and per-stand-in options.
 * @returns the running stack.
 */
export async function startStandInStack(options: StandInStackOptions = {}): Promise<StandInStack> {
  const authority = await createTestAuthority('Delo stand-in TLS')
  const subject = options.subject ?? 'stand-in-owner'
  const transparency = await startCtStandIn(authority)
  const issuerA = await startOidcStandIn({ ...options.oidc, authority, subject })
  const issuerB = await startOidcStandIn({ ...options.oidc, authority, subject })
  const acme = await startAcmeStandIn({
    ...options.acme,
    authority,
    onIssued: issuance => { transparency.log(issuance.certificate) },
    onRevoked: issuance => { transparency.revoke(issuance.certificate.sha256) },
  })
  return {
    authority,
    issuerA,
    issuerB,
    acme,
    transparency,
    close: async () => {
      await Promise.all([issuerA.close(), issuerB.close(), acme.close(), transparency.close()])
    },
  }
}
