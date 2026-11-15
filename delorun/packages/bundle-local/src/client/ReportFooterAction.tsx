/** The `sidebar.footer.action` registration of the "Report a problem" button, and the surface it reports. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { ReportFooterButton, type ReportFace } from './ReportProblem.tsx'
import type { StudioSurface } from './report-url.ts'

/** The footer button's props: the copy and the surface it injects. */
export type ReportFooterActionProps = PropsLocale<'delorunPrivacy'> & InjectFace<ReportFace>

/**
 * Where this page runs: a page a reach listener served is on an approved device.
 * @param ctx - the browser plugin context.
 * @returns the surface.
 */
export function studioSurface(ctx: Context): StudioSurface {
  return (ctx.get('connection') as ConnectionHandle | undefined)?.remoteMedia === 'placeholder' ? 'approved device' : 'computer'
}

/**
 * Render the footer button.
 * @param props - the copy and the surface.
 * @returns the button.
 */
export function ReportFooterAction({ t, surface, fetchImpl }: ReportFooterActionProps): ReactNode {
  return <ReportFooterButton t={t} surface={surface} fetchImpl={fetchImpl} />
}
