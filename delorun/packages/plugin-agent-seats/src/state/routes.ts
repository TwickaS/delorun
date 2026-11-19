/**
 * The seat's Host routes, as Connection Fetch routes the plugin entry registers behind the unlock guards of the other
 * signed-in routes: `agentSeat.resume` starts a new turn after a reached limit and `agentSeat.chooseModel` keeps the
 * person's model pick. Nothing resumes by itself (EA12): only a request from the person reaches {@link resumeRoute}.
 * @module @delorun/plugin-agent-seats/state/routes
 */
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SeatModelChoices } from '../adapter/state-port.ts'
import type { SeatProjectionState } from './fold.ts'
import type { SeatRecords } from './store.ts'

/** The path of the resume route. */
export const RESUME_PATH = '/api/agentSeat.resume'

/** The path of the model pick route. */
export const CHOOSE_MODEL_PATH = '/api/agentSeat.chooseModel'

/** One route, without the guard the entry puts around it. */
export interface SeatRoute {
  /** The Connection Fetch path. */
  readonly path: string
  /** The accepted methods. */
  readonly methods: readonly ['POST']
  /**
   * Answer one request.
   * @param request - the request, whose JSON body names the child.
   * @returns the JSON answer.
   */
  fetch(request: Request): Promise<Response>
}

/** What the routes need from the rest of the plugin. */
export interface SeatRouteOptions {
  /** The seat children's logged state. */
  readonly records: SeatRecords
  /** The model picks. */
  readonly choices: SeatModelChoices
  /**
   * The workspace key a child's pick is kept under.
   * @param child - the seat child.
   * @returns the key, or undefined.
   */
  workspaceOf(child: SessionId): string | undefined
  /**
   * The workspace key of a child whose Session is not loaded.
   * @param child - the seat child.
   * @returns the key, or undefined.
   */
  coldWorkspaceOf(child: SessionId): Promise<string | undefined>
  /**
   * The logged state of a child whose Session is not loaded, read from its stored log.
   * @param child - the seat child.
   * @returns the fold's state, or undefined when the child has no stored Session.
   */
  coldStateOf(child: SessionId): Promise<SeatProjectionState | undefined>
  /** The clock, in epoch milliseconds. */
  now(): number
}

function answer(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/**
 * Read the request's JSON body as an object.
 * @param request - the request.
 * @returns the object, or undefined when the body is not a JSON object.
 */
async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  let body: unknown
  try {
    body = await request.json()
  } catch (_notJson) {
    // The parser's message quotes the body, so the request is only refused.
    return undefined
  }
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined
}

/**
 * The route that resumes an agent that reached its plan limit, on the person's request and not before the limit lifts.
 * @param options - what the route needs.
 * @returns the route.
 */
export function resumeRoute(options: SeatRouteOptions): SeatRoute {
  return {
    path: RESUME_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      const body = await bodyOf(request)
      if (typeof body?.child !== 'string' || body.child === '') return answer(400, { error: 'the request must be JSON with child' })
      const child = SessionId(body.child)
      // A cold child has nothing to log: its card stays until the person's next message resumes it, which starts the program.
      if (!options.records.isLoaded(child)) return answer(200, { ok: true, cold: true })
      const view = options.records.viewOf(child)
      if (view === null) return answer(404, { error: 'that chat has no live agent' })
      if (view.state !== 'limit') return answer(409, { error: 'the agent is not at a plan limit' })
      if (view.resetAt !== undefined && view.resetAt > options.now()) return answer(409, { error: 'the limit has not lifted yet', resetAt: view.resetAt })
      // Nothing is written into the agent's conversation: the person's next message reopens the program on its saved session.
      options.records.setStatus(child, 'idle')
      return answer(200, { ok: true })
    },
  }
}

/** The characters a model id may have, as the accounts store allows them. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u

/**
 * Keep a pick for a child whose Session is cold. The child's stored log must name a seat provider and show the model
 * picker with the id among the offered models, as for a loaded child. Nothing is logged in the child's chat.
 * @param options - what the route needs.
 * @param child - the seat child.
 * @param id - the model id the person picked.
 * @returns the answer.
 */
async function chooseCold(options: SeatRouteOptions, child: SessionId, id: string): Promise<Response> {
  if (!MODEL_ID.test(id)) return answer(409, { error: 'that model is not offered to pick' })
  const cold = await options.coldStateOf(child)
  if (cold === undefined || cold.provider === null) return answer(404, { error: 'that chat has no live agent' })
  if (cold.shown.state !== 'model-needed' || cold.shown.modelPicker?.offered.some(model => model.id === id) !== true) {
    return answer(409, { error: 'that model is not offered to pick' })
  }
  const workspace = await options.coldWorkspaceOf(child)
  if (workspace === undefined) return answer(409, { error: 'the agent has no workspace to keep the pick for' })
  options.choices.set(workspace, id)
  return answer(200, { ok: true, cold: true })
}

/**
 * The route that keeps the person's pick of one of the plan's offered models for the agent's workspace.
 * @param options - what the route needs.
 * @returns the route.
 */
export function chooseModelRoute(options: SeatRouteOptions): SeatRoute {
  return {
    path: CHOOSE_MODEL_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      const body = await bodyOf(request)
      if (typeof body?.child !== 'string' || body.child === '' || typeof body.id !== 'string' || body.id === '') {
        return answer(400, { error: 'the request must be JSON with child and id' })
      }
      const child = SessionId(body.child)
      if (!options.records.isLoaded(child)) return chooseCold(options, child, body.id)
      const view = options.records.viewOf(child)
      if (view === null) return answer(404, { error: 'that chat has no live agent' })
      const offered = view.modelPicker?.offered.find(model => model.id === body.id)
      if (view.state !== 'model-needed' || offered === undefined) return answer(409, { error: 'that model is not offered to pick' })
      const workspace = options.workspaceOf(child)
      if (workspace === undefined) return answer(409, { error: 'the agent has no workspace to keep the pick for' })
      options.choices.set(workspace, offered.id)
      options.records.notice(child, 'model-chosen', `${offered.label} is picked for this workspace's agent. Your next message starts it.`)
      options.records.setStatus(child, 'idle')
      return answer(200, { ok: true })
    },
  }
}
