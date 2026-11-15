/** The `sidebar.footer.action` registration of the "Report a problem" button, and the surface it reports. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the ctx.uiWorkspace merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
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

/** The draft a "Help me report this" chat starts with: the triage skill's command, left for the person to send. */
export const REPORT_CHAT_DRAFT = '/delorun-report-problem '

/**
 * A function that opens a new chat in the current workspace (or the most recent one) with the report skill's command
 * pre-filled once, never sent; a draft already in the blank chat is kept.
 * @param ctx - the browser plugin context.
 * @returns the opener, which does nothing while the workspace service is absent.
 */
export function reportChatStarter(ctx: Context): () => void {
  return () => { ctx.get('uiWorkspace')?.startSession(undefined, { prompt: REPORT_CHAT_DRAFT, whenDraftExists: 'keep' }) }
}

/**
 * Render the footer button.
 * @param props - the copy and the surface.
 * @returns the button.
 */
export function ReportFooterAction({ t, surface, fetchImpl, startChat }: ReportFooterActionProps): ReactNode {
  return <ReportFooterButton t={t} surface={surface} fetchImpl={fetchImpl} startChat={startChat} />
}
