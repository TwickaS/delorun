/**
 * The home process's way to the consent services in the Host it runs: the per-workspace permission defaults of
 * `@delorun/plugin-permission-defaults` and the pending reviews of `@delorun/plugin-mcp-consent`, which the update channel's
 * `permission.reload` and `mcp.*` operations drive (contract C19). Each call reads the service when the operation
 * arrives, so a consent whose switch is off answers as absent. `delorun start` attaches it to the running Host.
 *
 * @module @delorun/cli/consents/host
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LocalConsents } from '@delorun/home-process'
// Type-only: the ctx.mcpReviews merge.
import type {} from '@delorun/plugin-mcp-consent'
// Type-only: the ctx.permissionDefaults merge.
import type {} from '@delorun/plugin-permission-defaults'

/**
 * The consents of a booted Host.
 * @param ctx - the Host's root context.
 * @returns the consents, each reading its service per call.
 */
export function localConsents(ctx: Pick<Context, 'get'>): LocalConsents {
  return {
    reloadPermissions: async () => ctx.get('permissionDefaults')?.reload(),
    pendingServers: () => ctx.get('mcpReviews')?.pending(),
    acceptedServers: async () => ctx.get('mcpReviews')?.accepted(),
    acceptServer: async (serverName, reviewId) => ctx.get('mcpReviews')?.acceptReview(serverName, reviewId, true),
    declineServer: async (serverName, reviewId) => {
      const reviews = ctx.get('mcpReviews')
      if (reviews === undefined) return false
      await reviews.declineReview(serverName, reviewId)
      return true
    },
    revokeServer: async acceptanceId => ctx.get('mcpReviews')?.revokeAcceptance(acceptanceId, true),
  }
}
