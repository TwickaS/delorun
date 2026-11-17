/**
 * The occupant of upstream's three directory-flow holes (the sidebar's Add workspace, the new-chat workspace picker and
 * the hero's workspace choice) under the Delorun look. It draws nothing: when the hole's owner asks for a folder it
 * opens the new-workspace dialog once, hands the workspace's folder back through `onPicked` so the owner adopts and opens
 * it as it does any picked folder, and reports a closed dialog through `onCancel`.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Which surface a hole is, as the dialog's `from`. */
export type DirectoryFlowSource = 'sidebar' | 'picker' | 'hero'

/** What the occupant needs from the plugin. */
export interface DirectoryFlowInjected {
  /** The surface this hole is. */
  readonly from: DirectoryFlowSource
  /**
   * Open the dialog.
   * @param from - the surface.
   * @returns the workspace's folder when one was made or added, or undefined when the dialog was closed.
   */
  readonly openFlow: (from: DirectoryFlowSource) => Promise<string | undefined>
}

/**
 * The renderless occupant. Each change of `open` to true opens the dialog once; a withdrawn request (`open` back to
 * false) leaves a dialog the person is using open, and its outcome is then not reported.
 * @param props - the owner's props and the injected surface and opener.
 * @returns nothing.
 */
export function DelorunDirectoryFlow({ open, onPicked, onCancel, from, openFlow }: DirectoryFlowOwnerProps & DirectoryFlowInjected): ReactNode {
  const request = useRef(0)
  const latest = useRef({ onPicked, onCancel })
  latest.current = { onPicked, onCancel }
  useEffect(() => {
    if (!open) {
      request.current += 1
      return
    }
    const id = ++request.current
    void openFlow(from).then((path) => {
      if (id !== request.current) return
      if (path === undefined) latest.current.onCancel()
      else latest.current.onPicked(path)
    })
  }, [open, from, openFlow])
  return null
}
