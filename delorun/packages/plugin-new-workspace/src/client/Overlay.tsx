/** The `shell.overlay` entry: draws the dialog while the service has the flow open. */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NewWorkspaceApi } from './api.ts'
import type { CreatedWorkspace } from './NewWorkspaceDialog.tsx'
import { NewWorkspaceDialog } from './NewWorkspaceDialog.tsx'
import type { FolderBrowse } from './screens/FolderScreen.tsx'

/** One open flow: its number, which surface opened it, and the call that ends it. */
export interface OpenFlow {
  /** Distinguishes one opening from the next, so a second opening starts a fresh dialog. */
  readonly id: number
  /** The surface that opened the flow. */
  readonly from: string
}

/** What the overlay entry is given by the service. */
export interface OverlayInjected {
  /** The flow on show, or null while none is open. */
  readonly hooks: { readonly open: HostObservable<OpenFlow | null> }
  /** The Host client. */
  readonly api: NewWorkspaceApi
  /** The studio's folder navigation. */
  readonly browse: FolderBrowse
  /**
   * End a flow without a workspace.
   * @param id - the flow's {@link OpenFlow.id}.
   */
  readonly close: (id: number) => void
  /**
   * End a flow with the workspace it made.
   * @param id - the flow's {@link OpenFlow.id}.
   * @param created - the workspace.
   */
  readonly created: (id: number, created: CreatedWorkspace) => void
}

/** Props of the `shell.overlay` entry. */
export type OverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'delorunNewWorkspace'> & InjectFace<OverlayInjected>

/**
 * Render the dialog while a flow is open.
 * @param props - the open flow hook, the services and the dictionary.
 * @returns the dialog, or nothing.
 */
export function Overlay({ useOpen, api, browse, close, created, t }: OverlayProps) {
  const flow = useOpen(current => current)
  if (flow === null) return null
  return (
    <NewWorkspaceDialog key={flow.id} t={t} api={api} browse={browse} from={flow.from}
      onClose={() => { close(flow.id) }} onCreated={(workspace) => { created(flow.id, workspace) }} />
  )
}
