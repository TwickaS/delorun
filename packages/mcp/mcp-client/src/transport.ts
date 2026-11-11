/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/**
 * The environment one stdio MCP server starts from: the subprocess seam's
 * scrubbed parent env (credential-shaped names, denylisted ambient
 * authorities, and names whose value has a credential shape dropped) with the
 * configured `env` merged over it. This merge is the only pass-through: the
 * SDK owns the actual spawn and pre-merges its own small default name list
 * (`HOME`, `PATH`, `TERM`, `USER`, …), all of which the scrub already keeps,
 * so a credential reaches the child only when this config names it.
 * @param extra - the plugin config's explicit environment entries.
 * @returns the child process environment.
 */
export function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * The complete environment the stdio transport starts a server with: the
 * SDK's default inherited names (`HOME`, `PATH`, `TERM`, `USER`, … from the
 * Host's environment, without values that start with `()`) with
 * {@link buildChildEnv} merged over them, in the order the SDK's spawn merges
 * them. The `PATH` a bare command is looked up in is this environment's.
 * @param extra - the plugin config's explicit environment entries.
 * @returns the environment the child process receives.
 */
export function childSpawnEnv(extra: Record<string, string>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...buildChildEnv(extra) }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers } },
      )
  }
}
