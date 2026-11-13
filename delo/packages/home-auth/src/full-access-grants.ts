/**
 * The dangerous-mode state the reach-device policy reads (C14, "Elevation"). This package declares the service and
 * consumes it; the plugin that keeps the grants provides it. Neither dangerous mode nor a workspace's full-access grant
 * waives a terminal's unlock.
 *
 * @module @delo/home-auth/full-access-grants
 */

/** The full-access state of the home, as the plugin that keeps the grants reads it now. */
export interface ReachFullAccessGrants {
  /**
   * Whether dangerous mode holds now: the permission-defaults row sets `fullAccessEverywhere` and the grant file
   * `delorun setup` wrote is valid. The reach policy then lifts the refusals that only keep a device from what the
   * computer does (README, "Dangerous mode").
   * @returns whether it holds; false while the store cannot be read.
   */
  dangerousMode(): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The dangerous-mode state the reach-device policy reads. */
    reachFullAccessGrants: ReachFullAccessGrants
  }
}
