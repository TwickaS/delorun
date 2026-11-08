/**
 * `@delo/home-auth`: the owner's claim and the device list of a home (contract C5), over the protected records of
 * `~/.delo/secrets/home-auth/`.
 *
 * - {@link HomeAuth} — the coordinator: claim, owner, device list, revocation and the sessions a revocation ends.
 * - {@link HomeAuthService} — the same behind Cordis as the `homeAuth` service, with the routes registered.
 * - The claim route, the device list route and the removal route, and the refusal a reach listener answers a claim
 *   with.
 * - The stores of the secrets directory, the typed refusal and the secret primitives.
 *
 * @module @delo/home-auth
 */
export {
  HomeAuth,
  type ClaimArrival,
  type ClaimRequest,
  type ClaimResult,
  type DeviceSummary,
  type DevicesListing,
  type HomeAuthOptions,
  type OwnerSummary,
  type RevocationResult,
} from './home-auth.ts'
export { HomeAuthService, Config as HomeAuthConfig, type Config } from './service.ts'
export {
  DEVICE_REMOVE_PATH,
  DEVICES_PATH,
  MAX_BODY_BYTES,
  OWNER_CLAIM_PATH,
  claimHandler,
  devicesHandler,
  reachClaimRefusal,
  removeDeviceHandler,
  type RouteHandler,
} from './routes.ts'
export { REQUEST_LISTENER, isLoopbackHost, listenerOf, type StampedRequest } from './arrival.ts'
export {
  HOME_AUTH_HTTP_STATUS,
  HOME_AUTH_LOCAL_CODES,
  HomeAuthError,
  refusalBody,
  type HomeAuthErrorCode,
  type HomeAuthLocalCode,
} from './errors.ts'
export { AttemptLimiter, type AttemptLimiterOptions } from './rate-limit.ts'
export { OwnerCodeStore, type IssuedOwnerCode, type OwnerCodeRecord, type OwnerCodeStoreOptions } from './owner-code.ts'
export { DeviceStore } from './devices.ts'
export { SESSIONS_FILE, SessionStore, type OpenSessionRequest, type OpenedSession, type SessionRecord, type SessionStoreOptions } from './sessions.ts'
export {
  claimLabelOf,
  deviceIdOf,
  devicePublicKeyOf,
  deviceRecordsOf,
  ownerRecordOf,
  type DeviceRecord,
  type OwnerRecord,
} from './records.ts'
export {
  OWNER_CODE_ALPHABET,
  OWNER_CODE_BYTES,
  OWNER_CODE_CHARS,
  REQUEST_SECRET_BYTES,
  SESSION_TOKEN_BYTES,
  base32Encode,
  hashSecret,
  newOwnerCode,
  newSecret,
  normaliseOwnerCode,
  secretMatches,
  systemRandom,
  type RandomBytes,
} from './secret.ts'
