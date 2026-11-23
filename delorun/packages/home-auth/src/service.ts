/**
 * The `homeAuth` service: the owner's claim and device list as a Cordis plugin, with the routes that answer them and the
 * reach connections that a revocation closes.
 *
 * Mounting the plugin creates `~/.delorun/secrets/home-auth/` at mode 0700, opens the stores and registers the claim route,
 * the device list route and the removal route with the web server, all inside `ctx.effect()`, so disposing the plugin
 * unregisters them. The reach closer is read from `ctx.connection` when it exists: `closeReachConnections({ deviceId })`
 * ends the streams and upgraded sockets a revoked device's sessions admitted, and `closeReachConnections({ sessionId })`
 * those of a session that was rotated or passed its idle limit, its absolute limit or a roll's grace, streams that carry
 * no Peer included.
 *
 * @module @delorun/home-auth/service
 */
import type {} from './full-access-grants.ts'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service, type Volatile } from '@deepseek-ai/cordis'
import type {} from '@delorun/logs/cordis'
import schema from '@deepseek-ai/schemastery'
import type { DeviceId, ReachListenerId } from '@delorun/contract-admission'
import { HOME_AUTH_FILES } from '@delorun/contract-device-approval'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import type { DeviceRecord } from './records.ts'
import { CHALLENGE_LIMIT_BOUNDS, CHALLENGE_LIMIT_DEFAULTS, PAIRING_BOUNDS, PAIRING_DEFAULTS, REQUEST_DISPLAYS, resolvePairing, WINDOWLESS_MODES, type ChallengeLimits, type PairingConfig, type PairingView } from './pairing.ts'
import type { IssuedOwnerCode } from './owner-code.ts'
import {
  HomeAuth, type ClaimArrival, type ClaimRequest, type ClaimResult, type DevicesListing, type RevocationResult, type ServedListener, type TokenAdmission,
} from './home-auth.ts'
import type { PendingSummary } from './approvals.ts'
import type { ElevationChange, ElevationRecord } from './elevation.ts'
import { EVERY_FIELD, type ComputerOnlySwitch } from './reach-access.ts'
import { BRANDING_SETTINGS } from './branding.ts'
import { ICON_FILE_SEGMENTS, readIcon } from './icon-file.ts'
import { DangerousSettingsLedger, type LiftField, type SettingsFieldAccess, type SettingsLift } from './dangerous-settings.ts'
import type { ElevationState } from '@delorun/contract-oidc-passkeys'
import type { OpenSessionRequest, OpenedSession, SessionRecord } from './sessions.ts'
import { claimHandler, devicesHandler, DEVICE_REMOVE_PATH, DEVICES_PATH, OWNER_CLAIM_PATH, removeDeviceHandler, type LoopbackCredential } from './routes.ts'
import {
  approvalRequestHandler, approveHandler, assetHandler, brandingIconHandler, cancelHandler, challengeHandler, pendingHandler, REACH_PATHS, sessionHandler, signInPageHandler,
  windowHandler,
} from './reach-routes.ts'
import { HomeAuthAuthenticator } from './authenticator.ts'
import {
  ELEVATION_PATHS,
  elevationApproveHandler,
  elevationEndGraceHandler,
  elevationLockHandler,
  elevationPendingHandler,
  elevationRequestHandler,
  elevationRevokeHandler,
  elevationStateHandler,
} from './elevation-routes.ts'
import type { UnlockAsker } from './pin-unlocks.ts'
import type { GrantStore } from './grants.ts'
import { PASS_MINUTES, PASS_MINUTES_DEFAULT, type PassMinutes } from './pass-setting.ts'
import { PASSKEY_PATHS, passkeyAddRequestHandler, passkeyApproveHandler, passkeyDevicesHandler, passkeyLockHandler, passkeyPassHandler, passkeyOptionsHandler, passkeyPendingHandler, passkeyPinHandler, passkeyRegisterHandler, passkeyRegisterOptionsHandler, passkeyRemoveHandler, passkeyStateHandler, passkeyVerifyHandler } from './passkey-routes.ts'
import { PIN_PATHS, pinLockHandler, pinModeHandler, pinOffHandler, pinOptionsHandler, pinResumeHandler, pinSetHandler, pinStateHandler, pinTouchHandler, pinUnlockHandler } from './pin-routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The home's owner claim and device list. */
    homeAuth: HomeAuthService
  }
}

/** The service's configuration as `cordis.yml` writes it. */
export interface ConfigInput {
  /** The absolute path of the secrets directory, `~/.delorun/secrets/home-auth`, under the Delorun home. */
  readonly secretsDirectory?: string
  /** The pairing choices, each optional; see {@link Config.pairing}. */
  readonly pairing?: PairingConfig
  /** Seconds between retries of a PIN page's set-back that failed; see {@link Config.pinSetBackRetrySeconds}. */
  readonly pinSetBackRetrySeconds?: number
  /** The sign-in challenge limits, each optional; see {@link Config.challenges}. */
  readonly challenges?: Partial<ChallengeLimits>
  /** Minutes a newly approved device starts unlocked for; see {@link Config.approvalGraceMinutes}. */
  readonly approvalGraceMinutes?: number
  /** The most minutes one unlock lasts from its start; see {@link Config.unlockCapMinutes}. */
  readonly unlockCapMinutes?: number
  /** How long one Face ID opens a pass for until the person chooses; see {@link Config.faceIdPassMinutes}. */
  readonly faceIdPassMinutes?: PassMinutes
}

/** The service's configuration: where the home keeps the sign-in records. */
export interface Config {
  /** The absolute path of the secrets directory, `~/.delorun/secrets/home-auth`, under the Delorun home. */
  readonly secretsDirectory?: string
  /**
   * The pairing choices, read at each use: Settings changes them without a restart. The schema fills Delorun's defaults
   * and fails the load for a value out of bounds. Approval only at the home's own computer, the 8-digit match code, the cancel after 3 wrong codes,
   * the global cap of 5 waiting requests and session rotation on approval are fixed and have no field. A reach device
   * cannot write this section.
   */
  readonly pairing: Volatile<PairingConfig>
  /**
   * Seconds between retries of a setting a PIN page loosened whose set-back failed after PIN mode went off, from 1 to
   * 3600; 30 by default. The timer runs only while such a lift waits.
   */
  readonly pinSetBackRetrySeconds: number
  /**
   * How many sign-in challenges one source and one device may be issued a minute; Delorun's defaults are 60 and 10.
   * Every reach request reaches the home from one source, so the source limit bounds the home as a whole.
   */
  readonly challenges: ChallengeLimits
  /**
   * The minutes after a device is approved during which its first sign-in starts an unlock, from 0 to 60; 15 by default,
   * and never more than the listener's unlock minutes. 0 turns the grace off. The grace admits what any unlock admits and
   * never the computer-only table; the device's own studio ends it when its first-run setup finishes, and a revoke,
   * a lock, a removal or the end of the session ends it too.
   */
  readonly approvalGraceMinutes: number
  /**
   * The most minutes one computer-approved unlock lasts from its start, from 1 to 1440; 480 (8 hours) by default. An
   * unlock slides: its minutes count from the last action that needed it, and this cap ends it however much it is used.
   * It must be at least the unlock minutes of every listener, or the listener is refused at start.
   */
  readonly unlockCapMinutes: number
  /**
   * The deployment's default Face ID pass length in minutes (A499): one of 0, 5, 15, 30 and 60; 15 by default, so never
   * more than 60. 0 is "Every time": no pass opens. The person's choice in Settings, kept in `face-id-pass.json`,
   * replaces it; a value outside the set fails the load.
   */
  readonly faceIdPassMinutes: PassMinutes
}

/** The bounds and default of {@link Config.pinSetBackRetrySeconds}. */
const PIN_RETRY_SECONDS = { min: 1, max: 3600, fallback: 30 } as const

const MINUTE_MS = 60 * 1000

/**
 * A whole-number pairing field with its bounds.
 * @param field - the field, whose bounds {@link PAIRING_BOUNDS} holds.
 * @param fallback - the default.
 * @returns the schema.
 */
function pairingMinutes(field: keyof typeof PAIRING_BOUNDS, fallback: number): schema<number> {
  const { min, max } = PAIRING_BOUNDS[field]
  return schema.number().step(1).min(min).max(max).default(fallback)
}

/**
 * A whole-number challenge limit with its bounds.
 * @param field - the limit, whose bounds {@link CHALLENGE_LIMIT_BOUNDS} holds.
 * @returns the schema, defaulting to Delorun's value.
 */
function challengeLimit(field: keyof ChallengeLimits): schema<number> {
  const { min, max } = CHALLENGE_LIMIT_BOUNDS[field]
  return schema.number().step(1).min(min).max(max).default(CHALLENGE_LIMIT_DEFAULTS[field])
}

/** The plugin's configuration schema. */
export const Config: schema<ConfigInput, Config> = schema.object({
  // The path check belongs to `[Service.init]`, which refuses a relative directory with a sentence naming the problem;
  // a pattern here would answer with the schema's own syntax instead.
  secretsDirectory: schema.string()
    .description('The absolute path of the home-auth secrets directory, ~/.delorun/secrets/home-auth; the bundle sets it, and a profile row that omits it (as the CLI\'s pairing writes do) takes the Delorun home\'s own.'),
  pairing: schema.object({
    mayAskWithoutWindow: schema.union(WINDOWLESS_MODES).default(PAIRING_DEFAULTS.mayAskWithoutWindow).description('Who may ask to pair a device without an approval window: own-user (devices signed in as this computer\'s Tailscale user, the default), tailnet (any device on the tailnet) or window-only (no one).'),
    showRequest: schema.union(REQUEST_DISPLAYS).default(PAIRING_DEFAULTS.showRequest).description('How the studio at this computer shows a request: dialog (a pop-up with the code box, the default), notice (a quiet notice with Enter code) or none (only the lists show it).'),
    windowMinutes: pairingMinutes('windowMinutes', PAIRING_DEFAULTS.windowMs / MINUTE_MS).description('How long an approval window stays open, from 1 to 15 minutes; 5 by default.'),
    requestExpiryMinutes: pairingMinutes('requestExpiryMinutes', PAIRING_DEFAULTS.requestExpiryMs / MINUTE_MS).description('How long a request waits before it expires, from 1 to 10 minutes; 5 by default.'),
    pendingPerIdentity: pairingMinutes('pendingPerIdentity', PAIRING_DEFAULTS.pendingPerIdentity).description('How many requests one Tailscale user may have waiting without a window, from 1 to 5; 1 by default.'),
  }).default({}).description('The pairing choices. Out-of-bounds values fail the load. The computer\'s Settings change them live; a reach device cannot.').volatile(),
  pinSetBackRetrySeconds: schema.number().step(1).min(PIN_RETRY_SECONDS.min).max(PIN_RETRY_SECONDS.max).default(PIN_RETRY_SECONDS.fallback)
    .description('Seconds between retries of a setting a PIN page loosened whose set-back failed after PIN mode went off, from 1 to 3600; 30 by default.'),
  challenges: schema.object({
    perSourcePerMinute: challengeLimit('perSourcePerMinute').description('How many sign-in challenges one source may be issued a minute, from 1 to 600; 60 by default.'),
    perDevicePerMinute: challengeLimit('perDevicePerMinute').description('How many sign-in challenges one trusted device may be issued a minute, from 1 to 600; 10 by default.'),
  }).default({}).description('The sign-in challenge limits. Out-of-bounds values fail the load.'),
  unlockCapMinutes: schema.number().step(1).min(1).max(1440).default(480)
    .description('The most minutes one unlock approved at the computer lasts from its start, from 1 to 1440; 480 (8 hours) by default. An unlock lasts its minutes after the last action that needed it, and this cap ends it however much it is used. It must be at least the unlock minutes.'),
  faceIdPassMinutes: schema.union(PASS_MINUTES).default(PASS_MINUTES_DEFAULT)
    .description('Minutes one Face ID on a device lets strong actions go without asking again, until the person chooses in Settings: 0 (every time), 5, 15, 30 or 60; 15 by default. Adding or removing devices and passkeys, the Face ID settings and remote access always ask.'),
  approvalGraceMinutes: schema.number().step(1).min(0).max(60).default(15)
    .description('Minutes after a device is approved during which its first sign-in starts an unlock, from 0 to 60; 15 by default, and never more than the unlock minutes. 0 turns it off.'),
})

/** What the settings service provides to this package: the live values of a namespace and the writes that set them. */
interface SettingsServiceView {
  describe(): readonly { readonly ns: string; readonly value: unknown }[]
  update(ns: string, patch: object): Promise<void>
  mutate(ns: string, ops: readonly { readonly op: 'unset'; readonly path: readonly string[] }[]): Promise<void>
}

/**
 * Check a secrets directory the way the home does before it opens the stores: an absolute path whose parent is the Delorun
 * home's `secrets` directory. The running home and `delorun reach off` both call this, so they cannot disagree on which
 * directory is the home's.
 * @param directory - the configured directory, or the Delorun home's own `secrets/home-auth` when the row names none.
 * @returns the same directory.
 * @throws {Error} when it is not absolute or does not lie in the home's `secrets` directory.
 */
export function checkSecretsDirectory(directory: string): string {
  if (!directory.startsWith('/')) {
    throw new Error(`home-auth: the secrets directory must be an absolute path, got ${JSON.stringify(directory)}`)
  }
  if (basename(dirname(directory)) !== DELORUN_HOME_ENTRIES.secrets) {
    throw new Error(`home-auth: the secrets directory must lie in the Delorun home's ${DELORUN_HOME_ENTRIES.secrets} directory, got ${JSON.stringify(directory)}`)
  }
  return directory
}

/** The settings writes a reach device is refused: any write to the home-auth row, whose `pairing` and `secretsDirectory` decide who is admitted. */
export const HOME_AUTH_SWITCH: ComputerOnlySwitch = { ns: 'delorun-home-auth', field: EVERY_FIELD, label: 'the home-auth settings' }

/** The settings writes a reach device is refused: any write to the reach row, whose options decide what the home exposes. */
export const REACH_SWITCH: ComputerOnlySwitch = { ns: 'delorun-reach', field: EVERY_FIELD, label: 'the remote-access settings' }

/** The refusal of a device's settings write whose dangerous-mode record could not be saved. */
const RECORD_REFUSAL = 'loopback-required: the home could not record this change to be set back when dangerous mode ends; make it at the home\'s computer'

/** The `homeAuth` service. */
export class HomeAuthService extends Service {
  static inject = ['webServer']
  static Config = Config

  private core: HomeAuth | undefined
  /** The settings a device loosened while dangerous mode held, set back when it ends. */
  private lifts: DangerousSettingsLedger | undefined
  /** The settings an unlocked PIN page loosened, set back when PIN mode turns off. */
  private pinLifts: DangerousSettingsLedger | undefined
  /** Retries the PIN set-back while a lift waits; absent otherwise. */
  private pinRetry: NodeJS.Timeout | undefined

  /** The computer-only switches the mounted plugins registered, which the reach policy reads per call. */
  private readonly switches = new Set<ComputerOnlySwitch>()

  /** The configuration. */
  private readonly config: Config

  /** The absolute path of the secrets directory: the configured one, or the Delorun home's own `secrets/home-auth`. */
  private get secretsDirectory(): string {
    return this.config.secretsDirectory ?? this.ctx.get('dshHomePath')?.('secrets', 'home-auth') ?? ''
  }

  /**
   * @param ctx - the plugin context, which injects the web server.
   * @param config - the secrets directory.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'homeAuth')
    this.config = config
  }

  /**
   * Create the secrets directory, open the stores and register the routes, all owned by this fiber.
   * @throws Error when the secrets directory is not an absolute path; the filesystem failure of `mkdir`.
   */
  protected async [Service.init](): Promise<void> {
    checkSecretsDirectory(this.secretsDirectory)
    const core = new HomeAuth({
      pairing: () => resolvePairing(this.config.pairing.get()),
      directory: this.secretsDirectory,
      challengeLimits: this.config.challenges,
      approvalGraceMinutes: () => this.config.approvalGraceMinutes,
      unlockCapMinutes: () => this.config.unlockCapMinutes,
      passDefaultMinutes: () => this.config.faceIdPassMinutes,
      closeReachConnections: match => this.ctx.get('connection')?.closeReachConnections(match) ?? 0,
      loopbackPort: () => this.ctx.webServer.port,
      secrets: this.ctx.get('delorunSecrets'),
      log: (event) => { this.ctx.logger.info(event) },
    })
    await core.start()
    this.core = core
    this.lifts = new DangerousSettingsLedger(join(this.secretsDirectory, HOME_AUTH_FILES.reachDangerousSettings))
    await this.lifts.load()
    this.pinLifts = new DangerousSettingsLedger(join(this.secretsDirectory, HOME_AUTH_FILES.reachPinSettings), 'PIN mode settings')
    await this.pinLifts.load()
    // A lift left by a run whose PIN mode has since been turned off is set back before the first request.
    await this.endPinSettings()
    // The settings service mounting after this one retries a lift its absence kept.
    this.ctx.inject(['settings'], () => { if (this.pinLifts?.pending() === true) this.endPinSettingsLogged() })
    // A lift left by a run whose mode has ended is set back before the first request; without the permission-defaults
    // provider the mode cannot be read yet, and the first read of it ends the lift.
    if (this.ctx.get('reachFullAccessGrants') !== undefined) await this.endDangerousSettings()
    this.ctx.effect(() => async () => { await core.stop() }, 'home-auth session store')
    this.ctx.effect(() => () => { this.stopPinRetry() }, 'home-auth PIN set-back retry')
    // A mode that ends sets back at once what a device loosened under it, without waiting for a device call or a restart.
    this.ctx.inject(['reachFullAccessGrants'], (grants) => {
      grants.effect(() => grants.reachFullAccessGrants.onDangerousModeEnd(() => { this.setBackLogged() }), 'home-auth: dangerous-mode settings set back')
      // A provider that restarts with the mode already off never fires the ending, so the pass runs at once.
      if (!this.readDangerousMode()) this.setBackLogged()
    })
    // Every start and ending names the device, the listener and the elevation, so the log says who ended it; the label
    // stays out, being the person's own text.
    this.ctx.effect(() => core.onElevationChange((change) => {
      const { deviceId, listener, id } = change.elevation
      const ending = change.kind === 'ended' ? `ended (${change.reason})` : `started until ${new Date(change.elevation.endsAt).toISOString()}`
      this.ctx.logger.info(`home-auth: elevation ${ending}: device=${deviceId} listener=${listener} elevation=${id}`)
    }), 'home-auth elevation log')
    // Every PIN event is logged without the PIN, which is never in an event.
    this.ctx.effect(() => core.onPinEvent((event) => {
      this.ctx.logger.info(`home-auth: pin ${event.kind}${'deviceId' in event ? `: device=${event.deviceId}` : ''}${event.kind === 'wrong' ? ` triesLeft=${String(event.triesLeft)}` : ''}`)
      // Turning the mode off, by any route, sets back what unlocked pages loosened.
      if (event.kind === 'off') {
        this.endPinSettingsLogged()
      }
    }), 'home-auth pin log')
    // A reach device never writes the home-auth or reach rows, unlocked or not, in any mode.
    this.ctx.effect(() => this.registerComputerOnlySwitch(HOME_AUTH_SWITCH), 'home-auth: computer-only home-auth settings')
    this.ctx.effect(() => this.registerComputerOnlySwitch(REACH_SWITCH), 'home-auth: computer-only reach settings')
    const credential = loopbackCredentialOf(this.ctx)
    // The same record the studio edits, read from the one settings store on every request.
    const branding = (): unknown => this.settingsFields().read(BRANDING_SETTINGS.ns, BRANDING_SETTINGS.field)
    const readImage = (hash: string): Uint8Array | undefined => readIcon(this.ctx.get('dshHomePath')?.(...ICON_FILE_SEGMENTS), hash)
    this.ctx.effect(() => {
      const server = this.ctx.webServer
      const registered = [
        server.register({ kind: 'exact', path: OWNER_CLAIM_PATH, handler: claimHandler(core) }),
        server.register({ kind: 'exact', path: DEVICES_PATH, handler: devicesHandler(core, credential) }),
        server.register({ kind: 'exact', path: DEVICE_REMOVE_PATH, handler: removeDeviceHandler(core, credential) }),
        server.register({ kind: 'exact', path: REACH_PATHS.signIn, handler: signInPageHandler(core, branding, readImage) }),
        server.register({ kind: 'exact', path: REACH_PATHS.brandingIcon, handler: brandingIconHandler(core, branding, readImage) }),
        server.register({ kind: 'prefix', path: REACH_PATHS.assets, handler: assetHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.request, handler: approvalRequestHandler(core) }),
        server.register({ kind: 'prefix', path: REACH_PATHS.request, handler: approvalRequestHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.challenge, handler: challengeHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.session, handler: sessionHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.window, handler: windowHandler(core, credential) }),
        server.register({ kind: 'exact', path: REACH_PATHS.pending, handler: pendingHandler(core, credential) }),
        server.register({ kind: 'exact', path: REACH_PATHS.approve, handler: approveHandler(core, credential) }),
        server.register({ kind: 'exact', path: REACH_PATHS.cancel, handler: cancelHandler(core, credential) }),
        server.register({ kind: 'exact', path: ELEVATION_PATHS.state, handler: elevationStateHandler(core) }),
        server.register({ kind: 'exact', path: ELEVATION_PATHS.request, handler: elevationRequestHandler(core) }),
        server.register({ kind: 'exact', path: ELEVATION_PATHS.lock, handler: elevationLockHandler(core) }),
        server.register({ kind: 'exact', path: ELEVATION_PATHS.endGrace, handler: elevationEndGraceHandler(core) }),
        server.register({ kind: 'exact', path: ELEVATION_PATHS.pending, handler: elevationPendingHandler(core, credential) }),
        server.register({ kind: 'exact', path: ELEVATION_PATHS.approve, handler: elevationApproveHandler(core, credential) }),
        server.register({ kind: 'exact', path: ELEVATION_PATHS.revoke, handler: elevationRevokeHandler(core, credential) }),
        server.register({ kind: 'exact', path: PIN_PATHS.state, handler: pinStateHandler(core) }),
        server.register({ kind: 'exact', path: PIN_PATHS.unlock, handler: pinUnlockHandler(core) }),
        server.register({ kind: 'exact', path: PIN_PATHS.touch, handler: pinTouchHandler(core) }),
        server.register({ kind: 'exact', path: PIN_PATHS.lock, handler: pinLockHandler(core) }),
        server.register({ kind: 'exact', path: PIN_PATHS.mode, handler: pinModeHandler(core, credential, () => this.pinSetBackWaiting()) }),
        server.register({ kind: 'exact', path: PIN_PATHS.set, handler: pinSetHandler(core, credential) }),
        server.register({ kind: 'exact', path: PIN_PATHS.off, handler: pinOffHandler(core, credential) }),
        server.register({ kind: 'exact', path: PIN_PATHS.options, handler: pinOptionsHandler(core, credential) }),
        server.register({ kind: 'exact', path: PIN_PATHS.resume, handler: pinResumeHandler(core, credential) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.state, handler: passkeyStateHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.registerOptions, handler: passkeyRegisterOptionsHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.register, handler: passkeyRegisterHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.addRequest, handler: passkeyAddRequestHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.options, handler: passkeyOptionsHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.verify, handler: passkeyVerifyHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.pin, handler: passkeyPinHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.remove, handler: passkeyRemoveHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.devices, handler: passkeyDevicesHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.pending, handler: passkeyPendingHandler(core, credential) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.approve, handler: passkeyApproveHandler(core, credential) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.lock, handler: passkeyLockHandler(core) }),
        server.register({ kind: 'exact', path: PASSKEY_PATHS.pass, handler: passkeyPassHandler(core, credential) }),
      ]
      return () => {
        for (const off of registered) off()
      }
    }, 'home-auth routes')
    this.ctx.plugin(HomeAuthAuthenticator)
  }

  /**
   * The Delorun home the secrets directory lies in, which no device's workspace-file read reaches.
   * @returns its absolute path.
   */
  get delorunHome(): string {
    return dirname(dirname(this.secretsDirectory))
  }

  /**
   * Serve one reach listener with the identity factor its provider declares, and announce the policy change.
   * @param served - the listener, its address and the declared factor.
   * @returns the disposer, which stops serving it and announces that too.
   */
  serve(served: ServedListener): () => void {
    const off = this.state().serve(served)
    this.ctx.emit('authenticator/policy', served.listener)
    return () => {
      off()
      this.ctx.emit('authenticator/policy', served.listener)
    }
  }

  /**
   * The served listener of an id.
   * @param listener - the listener id.
   * @returns its declaration, or undefined.
   */
  servedListener(listener: string): ServedListener | undefined {
    return this.core?.servedListener(listener)
  }

  /**
   * Admit a session token on a reach listener, synchronously; refuses until the service has started.
   * @param token - the token.
   * @param listener - the listener.
   * @param options - whether the session may roll on this request.
   * @returns the admission.
   */
  admitToken(token: string, listener: ReachListenerId, options?: { readonly roll: boolean }): TokenAdmission {
    return this.core?.admitToken(token, listener, options) ?? { kind: 'refused', code: 'NOT_SIGNED_IN' }
  }

  /**
   * Where a request arrived, failing closed: the listener that admitted it, its `Host` and its source.
   * @param request - the request.
   * @returns the arrival; `undefined` listener before the service started.
   */
  arrivalOf(request: Parameters<HomeAuth['arrivalOf']>[0]): ClaimArrival {
    return this.core?.arrivalOf(request) ?? { listener: undefined, host: request.headers.host, source: 'unknown' }
  }

  /**
   * Call a listener for each removed device.
   * @param listener - called with the device id.
   * @returns the disposer.
   */
  onDeviceRemoved(listener: (deviceId: DeviceId) => void): () => void {
    return this.state().onDeviceRemoved(listener)
  }

  /**
   * Call a listener for each elevation that starts or ends (C14, "Elevation").
   * @param listener - called with the change.
   * @returns the disposer.
   */
  onElevationChange(listener: (change: ElevationChange) => void): () => void {
    return this.state().onElevationChange(listener)
  }

  /**
   * The running elevation of one device on one listener.
   * @param deviceId - the device.
   * @param listener - the listener.
   * @returns the elevation, or undefined, also before the service started.
   */
  elevationOf(deviceId: string, listener: ReachListenerId): ElevationRecord | undefined {
    return this.core?.elevationOf(deviceId, listener)
  }

  /**
   * The running PIN mode page unlock one Peer was admitted under.
   * @param unlockId - the id in the Peer's principal.
   * @returns the unlock, or undefined, also before the service started.
   */
  pageUnlockOf(unlockId: string): ElevationRecord | undefined {
    return this.core?.pageUnlockOf(unlockId)
  }

  /**
   * Renew a computer-approved unlock after an action that needed it.
   * @param elevationId - the id of the unlock the action ran under.
   */
  touchUnlock(elevationId: string): void {
    this.core?.touchUnlock(elevationId)
  }

  /**
   * Renew the computer-approved unlock a device holds on a listener, after it typed in an attached terminal.
   * @param deviceId - the device.
   * @param listener - the listener.
   */
  touchDeviceUnlock(deviceId: string, listener: ReachListenerId): void {
    this.core?.touchDeviceUnlock(deviceId, listener)
  }

  /**
   * Whether PIN mode is on.
   * @returns whether it is; false before the service started.
   */
  pinEnabled(): boolean {
    const on = this.core?.pin.enabled() ?? false
    return on
  }

  /**
   * Whether a locked device is refused where an unlock matters: a PIN is set or a passkey is enrolled. Every gate that
   * decides this asks here, so a home with a passkey and no PIN refuses as one with a PIN does.
   * @returns whether it is; false before the service started.
   */
  unlockModeEnabled(): boolean {
    return this.core?.unlockModeEnabled() ?? false
  }

  /**
   * Whether a device holds a passkey.
   * @param deviceId - the device.
   * @returns whether it does; false before the service started.
   */
  deviceHasPasskey(deviceId: string): boolean {
    return (this.core?.passkeyStore.forDevice(deviceId).length ?? 0) > 0
  }

  /**
   * The grants and feature holds a verified assertion or a correct PIN minted.
   * @returns the store, or undefined before the service started.
   */
  faceGrants(): GrantStore | undefined {
    return this.core?.grants
  }

  /**
   * The settings an unlocked PIN page loosened whose set-back failed and is being retried.
   * @returns their namespaces and fields, never their values.
   */
  pinSetBackWaiting(): readonly LiftField[] {
    return this.pinLifts?.waiting() ?? []
  }

  /** Start the retry timer while a PIN lift waits after PIN mode is off, and stop it when none does. */
  private armPinRetry(): void {
    const waiting = this.pinLifts?.pending() === true && this.core?.pin.enabled() !== true
    if (!waiting) {
      this.stopPinRetry()
      return
    }
    if (this.pinRetry !== undefined) return
    this.pinRetry = setInterval(() => { this.endPinSettingsLogged() }, this.config.pinSetBackRetrySeconds * 1000)
    this.pinRetry.unref()
  }

  private stopPinRetry(): void {
    if (this.pinRetry === undefined) return
    clearInterval(this.pinRetry)
    this.pinRetry = undefined
  }

  private endPinSettingsLogged(): void {
    this.endPinSettings().catch((error: unknown) => {
      this.ctx.logger.warn(`home-auth: PIN mode settings could not be set back: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Check the unlock token a page presented against the session that carried it.
   * @param token - the token.
   * @param asker - the device, listener and session the request arrived with.
   * @returns the unlock's id.
   * @throws {HomeAuthError} `UNLOCK_INVALID` for an unknown or ended token, and for one from another device, listener or
   *   session, which also ends the unlock.
   */
  resolvePageUnlock(token: string, asker: UnlockAsker): string {
    return this.state().pin.resolve(token, asker).id
  }

  /**
   * Whether dangerous mode holds now, read from the permission-defaults service when asked. While it does, an unlocked
   * device does what the computer does, except turn the mode on, approve a device and sign in.
   * @returns whether it holds; false without a permission-defaults service or while its store cannot be read.
   */
  dangerousMode(): boolean {
    const holds = this.readDangerousMode()
    // A setting a device loosened does not outlive the mode: the first read that finds it ended sets it back.
    if (!holds && this.lifts?.pending() === true) void this.endDangerousSettings()
    return holds
  }

  private setBackLogged(): void {
    this.endDangerousSettings().catch((error: unknown) => {
      this.ctx.logger.warn(`home-auth: dangerous-mode settings could not be set back: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private readDangerousMode(): boolean {
    try {
      return this.ctx.get('reachFullAccessGrants')?.dangerousMode() ?? false
    } catch (_unreadable) {
      // An unreadable store cannot show the grant, so no refusal is lifted.
      return false
    }
  }

  /**
   * Record the settings a device is about to loosen while dangerous mode holds, with the values they have now.
   * @param lifts - the fields and the values the call sets.
   * @returns undefined once the record is saved to disk, or the refusal the device's write meets when it cannot be (the
   *   write must not proceed unrecorded).
   */
  recordLifts(lifts: readonly SettingsLift[]): string | undefined {
    if (this.lifts === undefined) return RECORD_REFUSAL
    try {
      this.lifts.record(lifts, (ns, field) => this.settingsFields().read(ns, field))
      return undefined
    } catch (error) {
      this.ctx.logger.warn(`home-auth: the record of dangerous-mode settings could not be saved, so a device's settings write was refused: ${error instanceof Error ? error.message : String(error)}`)
      return RECORD_REFUSAL
    }
  }

  /**
   * Write back, through the settings service, every setting a PIN page loosened once PIN mode is off, except one the
   * person changed since.
   * @returns when the pass is done; a failed write is retried at the next call.
   */
  async endPinSettings(): Promise<void> {
    try {
      await this.pinLifts?.revert(this.settingsFields(), () => this.core?.pin.enabled() ?? false, ({ ns, field }) => {
        this.ctx.logger.warn(`home-auth: the PIN mode setting ${ns}.${field} could not be set back; it is retried every ${String(this.config.pinSetBackRetrySeconds)} seconds`)
      })
    } finally {
      this.armPinRetry()
    }
  }

  /**
   * Write back, through the settings service, every setting a device loosened under a mode that has ended, except one
   * the person changed since.
   * @returns when the pass is done; a failed write is retried at the next read of the mode.
   */
  async endDangerousSettings(): Promise<void> {
    await this.lifts?.revert(this.settingsFields(), () => this.readDangerousMode())
  }

  private settingsFields(): SettingsFieldAccess {
    const settings: SettingsServiceView | undefined = this.ctx.get('settings')
    return {
      described: ns => settings?.describe().some(row => row.ns === ns) ?? false,
      read: (ns, field) => Reflect.get(settings?.describe().find(row => row.ns === ns)?.value ?? {}, field),
      write: async (ns, field, value) => {
        if (settings === undefined) throw new Error('home-auth: no settings service is mounted')
        if (value === undefined) await settings.mutate(ns, [{ op: 'unset', path: [field] }])
        else await settings.update(ns, { [field]: value })
      },
    }
  }

  /**
   * Register a setting only the home's own computer turns off: the reach policy refuses a device's settings write that
   * could turn it off, unlocked or not (C14, "What a device may call").
   * @param target - the switch's namespace, field and label.
   * @returns the disposer, which the registering plugin's scope holds while it is mounted.
   */
  registerComputerOnlySwitch(target: ComputerOnlySwitch): () => void {
    const entry = { ...target }
    this.switches.add(entry)
    return () => { this.switches.delete(entry) }
  }

  /**
   * The computer-only switches registered now.
   * @returns the switches.
   */
  computerOnlySwitches(): readonly ComputerOnlySwitch[] {
    return [...this.switches]
  }

  /**
   * Record a signed-in device's request to elevate.
   * @param sessionId - the admitted session.
   * @param session - its record.
   * @returns the device's state, with the code it shows.
   */
  requestElevation(sessionId: string, session: SessionRecord): ElevationState {
    return this.state().requestElevation(sessionId, session)
  }

  /**
   * What one device's own studio shows about elevation.
   * @param deviceId - the device.
   * @param listener - the listener.
   * @returns the state.
   */
  elevationState(deviceId: string, listener: ReachListenerId): ElevationState {
    return this.state().elevationState(deviceId, listener)
  }

  /**
   * End a device's elevation and its waiting request, from the device's own studio.
   * @param deviceId - the device.
   * @param listener - the listener.
   */
  lockElevation(deviceId: string, listener: ReachListenerId): void {
    this.state().lockElevation(deviceId, listener)
  }

  /**
   * The waiting requests and the running elevations, for the home's own computer only.
   * @returns both, without any code.
   */
  elevationsAtComputer(): ReturnType<HomeAuth['elevationsAtComputer']> {
    return this.state().elevationsAtComputer()
  }

  /**
   * Approve a request to elevate with the code the person typed; the home's own computer only.
   * @param requestId - the request.
   * @param typedCode - the code.
   * @returns the elevation that started.
   */
  approveElevation(requestId: string, typedCode: string): ElevationRecord {
    return this.state().approveElevation(requestId, typedCode)
  }

  /**
   * Set or replace the PIN and turn PIN mode on; the home's own computer only. Every page unlock ends.
   * @param secret - the PIN or passcode.
   * @param options - the idle minutes and the lock-when-hidden choice.
   * @returns the kind of secret.
   */
  setPin(secret: string, options: { readonly idleMinutes?: number | undefined; readonly lockWhenHidden?: boolean | undefined }): Promise<'pin' | 'passcode'> {
    return this.state().pin.set(secret, options)
  }

  /**
   * Change the idle minutes and lock-when-hidden of PIN mode without the secret; the home's own computer only.
   * @param options - the new values; a missing one stays.
   * @returns the settings now in force.
   */
  setPinOptions(options: { readonly idleMinutes?: number | undefined; readonly lockWhenHidden?: boolean | undefined }): Promise<{ readonly idleMinutes: number; readonly lockWhenHidden: boolean }> {
    return this.state().pin.setOptions(options)
  }

  /**
   * Turn PIN mode off; the home's own computer only.
   */
  turnPinOff(): Promise<void> {
    return this.state().pin.off()
  }

  /**
   * Resume PIN unlocks after a home-wide pause; the home's own computer only.
   */
  resumePin(): Promise<void> {
    return this.state().pin.resume()
  }

  /**
   * Decline a request or end an elevation; the home's own computer only.
   * @param id - the request id or the elevation id.
   * @returns whether either was found.
   */
  revokeElevation(id: string): boolean {
    return this.state().revokeElevation(id)
  }

  /**
   * Open the approval window, claiming the home for the local person when it has no owner. Callers are the home's own
   * computer only.
   * @returns when the window closes.
   */
  openApprovalWindow(): Promise<number> {
    return this.state().openApprovalWindow()
  }

  /**
   * When the open approval window closes.
   * @returns the time, or undefined with no window open.
   */
  approvalWindowOpenUntil(): number | undefined {
    return this.state().approvals.windowOpenUntil()
  }

  /**
   * The resolved pairing choices.
   * @returns who may ask without a window, how a request is shown and the limits.
   */
  pairing(): PairingView {
    return this.state().pairing()
  }

  /**
   * The pending approval requests.
   * @returns their summaries.
   */
  pendingApprovals(): readonly PendingSummary[] {
    return this.state().pendingApprovals()
  }

  /**
   * Approve a request at the home's own computer.
   * @param requestId - the request.
   * @param typedCode - the match code the person typed.
   * @returns the new device's record.
   */
  approveLocally(requestId: string, typedCode: string): Promise<DeviceRecord> {
    return this.state().approveLocally(requestId, typedCode)
  }

  /**
   * Cancel a pending approval request at the home's own computer, which frees its place among the 5 pending.
   * @param requestId - the request.
   * @throws {HomeAuthError} `APPROVAL_EXPIRED` when the request is not pending.
   */
  cancelApproval(requestId: string): void {
    this.state().approvals.cancel(requestId)
  }

  /**
   * The owner record, or undefined for a home nobody has claimed.
   * @returns the record.
   */
  owner(): ReturnType<HomeAuth['owner']> {
    return this.state().owner()
  }

  /**
   * The owner record, refusing an unclaimed home.
   * @returns the record.
   */
  assertOwner(): ReturnType<HomeAuth['assertOwner']> {
    return this.state().assertOwner()
  }

  /**
   * Claim the home for a device.
   * @param request - the claim message and where it arrived.
   * @returns the records the claim wrote.
   */
  claim(request: ClaimRequest): Promise<ClaimResult> {
    return this.state().claim(request)
  }

  /**
   * The owner and the trusted devices.
   * @returns the listing.
   */
  devices(): Promise<DevicesListing> {
    return this.state().devices()
  }

  /**
   * Sign every paired device out and keep the device list: every session, Face ID pass and unlock ends and their reach
   * connections close, so no earlier cookie or pass is admitted again; a device signs in afresh.
   * @returns how many sessions were removed.
   */
  signAllDevicesOut(): Promise<number> {
    return this.state().signAllDevicesOut()
  }

  /**
   * Revoke a device, ending its live sessions and their reach connections.
   * @param deviceId - the device.
   * @returns what was removed, invalidated and closed.
   */
  revokeDevice(deviceId: DeviceId): Promise<RevocationResult> {
    return this.state().revokeDevice(deviceId)
  }

  /**
   * Print a new owner code.
   * @returns the code and its expiry.
   */
  issueOwnerCode(): Promise<IssuedOwnerCode> {
    return this.state().issueOwnerCode()
  }

  /**
   * Whether an owner code is outstanding and unexpired.
   * @returns whether a claim has a code to compare against.
   */
  ownerCodeOutstanding(): Promise<boolean> {
    return this.state().ownerCodeOutstanding()
  }

  /**
   * Mint a session token and record the session under its digest.
   * @param request - the device, the address and the lifetime.
   * @returns the session id and the token.
   */
  openSession(request: OpenSessionRequest): Promise<OpenedSession> {
    return this.state().openSession(request)
  }

  /**
   * The live session a token names.
   * @param token - the token as presented.
   * @returns the record, or undefined for an unknown or expired token.
   */
  sessionOf(token: string): Promise<SessionRecord | undefined> {
    return this.state().sessionOf(token)
  }

  /**
   * The coordinator this service was mounted with.
   * @returns the coordinator.
   * @throws Error before the service's initialization finished.
   */
  private state(): HomeAuth {
    if (this.core === undefined) throw new Error('home-auth: the service has not started yet')
    return this.core
  }
}

export default HomeAuthService

/**
 * The studio's loopback credential check, as upstream's own loopback routes make it: `connection.requestRejection`,
 * read per request. Without the connection service no request carries the credential, so every device route refuses.
 * @param ctx - the plugin context.
 * @returns the check the device routes take.
 */
export function loopbackCredentialOf(ctx: Context): LoopbackCredential {
  return (request) => {
    const connection = ctx.get('connection')
    return connection === undefined ? 401 : connection.requestRejection(request)
  }
}
