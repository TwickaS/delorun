/**
 * The host half of finding local model servers: asks the two well-known loopback addresses for their OpenAI-compatible
 * model listing. The addresses are fixed here and never come from a request, so the probe cannot be pointed elsewhere.
 * The answer carries model ids only, never a response body.
 * @module @delorun/plugin-onboarding/local-models
 */
import { isLoopbackBaseURL, MAX_LOCAL_MODELS, type LocalModelsAnswer, type LocalServer } from './wire.ts'

/** Ollama's and LM Studio's default OpenAI-compatible endpoints. */
export const LOCAL_CANDIDATES: readonly { readonly kind: LocalServer['kind']; readonly baseURL: string }[] = [
  { kind: 'ollama', baseURL: 'http://127.0.0.1:11434/v1' },
  { kind: 'lm-studio', baseURL: 'http://127.0.0.1:1234/v1' },
]

/**
 * Ask one candidate for its models.
 * @param candidate - the server.
 * @param fetchImpl - the request function.
 * @param timeoutMs - the most time the request may take.
 * @returns the server with its model ids, or undefined when it did not answer a usable listing.
 */
async function ask(candidate: typeof LOCAL_CANDIDATES[number], fetchImpl: typeof fetch, timeoutMs: number): Promise<LocalServer | undefined> {
  if (!isLoopbackBaseURL(candidate.baseURL)) return undefined
  try {
    const response = await fetchImpl(`${candidate.baseURL}/models`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    const data = typeof body === 'object' && body !== null ? Reflect.get(body, 'data') : undefined
    if (!Array.isArray(data)) return undefined
    const models: string[] = []
    for (const each of data) {
      const id: unknown = typeof each === 'object' && each !== null ? Reflect.get(each, 'id') : undefined
      if (typeof id === 'string' && id.length > 0 && id.length <= 200) models.push(id)
      if (models.length === MAX_LOCAL_MODELS) break
    }
    return models.length === 0 ? undefined : { ...candidate, models }
  } catch (_absent) {
    // No server listens there, or it answered something else: the step simply offers nothing for it.
    return undefined
  }
}

/**
 * Look for local model servers.
 * @param timeoutMs - the most time one server may take.
 * @param fetchImpl - the request function; the platform's by default.
 * @returns the servers that answered, in {@link LOCAL_CANDIDATES} order.
 */
export async function findLocalServers(timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<LocalModelsAnswer> {
  const found = await Promise.all(LOCAL_CANDIDATES.map(candidate => ask(candidate, fetchImpl, timeoutMs)))
  return { servers: found.filter((each): each is LocalServer => each !== undefined) }
}
