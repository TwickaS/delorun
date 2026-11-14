/**
 * Where the studio goes when the chat in the main pane moves to the trash. Upstream clears the main pane once the chat
 * it shows is archived, which leaves "Choose a workspace to start" and the keyboard on the page body. After a chat
 * moved, the trash opens a new chat in the workspace the chat was in, through upstream's New chat; after a workspace
 * moved, it waits until the workspace leaves the list and opens a new chat in the current or latest workspace, which
 * clears the main pane when no workspace is left. Once the main pane no longer shows the chat, focus left on the page
 * body moves to the composer card, the element upstream's composer itself focuses on a phone; on a desktop the composer
 * has already put the keyboard in the message box.
 * @module @delorun/plugin-trash/client/leave
 */
import { focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A workspace's id, as upstream's New chat takes it. */
type WorkspaceId = NonNullable<Parameters<UiWorkspace['startSession']>[0]>

/** The selector of upstream's composer card, which holds the message box; `tabindex="-1"`, so it takes focus. */
export const COMPOSER_CARD = '[data-composer-card]'

/** What leaving the trashed chat reads and does on the page. */
export interface TrashLeaveDeps {
  /**
   * The chat the main pane shows.
   * @returns the chat, or `undefined` while the main pane shows none.
   */
  readonly openChat: () => SessionId | undefined
  /**
   * The workspace a chat is listed in.
   * @param sessionId - the chat.
   * @returns the workspace, or `undefined` for a chat in no workspace.
   */
  readonly workspaceOf: (sessionId: SessionId) => WorkspaceId | undefined
  /**
   * Whether a workspace is still in the list.
   * @param workspaceId - the workspace.
   * @returns true while the list holds it.
   */
  readonly listed: (workspaceId: WorkspaceId) => boolean
  /**
   * Open a new chat, as upstream's New chat does.
   * @param workspaceId - the workspace; without one, the current or latest workspace.
   */
  readonly startChat: (workspaceId?: WorkspaceId) => void
  /**
   * Follow the main pane's chat and the workspace list.
   * @param listener - called after either changes.
   * @returns the disposer.
   */
  readonly subscribe: (listener: () => void) => () => void
  /** The page whose focus is settled. */
  readonly document: Document
}

/** Moves the main pane and the keyboard on after the chat it shows moved to the trash; one per page. */
export class TrashLeave {
  private readonly deps: TrashLeaveDeps
  private readonly waits = new Set<() => void>()
  private disposed = false

  /** @param deps - the page's chat, workspaces, New chat and document. */
  constructor(deps: TrashLeaveDeps) {
    this.deps = deps
  }

  /**
   * Read the main pane before a chat moves to the trash.
   * @param sessionId - the chat about to move.
   * @returns the step to take once the move succeeded, or `undefined` when the main pane shows another chat.
   */
  chat(sessionId: SessionId): (() => void) | undefined {
    if (this.deps.openChat() !== sessionId) return undefined
    const workspaceId = this.deps.workspaceOf(sessionId)
    return () => {
      if (this.disposed) return
      this.deps.startChat(workspaceId)
      this.settle(sessionId)
    }
  }

  /**
   * Read the main pane before a workspace moves to the trash.
   * @param workspaceId - the workspace about to move.
   * @returns the step to take once the move succeeded, or `undefined` when the main pane shows no chat of it.
   */
  workspace(workspaceId: WorkspaceId): (() => void) | undefined {
    const open = this.deps.openChat()
    if (open === undefined || this.deps.workspaceOf(open) !== workspaceId) return undefined
    return () => {
      // New chat picks the current or latest workspace from the list, so it waits until the list drops this one.
      this.when(() => !this.deps.listed(workspaceId), () => {
        this.deps.startChat()
        this.settle(open)
      })
    }
  }

  /** Stop every wait; later steps do nothing. */
  dispose(): void {
    this.disposed = true
    for (const stop of [...this.waits]) stop()
  }

  /**
   * Once the main pane no longer shows the chat, and after the composer had a frame to take focus, move a keyboard
   * left on the page body to the composer card.
   * @param left - the chat that moved to the trash.
   */
  private settle(left: SessionId): void {
    this.when(() => this.deps.openChat() !== left, () => {
      const view = this.deps.document.defaultView
      /* v8 ignore next -- a document the studio renders in always has its window. */
      if (view === null) return
      const frame = view.requestAnimationFrame(() => {
        this.waits.delete(cancel)
        const { activeElement, body } = this.deps.document
        if (activeElement !== null && activeElement !== body) return
        const card = this.deps.document.querySelector<HTMLElement>(COMPOSER_CARD)
        if (card !== null) focusWithoutRing(card, { preventScroll: true })
      })
      const cancel = (): void => {
        this.waits.delete(cancel)
        view.cancelAnimationFrame(frame)
      }
      this.waits.add(cancel)
    })
  }

  /**
   * Run a step once a condition holds: now, or after the change that makes it hold.
   * @param ready - the condition.
   * @param step - the step.
   */
  private when(ready: () => boolean, step: () => void): void {
    if (this.disposed) return
    if (ready()) {
      step()
      return
    }
    const stop = (): void => {
      this.waits.delete(stop)
      unsubscribe()
    }
    const unsubscribe = this.deps.subscribe(() => {
      if (!ready()) return
      stop()
      step()
    })
    this.waits.add(stop)
  }
}
