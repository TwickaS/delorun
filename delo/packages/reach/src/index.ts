/**
 * `@delo/reach`: contract C7's reach providers. The `reach` service holds the provider registry and starts each enabled
 * option over a reach listener of contract C4; `reach-tailscale-private` is the provider this home builds, which declares
 * the `tailnet-membership` identity factor and configures `tailscale serve` through an injected runner, never through
 * `sudo`.
 *
 * @module @delo/reach
 */
export { ReachService, Config as ReachConfig, type Config, type ReachStatus } from './service.ts'
export { TailscalePrivateProvider, TAILSCALE_PRIVATE_VISIBILITY, tailscaleAddress, type ReachProvider, type ReachSpec } from './provider.ts'
export {
  isPermissionRefusal, ReachError, readTailscale, serve, systemTailscale, unserve, type TailscaleFacts, type TailscaleResult, type TailscaleRunner,
} from './tailscale.ts'
export { ReachService as default } from './service.ts'
