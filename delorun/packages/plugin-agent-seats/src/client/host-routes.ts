/**
 * The two Host routes the chat's buttons call: Resume after a plan limit (EA12) and the model choice (EA22). The names
 * are the Host's `agentSeat.resume` and `agentSeat.chooseModel` methods.
 * @module
 */
import type { SeatClient } from './actions.ts'

/** The routes, as `/api/<service>.<method>`. */
export const SEAT_ROUTES = {
  resume: '/api/agentSeat.resume',
  chooseModel: '/api/agentSeat.chooseModel',
} as const

/** Sends one request; the browser's `fetch`, or a spec's fake. */
export type SeatFetch = (input: string, init?: RequestInit) => Promise<Response>

async function post(fetch: SeatFetch, path: string, body: object): Promise<void> {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}`)
}

/**
 * The client the cards use.
 * @param fetch - the request function.
 * @returns the two actions.
 */
export function createSeatClient(fetch: SeatFetch): SeatClient {
  return {
    resume: sessionId => post(fetch, SEAT_ROUTES.resume, { child: sessionId }),
    chooseModel: (sessionId, modelId) => post(fetch, SEAT_ROUTES.chooseModel, { child: sessionId, id: modelId }),
  }
}
