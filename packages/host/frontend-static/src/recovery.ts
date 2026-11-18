/** The index injection row through which a distribution names its recovery routes. */

/**
 * The `global` index injection row name through which a distribution names its recovery routes; the boot page
 * (`RECOVERY_ROUTES_GLOBAL` of `@deepseek-ai/dsh-client-web`) reads the same name and offers no recovery screen
 * without it.
 */
export const RECOVERY_ROUTES_GLOBAL = 'dshRecoveryRoutes'
