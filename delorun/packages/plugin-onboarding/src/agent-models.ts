/**
 * The host half of the agents step's model choice: asks an installed agent's provider which models it offers.
 * @module @delorun/plugin-onboarding/agent-models
 */
import type { AgentModelOption, AgentModelsAnswer, AgentModelsRequest } from './wire.ts'

/** What an agent provider offers when it can list its models; the Claude Code and Codex providers do. */
export interface ModelListingProvider {
  /**
   * @param cwd - a usable working directory for the agent's process.
   * @param signal - cancellation.
   * @returns the agent's models.
   */
  listModels(cwd: string, signal: AbortSignal): Promise<readonly AgentModelOption[]>
}

/**
 * @param provider - a registered subagent provider, or undefined.
 * @returns whether it can list models.
 */
function listsModels(provider: object | undefined): provider is ModelListingProvider {
  return provider !== undefined && 'listModels' in provider && typeof provider.listModels === 'function'
}

/** What the lookup needs from the harness. */
export interface AgentModelsDeps {
  /**
   * @param name - a provider name on the subagent registry, such as `claude-code`.
   * @returns the provider, or undefined when its package is not installed and running.
   */
  readonly provider: (name: AgentModelsRequest['agent']) => object | undefined
  /** A directory the agent's process may start in. */
  readonly cwd: () => string
  /** The most time the agent may take, in milliseconds. */
  readonly timeoutMs: number
  /**
   * Write one line to the harness's log.
   * @param message - the line.
   */
  readonly warn: (message: string) => void
}

/**
 * Ask the agent for its models.
 * @param agent - which agent.
 * @param deps - the harness parts.
 * @returns the models, or `unavailable` when the agent is not running, did not answer in time or failed.
 */
export async function listAgentModels(agent: AgentModelsRequest['agent'], deps: AgentModelsDeps): Promise<AgentModelsAnswer> {
  const provider = deps.provider(agent)
  if (!listsModels(provider)) return { state: 'unavailable' }
  try {
    const models = await provider.listModels(deps.cwd(), AbortSignal.timeout(deps.timeoutMs))
    return { state: 'listed', models: models.map(each => ({ model: each.model, displayName: each.displayName })) }
  } catch (error) {
    deps.warn(`the ${agent} model list was not read: ${error instanceof Error ? error.message : String(error)}`)
    return { state: 'unavailable' }
  }
}
