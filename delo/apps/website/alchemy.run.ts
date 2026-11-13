/**
 * The deployment of the built site: an assets-only Cloudflare Worker serving `out/`, the static directory the site's
 * own build writes. Alchemy runs that build and uploads its output; the site builds without Alchemy. The `prod` stage
 * serves the site's address from `src/site/config.ts`; every other stage has only its workers.dev address.
 *
 * @module @delo/website/alchemy.run
 */
import { fileURLToPath } from 'node:url'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import { SITE_URL } from './src/site/config.ts'

/** The site's directory, where the build runs, whichever directory the command starts in. */
const SITE_DIR = fileURLToPath(new URL('.', import.meta.url))

export default Alchemy.Stack(
  'DeloWebsite',
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const site = yield* Cloudflare.Website.StaticSite('Website', {
      command: 'pnpm run build',
      cwd: SITE_DIR,
      outdir: 'out',
      // The build reads the changelog record outside this directory, which the build hash would not cover.
      memo: false,
      assets: {
        // `/privacy` serves privacy.html, and an address no file has gets 404.html with status 404.
        htmlHandling: 'auto-trailing-slash',
        notFoundHandling: '404-page',
      },
      domain: stage === 'prod' ? new URL(SITE_URL).hostname : undefined,
    })
    return { url: site.url }
  }),
)
