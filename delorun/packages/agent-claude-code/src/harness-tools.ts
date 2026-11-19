/**
 * Harness tools offered to Claude Code over the SDK's in-process MCP server. Each program session gets a server with a
 * random name, so a tool name Claude Code asks about matches one of Delorun's own tools only when both the server and
 * the tool name are exactly the ones this session created.
 * @module @delorun/agent-claude-code/harness-tools
 */
import { randomBytes } from 'node:crypto'
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { JsonValue, ProgramHarnessTool } from '@delorun/external-agents/contract'
import z from 'zod'
import { ClaudeCodeDriverError } from './errors.ts'
import type { ClaudeSdk } from './sdk.ts'

/** A tool result as the SDK's MCP server returns it. */
type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>

/** Tool names Claude Code keeps unchanged inside `mcp__<server>__<tool>`. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** What the program's model reads when a harness tool call stopped before it finished. */
export const STOPPED_MESSAGE = 'The harness tool call was stopped before it finished: Claude Code gave up waiting, or the session ended.'

/** The harness tools of one program session. */
export interface HarnessToolServer {
  /** The SDK's server entry for `mcpServers`, keyed by {@link HarnessToolServer.name}. */
  readonly config: McpSdkServerConfigWithInstance
  /** The server's random name. */
  readonly name: string
  /** The full tool names Claude Code asks about, `mcp__<server>__<tool>`, for exactly the offered tools. */
  readonly toolNames: ReadonlySet<string>
}

/**
 * A fresh server name: `delorun_` and 12 random hexadecimal digits.
 * @returns the name.
 */
export function serverName(): string {
  return `delorun_${randomBytes(6).toString('hex')}`
}

/**
 * The Zod object shape the SDK's MCP server takes for a tool's JSON Schema.
 * @param tool - the harness tool.
 * @returns the shape.
 * @throws ClaudeCodeDriverError `harness-tools` when the schema does not describe an object.
 */
function inputShape(tool: ProgramHarnessTool): z.ZodRawShape {
  const schema = tool.inputSchema
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new ClaudeCodeDriverError('harness-tools', `The harness tool ${tool.name} has an input schema that is not a JSON Schema object.`)
  }
  const parsed = z.fromJSONSchema(schema)
  if (!(parsed instanceof z.ZodObject)) throw new ClaudeCodeDriverError('harness-tools', `The harness tool ${tool.name} does not take an object as its input.`)
  return parsed.shape
}

/**
 * The abort signal the MCP server hands a handler, when it hands one.
 * @param extra - the handler's second argument.
 * @returns the signal, or undefined.
 */
function requestSignal(extra: unknown): AbortSignal | undefined {
  if (typeof extra !== 'object' || extra === null || !('signal' in extra)) return undefined
  return extra.signal instanceof AbortSignal ? extra.signal : undefined
}

/**
 * Run one harness tool for the program. The call's signal aborts when Claude Code cancels the request, which it does
 * when its wait limit (`MCP_TOOL_TIMEOUT`) passes, or when the session ends; the tool then sees the abort.
 * @param tool - the harness tool.
 * @param args - the input the server validated against the tool's schema.
 * @param extra - the server's request details, with its abort signal.
 * @param ended - aborts when the session ends.
 * @returns the program's tool result.
 */
async function runTool(tool: ProgramHarnessTool, args: Record<string, unknown>, extra: unknown, ended: AbortSignal): Promise<CallToolResult> {
  const cancelled = requestSignal(extra)
  const signal = cancelled === undefined ? ended : AbortSignal.any([cancelled, ended])
  const input: JsonValue = JSON.parse(JSON.stringify(args))
  try {
    const result = await tool.call(input, signal)
    if (signal.aborted) return { content: [{ type: 'text', text: STOPPED_MESSAGE }], isError: true }
    return { content: [{ type: 'text', text: result.output }], isError: result.isError }
  } catch (error: unknown) {
    if (signal.aborted) return { content: [{ type: 'text', text: STOPPED_MESSAGE }], isError: true }
    return { content: [{ type: 'text', text: `The harness tool ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
  }
}

/**
 * Build the in-process MCP server for one session's harness tools.
 * @param sdk - the loaded SDK.
 * @param tools - the tools the gate offers.
 * @param ended - aborts every running call when the session ends.
 * @param name - the server's name; a fresh random one by default.
 * @returns the server, or undefined when no tool is offered.
 * @throws ClaudeCodeDriverError `harness-tools` for a tool name Claude Code would change, a repeated name, or a schema that is not an object.
 */
export function harnessToolServer(sdk: ClaudeSdk, tools: readonly ProgramHarnessTool[], ended: AbortSignal, name = serverName()): HarnessToolServer | undefined {
  if (tools.length === 0) return undefined
  const seen = new Set<string>()
  const definitions = tools.map((tool): SdkMcpToolDefinition => {
    if (!TOOL_NAME.test(tool.name)) throw new ClaudeCodeDriverError('harness-tools', `The harness tool name ${JSON.stringify(tool.name)} has characters Claude Code would change.`)
    if (seen.has(tool.name)) throw new ClaudeCodeDriverError('harness-tools', `The harness tool ${tool.name} is offered twice.`)
    seen.add(tool.name)
    return { name: tool.name, description: tool.description, inputSchema: inputShape(tool), handler: (args, extra) => runTool(tool, args, extra, ended) }
  })
  return {
    config: sdk.createSdkMcpServer({ name, tools: definitions }),
    name,
    toolNames: new Set(tools.map(tool => `mcp__${name}__${tool.name}`)),
  }
}
