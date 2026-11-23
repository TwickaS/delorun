/** Extension positions of the root conversation's subagent catalog. */
import type { SessionProjectionMap, SessionProjectionSnapshot, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The projection values of one child chat as the catalog last read them. */
export type SubagentChildValues = SessionProjectionSnapshot['values']

/** What a plugin sees of one catalog row: the catalog entry, the child's summary and its read projections. */
export interface SubagentRowOwner {
  /** The child session this row lists. */
  readonly sessionId: SessionId
  /** The catalog entry's mode: `external` rows are Delorun-less one-shot programs. */
  readonly mode: SessionProjectionMap['subagentCatalog'][number]['mode']
  /** The row's primary label as rendered. */
  readonly label: string
  /** Whether the child is running now. */
  readonly running: boolean
  /** The child's list summary, when the session list holds one. */
  readonly summary: SessionSummary | undefined
  /** The child's projection values as last read; `{}` until the catalog has read them. */
  readonly values: SubagentChildValues
  /** Whether an approval card of the child waits for an answer. */
  readonly awaitingApproval: boolean
  /** Total tokens the row shows, when known. */
  readonly tokens: number | undefined
  /** Elapsed or last-turn duration the row shows, in milliseconds, when known. */
  readonly durationMs: number | undefined
  /** Opens the child's chat and closes the catalog. */
  readonly open: () => void
}

/** What a plugin sees of the whole catalog level behind the trigger. */
export interface SubagentTriggerOwner {
  /** One owner per direct row. */
  readonly rows: readonly Omit<SubagentRowOwner, 'open'>[]
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Content below the root Session's subagent tree. */
    'conversation.session.header.actions.subagent.footer': {
      kind: 'list'
      scope: 'session'
    }
    /**
     * Controls at the end of the root Session's subagent action, after its trigger and inside the same control (for example
     * a view toggle). Shown and hidden with the action; absent contributions render nothing.
     */
    'conversation.session.header.actions.subagent.end': {
      kind: 'list'
      scope: 'session'
      inline: true
    }
    /** Leading mark of a catalog row, before its state dot (for example a monogram). Absent contributions render nothing. */
    'conversation.session.header.actions.subagent.row.lead': {
      kind: 'list'
      scope: 'root'
      inline: true
      owner: SubagentRowOwner
    }
    /** Words on a catalog row's second line, after its mode and activity. */
    'conversation.session.header.actions.subagent.row.detail': {
      kind: 'list'
      scope: 'root'
      inline: true
      owner: SubagentRowOwner
    }
    /** Trailing indicator of a catalog row, after its metrics (for example a limit ring). */
    'conversation.session.header.actions.subagent.row.trail': {
      kind: 'list'
      scope: 'root'
      inline: true
      owner: SubagentRowOwner
    }
    /** Text after the trigger's count (for example "· 2 outside"). */
    'conversation.session.header.actions.subagent.trigger': {
      kind: 'list'
      scope: 'root'
      inline: true
      owner: SubagentTriggerOwner
    }
  }
}
