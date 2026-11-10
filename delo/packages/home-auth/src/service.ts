/**
 * The `homeAuth` service: the owner's claim and device list as a Cordis plugin, with the routes that answer them and the
 * reach connections that a revocation closes.
 *
 * Mounting the plugin creates `~/.delo/secrets/home-auth/` at mode 0700, opens the stores and registers the claim route,
 * the device list route and the removal route with the web server, all inside `ctx.effect()`, so disposing the plugin
 * unregisters them. The reach closer is read from `ctx.connection` when it exists: `closeReachConnections({ deviceId })`
 * is what ends the streams and upgraded sockets a revoked device's sessions admitted, streams that carry no Peer
 * included.
 *
 * @module @delo/home-auth/service
 */
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { DeviceId, ReachListenerId } from '@delo/contract-admission'
import type { DeviceRecord } from './records.ts'
import type { IssuedOwnerCode } from './owner-code.ts'
import {
  HomeAuth, type ClaimArrival, type ClaimRequest, type ClaimResult, type DevicesListing, type RevocationResult, type ServedListener, type TokenAdmission,
} from './home-auth.ts'
import type { PendingSummary } from './approvals.ts'
import type { OpenSessionRequest, OpenedSession, SessionRecord } from './sessions.ts'
import { claimHandler, devicesHandler, DEVICE_REMOVE_PATH, DEVICES_PATH, OWNER_CLAIM_PATH, removeDeviceHandler } from './routes.ts'
import {
  approvalRequestHandler, approveHandler, assetHandler, challengeHandler, pendingHandler, REACH_PATHS, sessionHandler, signInPageHandler,
  windowHandler,
} from './reach-routes.ts'
import { HomeAuthAuthenticator } from './authenticator.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The home's owner claim and device list. */
    homeAuth: HomeAuthService
  }
}

/** The service's configuration: where the home keeps the sign-in records. */
export interface Config {
  /** The absolute path of the secrets directory, `~/.delo/secrets/home-auth`, under the Delo home. */
  readonly secretsDirectory: string
}

/** The plugin's configuration schema. */
export const Config: schema<Config> = schema.object({
  // The path check belongs to `[Service.init]`, which refuses a relative directory with a sentence naming the problem;
  // a pattern here would answer with the schema's own syntax instead.
  secretsDirectory: schema.string().required()
    .description('The absolute path of the home-auth secrets directory, ~/.delo/secrets/home-auth.'),
})

/** The `homeAuth` service. */
export class HomeAuthService extends Service {
  static inject = ['webServer']
  static Config = Config

  private core: HomeAuth | undefined

  /** The secrets directory. */
  private readonly config: Config

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
    if (!this.config.secretsDirectory.startsWith('/')) {
      throw new Error(`home-auth: the secrets directory must be an absolute path, got ${JSON.stringify(this.config.secretsDirectory)}`)
    }
    const core = new HomeAuth({
      directory: this.config.secretsDirectory,
      closeReachConnections: match => this.ctx.get('connection')?.closeReachConnections(match) ?? 0,
      loopbackPort: () => this.ctx.webServer.port,
    })
    await core.start()
    this.core = core
    this.ctx.effect(() => async () => { await core.stop() }, 'home-auth session store')
    this.ctx.effect(() => {
      const server = this.ctx.webServer
      const registered = [
        server.register({ kind: 'exact', path: OWNER_CLAIM_PATH, handler: claimHandler(core) }),
        server.register({ kind: 'exact', path: DEVICES_PATH, handler: devicesHandler(core) }),
        server.register({ kind: 'exact', path: DEVICE_REMOVE_PATH, handler: removeDeviceHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.signIn, handler: signInPageHandler(core) }),
        server.register({ kind: 'prefix', path: REACH_PATHS.assets, handler: assetHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.request, handler: approvalRequestHandler(core) }),
        server.register({ kind: 'prefix', path: REACH_PATHS.request, handler: approvalRequestHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.challenge, handler: challengeHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.session, handler: sessionHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.window, handler: windowHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.pending, handler: pendingHandler(core) }),
        server.register({ kind: 'exact', path: REACH_PATHS.approve, handler: approveHandler(core) }),
      ]
      return () => {
        for (const off of registered) off()
      }
    }, 'home-auth routes')
    this.ctx.plugin(HomeAuthAuthenticator)
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
