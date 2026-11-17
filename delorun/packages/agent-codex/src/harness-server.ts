/**
 * The loopback MCP server that offers a seat's harness tools to one Codex thread (D14). It listens on 127.0.0.1 on a
 * port the kernel picks, under a random per-thread server name, and answers only requests that carry the per-thread
 * bearer token and a loopback `Host`. It is named in the thread's own config only, never under the Codex home, and is
 * closed when the program's process ends, which revokes the token.
 *
 * A tool call runs at most `tool_timeout_sec`, the limit Codex is given for the server: Codex fails the call then, so
 * the server aborts it and drops a result that arrives later, reporting it through `onLateResult` (L38).
 * @module @delorun/agent-codex/harness-server
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { JsonValue, ProgramHarnessTool } from '@delorun/external-agents/contract'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/server'

/** One thread's harness MCP server. */
export interface HarnessServer {
  /** The random server name Codex knows the server by, and prefixes its tools with. */
  readonly name: string
  /** The tool names offered. */
  readonly toolNames: ReadonlySet<string>
  /** The thread config's `mcp_servers` entry for the server, token included. */
  readonly mcpServers: { readonly [name: string]: JsonValue }
  /** Stop serving and revoke the token; idempotent. */
  close(): Promise<void>
}

/** What the server needs. */
export interface HarnessServerOptions {
  /** The tools to offer. */
  readonly tools: readonly ProgramHarnessTool[]
  /** Codex's limit for one call, in whole seconds; the server's own limit too. */
  readonly toolTimeoutSeconds: number
  /**
   * Hear a result that arrived after Codex had failed the call; the result is dropped.
   * @param tool - the tool's name.
   */
  readonly onLateResult: (tool: string) => void
}

/** Whether a header holds exactly the expected bearer value, compared in constant time. */
function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  if (header === undefined) return false
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Start a thread's harness MCP server.
 * @param options - the tools, the call limit and the late-result report.
 * @returns the running server.
 */
export async function startHarnessServer(options: HarnessServerOptions): Promise<HarnessServer> {
  const name = `delorun_${randomBytes(6).toString('hex')}`
  const token = randomBytes(32).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)
  const limitMs = options.toolTimeoutSeconds * 1_000
  let revoked = false
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name, version: '0.0.0' }, { capabilities: { tools: {} } })
    for (const tool of options.tools) {
      mcp.registerTool(tool.name, { description: tool.description, inputSchema: fromJsonSchema<JsonValue>(tool.inputSchema as JsonSchemaType) }, async (input, ctx): Promise<CallToolResult> => {
        const deadline = AbortSignal.timeout(limitMs)
        const result = await tool.call(input, AbortSignal.any([ctx.mcpReq.signal, deadline]))
        if (deadline.aborted) {
          options.onLateResult(tool.name)
          return { isError: true, content: [{ type: 'text', text: 'The call ran past its time limit; its result was dropped.' }] }
        }
        return { isError: result.isError, content: [{ type: 'text', text: result.output }] }
      })
    }
    return mcp
  }, { legacy: 'stateless' })
  const handle = toNodeHandler(handler)
  let port = 0
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Only this thread's Codex holds the token; a page in a browser cannot send it, and the Host check stops rebinding.
    if (revoked || request.headers.host !== `127.0.0.1:${String(port)}` || !bearerMatches(request.headers.authorization, expected)) {
      response.writeHead(401).end()
      return
    }
    // Node's request carries explicit undefined on optional fields the adapter's type leaves out.
    await handle(request as NodeIncomingMessageLike, response)
  }
  const server = createServer((request, response) => {
    serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the harness MCP server has no TCP port')
  port = address.port
  let closing: Promise<void> | undefined
  return {
    name,
    toolNames: new Set(options.tools.map(tool => tool.name)),
    mcpServers: {
      [name]: {
        url: `http://127.0.0.1:${String(port)}/mcp`,
        http_headers: { Authorization: `Bearer ${token}` },
        tool_timeout_sec: options.toolTimeoutSeconds,
      },
    },
    close: () => {
      revoked = true
      closing ??= (async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
        await handler.close()
      })()
      return closing
    },
  }
}
