/**
 * The full-access grants the reach-device policy reads (C14, "Elevation"): a device opens a terminal without an unlock
 * in a folder inside a workspace that holds a full-access grant, where the agent already runs commands outside the
 * sandbox. This package declares the service and consumes it; the plugin that keeps the grants provides it. Without a
 * provider no workspace counts as granted, so every terminal needs an unlock.
 *
 * @module @delo/home-auth/full-access-grants
 */

/** The full-access grants of the home, as the plugin that keeps them reads them now. */
export interface ReachFullAccessGrants {
  /**
   * The workspace folders that hold a full-access grant at the moment of the call. A grant withdrawn since the last
   * call is absent, so it applies to the next terminal a device opens.
   * @returns the folders; empty when the grant store cannot be read.
   */
  grantedFolders(): readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The full-access grants the reach-device policy reads before a device's terminal action. */
    reachFullAccessGrants: ReachFullAccessGrants
  }
}
