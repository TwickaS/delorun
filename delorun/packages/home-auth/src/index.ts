/**
 * `@delorun/home-auth`: the owner's claim and the device list of a home (contract C5), over the protected records of
 * `~/.delorun/secrets/home-auth/`.
 *
 * - {@link HomeAuth} — the coordinator: claim, owner, device list, revocation and the sessions a revocation ends; the
 *   reach listeners it serves, the approval window and local approval, sign-in and the synchronous admission of a
 *   session token.
 * - {@link HomeAuthAuthenticator} — the provider of upstream's `authenticator`, which also refuses a full-access grant
 *   answered from a `tailnet-membership` session.
 * - The `reach-device` principal of an approved device's Peers on one listener, and the remote access policy that
 *   allows it only the actions of {@link REACH_ALLOWED_ACTIONS}, those of {@link REACH_ELEVATED_ACTIONS} while the
 *   device holds an unlock on that listener the person approved at the computer, and refuses every other with
 *   `loopback-required: <action>`.
 * - {@link HomeAuthService} — the same behind Cordis as the `homeAuth` service, with the routes registered.
 * - The claim route, the device list route and the removal route, and the refusal a reach listener answers a claim
 *   with; the arrival helpers that decide whether a request came from the loopback listener and which address a claim
 *   records, and {@link requireComputer}, which another Delorun plugin's route calls to refuse a request that did not, and
 *   {@link requireComputerOrDevice}, which lets a reach device's request through to its route's own unlock check.
 * - The stores of the secrets directory with the bounds on the records they hold, the typed refusal and the secret
 *   primitives.
 *
 * @module @delorun/home-auth
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
  type ServedListener,
  type SignInRequest,
  type SignedIn,
  type TokenAdmission,
} from './home-auth.ts'
export { HomeAuthAuthenticator, EXTERNAL_AGENT_REFUSAL, FULL_ACCESS_REFUSAL, WORKSPACE_MANAGEMENT_REFUSAL, matchesPreLogin, defaultPermissionOf, keyRefsOf, protectedEntryIdsOf, computerOnlyEntryIdsOf, type ReachPeer } from './authenticator.ts'
export {
  REACH_ALLOWED_ACTIONS,
  REACH_DANGEROUS_ACTIONS,
  REACH_DENIED_ACTIONS,
  REACH_ELEVATED_ACTIONS,
  REACH_KEY_ACTIONS,
  REACH_EVERYDAY_SETTINGS,
  REACH_EVERYDAY_FIELDS,
  UNDECLARED_KEY_REFUSAL,
  REACH_SHIPPED_BUNDLES,
  REACH_SHIPPED_ROWS,
  REACH_DEVICE,
  REACH_DEVICE_COMMANDS,
  DANGEROUS_LIFTABLE_SWITCHES,
  DEFAULT_PERMISSION_REFUSAL,
  GRACE_PROTECTED_ROW_REFUSAL,
  PROTECTED_ROW_REFUSAL,
  UNLISTED_COMMAND_REFUSAL,
  protectedPluginsIn,
  COMPUTER_ONLY_ROW_MODULES,
  COMPUTER_ONLY_BUNDLES,
  switchOffRefusal,
  type ComputerOnlySwitch,
  type DefaultPermission,
  type PermissionLevel,
  CREATE_OUTSIDE_WORKSPACES,
  GRACE_REFUSED_ACTIONS,
  assertDisjoint,
  createReachAccessPolicy,
  createCondition,
  reachDevicePrincipal,
  reachRefusal,
  PICKER_HOLD_ID,
  type FaceGrantFacts,
  type ReachAccessFacts,
  type ReachDevicePrincipal,
} from './reach-access.ts'
export { Approvals, type RequestOrigin, type ApprovalRecord, type ApprovalRequestInput, type PendingSummary } from './approvals.ts'
export { formatMatchCode, matchCode, typedCodeMatches, type MatchCodeInputs } from './match-code.ts'
export { Challenges, signInMessage, signInVerifies } from './sign-in.ts'
export { loadHomeKey, type HomeKey } from './home-key.ts'
export { REACH_PATHS, REACH_PRE_LOGIN_ROUTES, SIGN_IN_ASSETS, sessionCookie } from './reach-routes.ts'
export { ELEVATION_PATHS } from './elevation-routes.ts'
export type { ReachFullAccessGrants } from './full-access-grants.ts'
export { isElevationMinutes } from './elevation.ts'
export { PIN_PATHS } from './pin-routes.ts'
export { UNLOCK_HEADER, UNLOCK_SUBPROTOCOL_PREFIX } from './unlock-token.ts'
export { readPinSetBacks } from './pin-set-backs.ts'
export type { LiftField } from './dangerous-settings.ts'
export { checkNewSecret, PinModeStore, type PinModeSummary } from './pin-mode.ts'
export { REACH_DEVICE_PATHS, plainPathname, reachesDevicePath, type ReachDevicePath, type ReachDevicePathMatch } from './reach-paths.ts'
export { checkSecretsDirectory, HomeAuthService, Config as HomeAuthConfig, HOME_AUTH_SWITCH, REACH_SWITCH, type Config } from './service.ts'
export {
  mayAskWithoutWindow, PAIRING_BOUNDS, PAIRING_DEFAULTS, REQUEST_DISPLAYS, resolvePairing, tailnetIdentityOf, WINDOWLESS_MODES,
  type PairingConfig, type PairingSpec, type PairingView, type RequestDisplay, type TailnetIdentity, type WindowlessMode,
} from './pairing.ts'
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
export { REQUEST_LISTENER, isLoopbackHost, listenerOf, stampListener, type LoopbackPort, type StampedRequest } from '@delorun/home'
export { hashImage, ICON_FILE_SEGMENTS, readIcon, storeIcon } from './icon-file.ts'
export { ALWAYS_ASK_ACTIONS, AUTH_CLASSES, AUTH_CLASS_NAMES, authClassOf, checkAuthTable, passAdmitsRow, stalePassEntries, type AuthClass, type AuthRow, type AuthSurface } from './auth-classes.ts'
export { GRANT_HEADER, gateByClass, readBodyCapped, type ClassGate, type GateOptions, type GrantGateHome, type LegacyUnlock } from './auth-gate.ts'
export { GRANT_BODY_CAP_BYTES, GRANT_LIFE_MS, HOLD_ABSOLUTE_MS, HOLD_IDLE_MS, PASS_SETTING_ACTION, GrantStore, canonicalJson, hashArgs, hashRequest, type GrantEntry, type GrantHolder, type HoldFeature, type PassEndReason, type PassView } from './grants.ts'
export { PASSKEY_DEVICES_ACTION, PASSKEY_PATHS, PASSKEY_REMOVE_ACTION } from './passkey-routes.ts'
export { admitApprovedDevice, admitKeyDevice, admitUnlockedDevice, gateByUnlock, requireComputer, requireComputerOrDevice, routedPathname, unlockOf, type ComputerRequest, type DangerousModeHome } from './computer-only.ts'
export {
  LOOPBACK_STUDIO_ADDRESS,
  isForeignFetchSite,
  isSameLoopbackOrigin,
  loopbackAddressOf,
} from '@delorun/home'
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
export { DeviceStore, MAX_TRUSTED_DEVICES } from './devices.ts'
export {
  MAX_LIVE_SESSIONS_PER_DEVICE,
  SESSIONS_FILE,
  SessionStore,
  type OpenSessionRequest,
  type OpenedSession,
  type SessionRecord,
  type SessionStoreOptions,
} from './sessions.ts'
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
export { HomeAuthService as default } from './service.ts'
