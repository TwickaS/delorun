/**
 * The guide's requests to the harness: each route's answer is parsed strictly, and a route that cannot be asked or
 * answers something else resolves to the value that says so, never a rejection, so a step shows an honest state.
 * @module @delorun/plugin-onboarding/client/host-api
 */
import type { z } from 'zod'
import {
  AGENT_MODELS_PATH, AgentModelsAnswer, DEFER_STEP_PATH, DeferStepAnswer, KEY_TEST_PATH, KeyTestAnswer, LOCAL_MODELS_PATH, LocalModelsAnswer, READINESS_PATH, Readiness, RECOMMEND_PATH, RecommendAnswer, START_PATH, StartAnswer, WORKSPACE_NOTICE_PATH, WorkspaceNoticeAnswer,
} from '../wire.ts'
import type { HostFace, ReachState } from './types.ts'

/** The home's reach status route, which `@delorun/reach` serves while the profile has reach. */
export const REACH_STATUS_PATH = '/delorun/reach/status'

/** The fields of the reach status the guide reads. */
interface ReachSummary { readonly options?: readonly { readonly state?: unknown; readonly address?: unknown }[] }

/**
 * Fetch a route relative to the document and parse its JSON answer.
 * @param path - the route, with its leading `/`.
 * @param schema - the answer's schema.
 * @param body - the JSON body of a `POST`; a `GET` without it.
 * @returns the parsed answer, or undefined when the route cannot be asked or answers something else.
 */
async function ask<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T | undefined> {
  try {
    const response = await fetch(path.slice(1), body === undefined
      ? { headers: { accept: 'application/json' } }
      : { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`answered ${String(response.status)}`)
    return schema.parse(await response.json())
  } catch (error) {
    console.warn(`delorun onboarding: ${path} was not read`, error)
    return undefined
  }
}

/** Whether a page's hostname names this computer's loopback interface. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Read the studio's address over Tailscale.
 * @returns the address of the first ready option; undefined when none is ready, the route is absent or it cannot be read.
 */
export async function readReachAddress(): Promise<string | undefined> {
  try {
    const response = await fetch(REACH_STATUS_PATH.slice(1), { headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const summary = await response.json() as ReachSummary
    const ready = Array.isArray(summary.options) ? summary.options.find(option => option.state === 'ready') : undefined
    return typeof ready?.address === 'string' && ready.address !== '' ? ready.address : undefined
  } catch (error) {
    console.warn('delorun onboarding: the reach address was not read', error)
    return undefined
  }
}

/**
 * Read whether the reach step applies.
 * @returns `remote` when the page is not on this computer's loopback address, `absent` when the route is absent or cannot
 *   be read, `set-up` when an option is ready, `off` otherwise.
 */
export async function readReach(): Promise<ReachState> {
  if (!isLoopbackHostname(location.hostname)) return 'remote'
  try {
    const response = await fetch(REACH_STATUS_PATH.slice(1), { headers: { accept: 'application/json' } })
    if (!response.ok) return 'absent'
    const summary = await response.json() as ReachSummary
    if (!Array.isArray(summary.options)) return 'absent'
    return summary.options.some(option => option.state === 'ready') ? 'set-up' : 'off'
  } catch (error) {
    console.warn('delorun onboarding: the reach status was not read', error)
    return 'absent'
  }
}

/**
 * Read which workspace record files the registry set aside when it started.
 * @returns the file names, oldest first; undefined when the route is absent or cannot be read.
 */
export async function readWorkspaceNotice(): Promise<readonly string[] | undefined> {
  return (await ask(WORKSPACE_NOTICE_PATH, WorkspaceNoticeAnswer))?.setAside
}

/**
 * Read the id of this start of Delorun.
 * @returns the id; undefined when the route is absent or refused, as it is to a phone.
 */
export async function readStartId(): Promise<string | undefined> {
  return (await ask(START_PATH, StartAnswer))?.startId
}

/** The routes, over the page's `fetch`. */
export const hostApi: HostFace = {
  readiness: () => ask(READINESS_PATH, Readiness),
  keyTest: () => ask(KEY_TEST_PATH, KeyTestAnswer, {}),
  localModels: async () => (await ask(LOCAL_MODELS_PATH, LocalModelsAnswer))?.servers,
  agentModels: async agent => await ask(AGENT_MODELS_PATH, AgentModelsAnswer, { agent }) ?? { state: 'unavailable', reason: 'failed' },
  recommend: registry => ask(RECOMMEND_PATH, RecommendAnswer, { registry }),
  reach: readReach,
  reachAddress: readReachAddress,
  defer: async (id, deferred) => (await ask(DEFER_STEP_PATH, DeferStepAnswer, { id, deferred }))?.deferred,
}
