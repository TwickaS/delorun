/**
 * The Host's running chats as the update reads them: the chats with an active turn, by session id and title, and the way
 * to stop them all. The CLI's Host fills the service from upstream's agent events; the update plugin reads it to name the
 * chats a "Stop running chats and update" will stop, and to stop them.
 * @module @delorun/plugin-update/chats
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { RunningChatView } from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Where the Host attaches its running chats; present while `@delorun/plugin-update` is mounted. */
    delorunUpdateChats: UpdateChats
  }
}

/** What the Host reports about its running chats. */
export interface ChatSource {
  /**
   * The chats with an active turn now.
   * @returns the id of each chat's session, once each.
   */
  list(): readonly SessionId[]
  /**
   * Cancel every running turn the way the chat's Stop button does, keeping the work so far.
   * @returns when the cancellation has been requested.
   */
  cancelAll(): Promise<void>
  /**
   * The background jobs running now, which {@link cancelAll} also stops.
   * @returns their number.
   */
  jobs(): number
}

/** The service. */
export interface UpdateChats {
  /**
   * Attach the Host's source.
   * @param source - the Host's chats.
   * @returns the detach function.
   */
  attach(source: ChatSource): () => void
  /**
   * The chats running now.
   * @returns the chats; none while no source is attached.
   */
  list(): readonly RunningChatView[]
  /**
   * Stop every running chat.
   * @returns when the cancellation has been requested.
   */
  cancelAll(): Promise<void>
  /**
   * The background jobs running now.
   * @returns their number; 0 while no source is attached.
   */
  jobs(): number
}

/** The `delorunUpdateChats` service. */
export class UpdateChatsService extends Service implements UpdateChats {
  private source: ChatSource | undefined

  /** @param ctx - the plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'delorunUpdateChats')
  }

  /** @inheritdoc */
  attach(source: ChatSource): () => void {
    this.source = source
    return () => { if (this.source === source) this.source = undefined }
  }

  /** @inheritdoc */
  list(): readonly RunningChatView[] {
    return (this.source?.list() ?? []).map((sessionId) => {
      const agent = this.ctx.agents.get(sessionId)
      return { sessionId, title: agent === undefined ? '' : this.ctx.get('sessionTitle')?.get(agent.session)?.title ?? '' }
    })
  }

  /** @inheritdoc */
  cancelAll(): Promise<void> {
    return this.source?.cancelAll() ?? Promise.resolve()
  }

  /** @inheritdoc */
  jobs(): number {
    return this.source?.jobs() ?? 0
  }
}
