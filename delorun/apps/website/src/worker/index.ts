/**
 * The Worker in front of the static site: it answers the sign-up routes and runs the daily clean-up.
 *
 * @module @delorun/website/worker
 */
import type { Env } from './env.ts'
import { route, sweep } from './routes.ts'

/** The site Worker: `fetch` routes the sign-up requests; `scheduled` runs the daily clean-up and logs its result. */
export default {
  fetch: (request: Request, env: Env): Promise<Response> => route(request, env),
  scheduled: async (_controller: unknown, env: Env): Promise<void> => {
    const result = await sweep(env)
    console.log('sweep', JSON.stringify(result))
  },
}
