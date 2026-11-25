/**
 * The `admitPeer` of an exact Fetch route, decided by the Host's remote access policy for the action the route serves.
 *
 * An exact Fetch route bypasses the Gateway's access checks, so a Peer other than the owner reaches one only when the
 * route admits it (`@deepseek-ai/dsh-client-connection`'s shared Fetch handler). A route that decides its own admission
 * restates a rule the policy already owns, and the two drift: the policy allows an action while the route refuses the
 * Peer that may take it. {@link peerAdmission} asks the policy instead, so a route admits exactly the Peers the policy
 * admits for the action it serves, and a route that names no action stays owner-only.
 *
 * @module @deepseek-ai/dsh-api-remote-access/peer-admission
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessAction, RemoteAccessDecision, RemoteAccessRequest, RemoteAccessResource } from './types.ts'

/**
 * Where a request names the resource its action is decided on.
 *
 * `global` is the resource an action that names no Session or Workspace is decided on. A `session` row reads the
 * Session id from the named query parameter; a Fetch route that names a Session any other way adds its row here, so a
 * route cannot invent a resource the policy does not bind.
 */
export type PeerAdmissionResource = 'global' | { readonly kind: 'session'; readonly query: string }

/** What {@link peerAdmission} asks of the Host's remote access. */
export interface PeerAdmissionAccess {
  /**
   * Decide one request whose resources the caller resolved.
   * @param request - the caller, the action, and the resources it touches.
   * @returns the decision.
   */
  decide(request: RemoteAccessRequest<Principal>): RemoteAccessDecision
}

/**
 * The resource one request names.
 * @param request - the request; only its URL is read.
 * @param resource - where the request names its resource.
 * @returns the resource, or undefined when the request names none.
 */
function resourceOf(request: Request, resource: PeerAdmissionResource): RemoteAccessResource | undefined {
  if (resource === 'global') return { kind: 'global' }
  const id = new URL(request.url).searchParams.get(resource.query)
  if (id === null || id === '') return undefined
  return { kind: 'session', id: brandString<SessionId>(id) }
}

/** What one route serves, as the policy is asked about it. */
export interface PeerAdmissionSpec {
  /** The action the route serves, such as `session/page`. */
  readonly action: RemoteAccessAction
  /** Where the request names the resource the action is decided on. */
  readonly resource: PeerAdmissionResource
  /**
   * The call's arguments, for a route that serves one exact call of its action rather than the action in general. A
   * route that serves a command's output names that command, so the policy decides the same call the command made.
   * @param request - the request.
   * @param sessionId - the Session the request named.
   * @returns the arguments, or undefined when the request names none.
   */
  readonly args?: (request: Request, sessionId: string) => Readonly<Record<string, unknown>> | undefined
}

/**
 * Build the `admitPeer` of a route from the Host's remote access decision for the action the route serves.
 *
 * The route admits a Peer exactly where the policy allows that action on the resource the request names, so the route
 * grants no Peer more than the Remote method of the same action does. A request that names no resource, and a
 * composition that mounts no remote access, admit no Peer but the owner: a route is refused by default, never admitted
 * by default.
 * @param spec - the action the route serves, the resource it names, and the arguments of an exact call.
 * @param access - a way to the mounted remote access, read when a request arrives; undefined admits no Peer.
 * @returns the function for `ConnectionFetchRoute.admitPeer`.
 */
export function peerAdmission(
  spec: PeerAdmissionSpec,
  access: () => PeerAdmissionAccess | undefined,
): (request: Request, peer: { readonly principal: Principal }) => boolean {
  return (request, peer) => {
    const policy = access()
    if (policy === undefined) return false
    const resource = resourceOf(request, spec.resource)
    if (resource === undefined) return false
    const args = spec.args?.(request, resource.kind === 'global' ? '' : resource.id)
    if (spec.args !== undefined && args === undefined) return false
    return policy.decide({
      principal: peer.principal,
      action: spec.action,
      resources: [resource],
      ...args === undefined ? {} : { args },
    }).kind === 'allow'
  }
}
