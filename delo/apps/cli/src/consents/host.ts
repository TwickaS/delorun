/**
 * The home process's way to the consent services in the Host it runs: the per-workspace permission defaults of
 * `@delo/plugin-permission-defaults` and the pending reviews of `@delo/plugin-mcp-consent`, which the update channel's
 * `permission.reload` and `mcp.*` operations drive (contract C19). Each call reads the service when the operation
 * arrives, so a consent whose switch is off answers as absent. `delorun start` attaches it to the running Host.
 *
 * @module @delo/cli/consents/host
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LocalConsents } from '@delo/home-process'
// Type-only: the ctx.mcpReviews merge.
import type {} from '@delo/plugin-mcp-consent'
// Type-only: the ctx.permissionDefaults merge.
import type {} from '@delo/plugin-permission-defaults'

/**
 * The consents of a booted Host.
 * @param ctx - the Host's root context.
 * @returns the consents, each reading its service per call.
 */
export function localConsents(ctx: Pick<Context, 'get'>): LocalConsents {
  return {
    reloadPermissions: async () => ctx.get('permissionDefaults')?.reload(),
    pendingServers: () => ctx.get('mcpReviews')?.pending(),
    acceptServer: async (serverName, reviewId) => ctx.get('mcpReviews')?.acceptReview(serverName, reviewId, true),
    declineServer: (serverName, reviewId) => {
      const reviews = ctx.get('mcpReviews')
      if (reviews === undefined) return false
      reviews.declineReview(serverName, reviewId)
      return true
    },
  }
}
