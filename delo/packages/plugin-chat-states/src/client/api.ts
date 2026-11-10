/**
 * The studio's calls to the chat-states plugin's routes.
 * @module @delo/plugin-chat-states/client/api
 */
import { CHAT_STATE_PATHS, ChatStatesResponse, type ChatStateRequest } from '../wire.ts'

/** A route answered with a status outside 200 to 299. */
export class ChatStatesRequestError extends Error {
  readonly path: string
  readonly status: number

  /**
   * @param path - the route.
   * @param status - the HTTP status it answered.
   */
  constructor(path: string, status: number) {
    super(`delo chat states: ${path} answered ${String(status)}`)
    this.path = path
    this.status = status
    this.name = 'ChatStatesRequestError'
  }
}

/** The studio's calls to the harness; each rejects with {@link ChatStatesRequestError}, a validation error for an answer that is not the documented one, or a network failure. */
export interface ChatStatesApi {
  /**
   * @param signal - aborts the read.
   * @returns every chat that is settled, snoozed or woke.
   */
  list(signal?: AbortSignal): Promise<ChatStatesResponse>
  /**
   * @param request - the change.
   * @returns every chat's state after it.
   */
  set(request: ChatStateRequest): Promise<ChatStatesResponse>
}

/**
 * Read a route's answer.
 * @param path - the route.
 * @param init - the request.
 * @returns the states the route answered.
 */
async function read(path: string, init: RequestInit): Promise<ChatStatesResponse> {
  const response = await fetch(path.slice(1), { ...init, headers: { accept: 'application/json', ...init.body === undefined ? {} : { 'content-type': 'application/json' } } })
  if (!response.ok) throw new ChatStatesRequestError(path, response.status)
  return ChatStatesResponse.parse(await response.json())
}

/** The calls over the harness's routes, document-relative as upstream's own studio routes are. */
export const chatStatesApi: ChatStatesApi = {
  list: signal => read(CHAT_STATE_PATHS.list, signal === undefined ? {} : { signal }),
  set: request => read(CHAT_STATE_PATHS.set, { method: 'POST', body: JSON.stringify(request) }),
}
