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
import type { DeviceId } from '@delo/contract-admission'
import type { IssuedOwnerCode } from './owner-code.ts'
import { HomeAuth, type ClaimRequest, type ClaimResult, type DevicesListing, type RevocationResult } from './home-auth.ts'
import type { OpenSessionRequest, OpenedSession, SessionRecord } from './sessions.ts'
import { claimHandler, devicesHandler, DEVICE_REMOVE_PATH, DEVICES_PATH, OWNER_CLAIM_PATH, removeDeviceHandler } from './routes.ts'

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

  /**
   * @param ctx - the plugin context, which injects the web server.
   * @param config - the secrets directory.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'homeAuth')
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
    })
    await core.start()
    this.core = core
    this.ctx.effect(() => {
      const registered = [
        this.ctx.webServer.register({ kind: 'exact', path: OWNER_CLAIM_PATH, handler: claimHandler(core) }),
        this.ctx.webServer.register({ kind: 'exact', path: DEVICES_PATH, handler: devicesHandler(core) }),
        this.ctx.webServer.register({ kind: 'exact', path: DEVICE_REMOVE_PATH, handler: removeDeviceHandler(core) }),
      ]
      return () => {
        for (const off of registered) off()
      }
    }, 'home-auth routes')
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
