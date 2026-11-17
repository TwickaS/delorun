/**
 * Loading the Claude Agent SDK that upstream's Claude Code pack brings. This is the only Delorun module that loads the
 * SDK as a value, and it does so by a dynamic `import()` of the file the gate's `locate` resolved; everything else names
 * the SDK in `import type` only.
 * @module @delorun/agent-claude-code/sdk
 */
import { pathToFileURL } from 'node:url'
import type {
  AccountInfo, McpSdkServerConfigWithInstance, ModelInfo, Options, SDKControlGetUsageResponse, SDKMessage, SdkMcpToolDefinition, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { ClaudeCodeDriverError } from './errors.ts'
import { locateClaudeSdk, type LocatedClaudeSdk } from '@delorun/external-agents/locate'

/** The SDK version this driver was tested with: the version upstream's `@deepseek-ai/dsh-subagent-claude-code` pins. */
export const TESTED_SDK_VERSION = '0.3.263'

/** The parts of one SDK query the driver uses. */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  /** Interrupt the running turn. */
  interrupt(): Promise<unknown>
  /** End the query and its program process. */
  close(): void
  /** The signed-in account. */
  accountInfo(): Promise<AccountInfo>
  /** Plan rate-limit windows and session totals. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<SDKControlGetUsageResponse>
  /** The models the program offers. */
  supportedModels(): Promise<ModelInfo[]>
}

/** The parts of the SDK module the driver uses. */
export interface ClaudeSdk {
  /**
   * Start a query in streaming-input mode.
   * @param params - the input stream and the options.
   * @returns the query.
   */
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuery
  /**
   * Make an in-process MCP server whose tools run in this process.
   * @param options - the server's name and tools.
   * @returns the server entry for `mcpServers`.
   */
  createSdkMcpServer(options: { name: string; tools: SdkMcpToolDefinition[] }): McpSdkServerConfigWithInstance
}

/**
 * Check a located SDK's version against {@link TESTED_SDK_VERSION}.
 * @param located - the SDK's entry and version.
 * @throws ClaudeCodeDriverError `sdk-version` when the versions differ.
 */
export function assertTestedSdk(located: Pick<LocatedClaudeSdk, 'entry' | 'version'>): void {
  if (located.version === TESTED_SDK_VERSION) return
  throw new ClaudeCodeDriverError('sdk-version', `Claude Code could not start: Delorun was tested with Claude Agent SDK ${TESTED_SDK_VERSION}, but the Claude Code pack brings ${located.version}. Update Delorun or the Claude Code pack so the two match.`)
}

/**
 * Load the SDK from its located entry after checking its version.
 * @param located - the SDK's entry and version, from the gate's `locate`.
 * @returns the SDK module.
 * @throws ClaudeCodeDriverError `sdk-version` for an untested version, `sdk-missing` when the module fails to load.
 */
export async function loadClaudeSdk(located: Pick<LocatedClaudeSdk, 'entry' | 'version'>): Promise<ClaudeSdk> {
  assertTestedSdk(located)
  try {
    const sdk: ClaudeSdk = await import(pathToFileURL(located.entry).href)
    return sdk
  } catch (error: unknown) {
    throw new ClaudeCodeDriverError('sdk-missing', 'Claude Code could not start: the Claude Agent SDK in the Claude Code pack failed to load. Remove and add the Claude Code pack again.', { cause: error })
  }
}

/**
 * Load the SDK the Claude Code pack in a profile brings.
 * @param profileDirectory - the profile's folder, or undefined when the composition has none.
 * @returns the SDK module.
 * @throws ClaudeCodeDriverError `sdk-missing` when the pack or its SDK is not installed; as {@link loadClaudeSdk} otherwise.
 */
export async function loadPackSdk(profileDirectory: string | undefined): Promise<ClaudeSdk> {
  const located = profileDirectory === undefined ? undefined : locateClaudeSdk(profileDirectory)
  if (located === undefined) throw new ClaudeCodeDriverError('sdk-missing', 'Claude Code could not start: the Claude Code pack or the Claude Agent SDK inside it is not installed. Add the Claude Code pack again.')
  return await loadClaudeSdk(located)
}
