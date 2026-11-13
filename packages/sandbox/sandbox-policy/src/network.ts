/**
 * The optional network seam of the sandbox policy: a plugin that decides which network a confined execution may reach
 * mounts a {@link SandboxNetworkResolver} as `ctx.sandboxNetwork`, and `ctx.sandboxPolicy.resolve()` asks it for each
 * call's network. While none is mounted, no resolved policy carries a network, and every runner shares the host's.
 *
 * @module dsh-sandbox-policy/network
 */

import type { SandboxNetwork } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional {@link SandboxNetworkResolver}; `ctx.get` returns undefined while none is mounted. */
    sandboxNetwork: SandboxNetworkResolver
  }
}

/** What a {@link SandboxNetworkResolver} decides from. */
export interface SandboxNetworkRequest {
  /** The calling session, absent for an agentless call. */
  readonly session?: Session
  /** The resolved policy's workspace root, in its execution-world spelling. */
  readonly workspaceRoot: string
}

/**
 * Decides the network of one call's policy. It answers synchronously, because policy resolution is synchronous, and
 * must not throw: a resolver that cannot decide answers the most restrictive network it supports.
 */
export interface SandboxNetworkResolver {
  /**
   * The network one call may reach.
   * @param request - the call's session and workspace root.
   * @returns the network, or `undefined` for the host's network.
   */
  (request: SandboxNetworkRequest): SandboxNetwork | undefined
}
