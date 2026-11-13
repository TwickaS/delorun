/**
 * The Worker in front of the static site: it answers the sign-up routes and runs the daily clean-up.
 *
 * @module @delo/website/worker
 */
import type { Env } from './env.ts'
import { route, sweep } from './routes.ts'

export default {
  fetch: (request: Request, env: Env): Promise<Response> => route(request, env),
  scheduled: async (_controller: unknown, env: Env): Promise<void> => {
    const result = await sweep(env)
    console.log('sweep', JSON.stringify(result))
  },
}
