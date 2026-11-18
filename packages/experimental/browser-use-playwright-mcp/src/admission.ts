/** The Session admission the browser mount gets from `ctx.browserUseAdmission`. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionMcpAdmission } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'

/**
 * The admission the mount gets: the `browserUseAdmission` service's answer at each ask, or every Session while no
 * service is provided, and the `browser-use/admission-changed` event as its change reports, so a service provided
 * after the mount is heard too.
 * @param ctx - the provider context.
 * @returns the admission.
 */
export function providedAdmission(ctx: Context): SessionMcpAdmission {
  return {
    admitted: agent => ctx.get('browserUseAdmission')?.admitted(agent) ?? true,
    changed: listener => ctx.on('browser-use/admission-changed', listener),
  }
}
