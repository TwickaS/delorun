/**
 * Whether this studio page is at the person's computer, for the gates in this plugin that show or hide computer-only
 * controls: the pairing notice, the Face ID and PIN sections, the unlock and confirmation hooks, the agent seats' reach
 * and the setup versions page.
 *
 * On the web it is the connection's own answer, `ConnectionHandle.isLoopback`, unchanged. In the Delorun desktop app the page
 * host is `app`, which says nothing about where the person is, so the desktop's reported home kind decides
 * (`@delorun/desktop-home`, A579, A584). A gate only shows or hides a control; the home's own checks stay the authority and
 * still answer `403 LOOPBACK_REQUIRED` to a request that did not arrive on the computer's own listener.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { atComputer } from '@delorun/desktop-home'

/**
 * Whether the page is at the person's computer.
 * @param ctx - the plugin's context; it provides the connection.
 * @returns the desktop's answer in the desktop app, otherwise the connection's `isLoopback`.
 */
export function pageAtComputer(ctx: { readonly get: (name: 'connection') => unknown }): boolean {
  return atComputer((ctx.get('connection') as ConnectionHandle).isLoopback)
}
