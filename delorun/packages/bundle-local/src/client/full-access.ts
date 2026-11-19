/**
 * The service that shows the full-access consent for one workspace: `ctx.delorunFullAccess`, provided by this bundle's
 * browser half for a flow that sets a workspace up, such as `@delorun/plugin-new-workspace`. Source-only, so a consumer
 * takes the type without a build of this bundle.
 */
import type {} from '@deepseek-ai/cordis'

/** What `ctx.delorunFullAccess` shares. */
export interface DelorunFullAccessService {
  /**
   * Show the full-access consent for one workspace, the same consent the permission menu and the Permissions section
   * show, and wait for the person's answer.
   * @param path - the workspace's canonical folder, as the workspace registry holds it.
   * @returns true once the grant is recorded, or when the workspace already holds one; false when the person cancelled,
   * the home does not know the workspace, the profile has no per-workspace consent, or the studio is remote (the
   * consent then names the command for the home's own computer).
   * @throws HostRequestError when the home's workspace list cannot be read for another reason.
   */
  askForWorkspace(path: string): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The full-access consent for one workspace, for a flow that sets a workspace up; absent without this bundle's consent row. */
    delorunFullAccess: DelorunFullAccessService
  }
}
