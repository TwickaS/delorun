/**
 * Reach option ids and their listeners, provider states, configuration rows, the
 * Tailscale serve target variants, identity header rules, the certificate authority that
 * own-domain reach names, and error codes, as specified by
 * `delorun/docs/contracts/c07-reach-providers.md`. This module holds readonly constants and
 * types only.
 *
 * @module @delorun/contract-reach-providers
 */
import type { ReachListenerId, StudioAddress } from '@delorun/contract-admission'

/** Reach options of Delorun 1.0, as setup's answers name them. */
export const REACH_OPTION_IDS = ['tailscale-private', 'tailscale-funnel', 'self-hosted-relay'] as const

/** One option id of {@link REACH_OPTION_IDS}. */
export type ReachOptionId = (typeof REACH_OPTION_IDS)[number]

/** The reach listener each option connects. */
export const REACH_OPTION_LISTENERS = {
  'tailscale-private': 'reach-tailscale-private',
  'tailscale-funnel': 'reach-tailscale-funnel',
  'self-hosted-relay': 'reach-self-hosted-relay',
} as const satisfies Record<ReachOptionId, ReachListenerId>

/** Provider states. */
export const REACH_STATES = ['off', 'starting', 'ready', 'degraded', 'blocked', 'stopping', 'failed'] as const

/** One state of {@link REACH_STATES}. */
export type ReachState = (typeof REACH_STATES)[number]

/** Allowed transitions between provider states. */
export const REACH_STATE_TRANSITIONS = {
  off: ['starting'],
  starting: ['ready', 'blocked', 'failed'],
  ready: ['degraded', 'blocked', 'stopping'],
  degraded: ['ready', 'blocked', 'stopping'],
  blocked: ['starting', 'stopping'],
  stopping: ['off'],
  failed: ['starting'],
} as const satisfies Record<ReachState, readonly ReachState[]>

/** Configuration rows of the `@delorun/reach` plugin. Every row is a reach row. */
export interface ReachConfigRows {
  readonly tailscalePrivate?: {
    readonly enabled: boolean
    readonly address: StudioAddress
    /** Default 443. */
    readonly servePort: number
    /**
     * The fixed port on `127.0.0.1` that the serve target names; `0`, the default, until `delorun reach on tailscale`
     * chooses one from {@link LISTENER_PORT_RANGE} and records it.
     */
    readonly listenerPort: number
    /** How often a ready option rereads `tailscale serve status --json` for Funnel; default {@link DEFAULT_SERVE_CHECK_INTERVAL_MS}. */
    readonly serveCheckIntervalMs: number
    /**
     * How many minutes an elevation the person approves for a device on this option lasts: whole minutes from 1 to
     * `ELEVATION_LIMITS.maxMinutes` of `@delorun/contract-oidc-passkeys`, default its `defaultMinutes`.
     */
    readonly elevationMinutes: number
  }
  readonly tailscaleFunnel?: {
    readonly enabled: boolean
    readonly address: StudioAddress
    /** One of {@link FUNNEL_PORTS}; default 8443. */
    readonly funnelPort: (typeof FUNNEL_PORTS)[number]
  }
  readonly selfHostedRelay?: {
    readonly enabled: boolean
    readonly address: StudioAddress
    /** `wss://<tunnel host>/v1/tunnel`. */
    readonly tunnelUrl: string
  }
  readonly certificates?: {
    /** An `https` URL; default is the relay protocol's certificate source. */
    readonly ctSource: string
  }
}

/** Default Tailscale serve port. */
export const DEFAULT_SERVE_PORT = 443 as const

/**
 * The range `delorun reach on tailscale` chooses `tailscalePrivate.listenerPort` from: below the ephemeral ranges of
 * Linux (from 32768), macOS and Windows (from 49152), so an outgoing connection never holds it.
 */
export const LISTENER_PORT_RANGE = { min: 20_000, max: 32_767 } as const

/** Default interval between rereads of `tailscale serve status --json` while Tailscale private is ready: one minute. */
export const DEFAULT_SERVE_CHECK_INTERVAL_MS = 60_000 as const

/** Shortest accepted `tailscalePrivate.serveCheckIntervalMs`: one second. */
export const MIN_SERVE_CHECK_INTERVAL_MS = 1_000 as const

/** Ports Tailscale Funnel accepts. */
export const FUNNEL_PORTS = [443, 8443, 10_000] as const

/** Default Funnel port. */
export const DEFAULT_FUNNEL_PORT = 8443 as const

/**
 * The Tailscale private target. `loopback-tcp` is the fallback and the current contract;
 * `unix-socket` applies only on a platform a recorded spike result adopts it for.
 */
export type TailscaleServeTarget =
  | { readonly variant: 'loopback-tcp'; readonly host: '127.0.0.1'; readonly port: number }
  | { readonly variant: 'unix-socket'; readonly path: string }

/** Socket path of the socket variant, relative to `~/.delorun`; `<profile>` is the CLI profile. */
export const SERVE_SOCKET_PATH = 'run/<profile>/serve.sock' as const

/** Mode of the serve socket after it binds. */
export const SERVE_SOCKET_MODE = 0o600

/** Prefix, compared in any case, of the request headers every listener removes outside the socket variant's socket. */
export const TAILSCALE_HEADER_PREFIX = 'tailscale-' as const

/** The header that names the tailnet login on the socket variant's socket. */
export const TAILSCALE_LOGIN_HEADER = 'Tailscale-User-Login' as const

/** Evidence a spike report records before it adopts the socket variant for a platform. */
export interface ServeSocketSpikeEvidence {
  readonly platform: string
  readonly osVersion: string
  /** Output of `tailscale version`. */
  readonly tailscaleVersion: string
  readonly configureCommand: string
  readonly removeCommand: string
  /** Output of `stat` for the socket. */
  readonly socketStat: string
  /** The user `tailscaled` runs as. */
  readonly tailscaledUser: string
  readonly remoteDeviceResponse: boolean
  /** Each local process kind, and whether it received a response. The variant passes only when none did. */
  readonly reachability: readonly {
    readonly from: 'same-user-unconfined' | 'confined-command' | 'other-local-user' | 'container'
    readonly dialect?: string
    readonly receivedResponse: boolean
  }[]
  readonly forgedHeadersReachedHandler: boolean
}

/** The certificate authority own-domain reach names. */
export const NAMED_CA = {
  name: 'Let\'s Encrypt',
  caaIssuerDomain: 'letsencrypt.org',
  acmeDirectory: 'https://acme-v02.api.letsencrypt.org/directory',
} as const

/** RFC 8657 parameters the named CA documents, which the `own-domain-caa` check asserts. */
export const CAA_ENFORCED_PARAMETERS = ['accounturi', 'validationmethods'] as const

/** The only validation method the home uses while a relay is in the path. */
export const RELAY_PATH_VALIDATION_METHOD = 'tls-alpn-01' as const

/** Zones Delorun controls; an `_acme-challenge` CNAME into one blocks own-domain reach. */
export const DELORUN_CONTROLLED_ZONES = ['delo.run', 'delorun.com'] as const

/** Interval between CAA checks while the provider runs, in milliseconds: 24 hours. */
export const CAA_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Days before expiry at which the home renews a certificate. */
export const CERTIFICATE_RENEW_BEFORE_DAYS = 30 as const

/** Error codes of the providers. */
export const REACH_ERROR_CODES = [
  'TAILSCALE_NOT_INSTALLED',
  'TAILSCALE_NOT_LOGGED_IN',
  'TAILSCALE_ADDRESS_MISMATCH',
  'TAILSCALE_HTTPS_DISABLED',
  'TAILSCALE_SERVE_NOT_PERMITTED',
  'TAILSCALE_SERVE_CONFLICT',
  'TAILSCALE_FUNNEL_ON',
  'FUNNEL_NOT_PERMITTED',
  'PORT_CONFLICT',
  'ELEVATION_MINUTES_INVALID',
  'NO_OWNER',
  'NO_IDENTITY_FACTOR',
  'TAILNET_IDENTITY_UNAVAILABLE',
  'CAA_MISSING',
  'CAA_MISMATCH',
  'CHALLENGE_DELEGATED',
  'RELAY_UNREACHABLE',
  'RELAY_REFUSED',
  'CERTIFICATE_UNEXPLAINED',
] as const

/** One code of {@link REACH_ERROR_CODES}. */
export type ReachErrorCode = (typeof REACH_ERROR_CODES)[number]

/**
 * The one command a person runs to let their user configure `tailscale serve` on Linux. The provider prints it and never
 * runs it, nor any command through `sudo`.
 */
export const TAILSCALE_OPERATOR_COMMAND = 'sudo tailscale set --operator=$USER' as const

/** Payload of the `reach/state` event. */
export interface ReachStateChange {
  readonly option: ReachOptionId
  readonly state: ReachState
  /** Present for `blocked` and `failed`, and for `degraded` when the cause is known. */
  readonly cause?: ReachErrorCode
}
