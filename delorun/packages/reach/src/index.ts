/**
 * `@delorun/reach`: contract C7's reach providers. The `reach` service holds the provider registry and starts each enabled
 * option over a reach listener of contract C4; `reach-tailscale-private` is the provider this home builds, which declares
 * the `tailnet-membership` identity factor and configures `tailscale serve` through an injected runner, never through
 * `sudo`.
 *
 * @module @delorun/reach
 */
export { REACH_STATUS_PATH, ReachService, Config as ReachConfig, type Config, type ReachStatus, type ReachSummary } from './service.ts'
export { checkServeAccess, funnelOn, TailscalePrivateProvider, TAILSCALE_PRIVATE_VISIBILITY, tailscaleAddress, type ReachCheck, type ReachProvider, type ReachSpec, type ServeAccessRequest } from './provider.ts'
export { chooseListenerPort, isPortFree, openFront, type LoopbackFront } from './front.ts'
export { checkTailnetPeer, isTailnetAddress, LOCAL_API_OUTPUT_LIMIT_BYTES, LOCAL_API_TIMEOUT_MS, tailscaledSocketPath, type TailnetPeerCheck, type TailnetPeerRefusal } from './tailnet-peer.ts'
export {
  isPermissionRefusal, parseServeRules, ReachError, readComputerUser, readServeRules, readTailscale, removeServe, serve, serveTarget, systemTailscale,
  type ServeRules, type TailscaleFacts, type TailscaleResult, type TailscaleRunner,
} from './tailscale.ts'
export { ReachService as default } from './service.ts'
