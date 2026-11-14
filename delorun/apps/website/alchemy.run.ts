/**
 * The deployment of the built site: a Cloudflare Worker serving `out/`, the static directory the site's own build
 * writes, with the routes that take sign-ups for release news. Alchemy runs that build and uploads its output; the
 * site builds without Alchemy. The `prod` stage serves the site's address from `src/site/config.ts`; every other
 * stage has only its workers.dev address.
 *
 * Each stage has its own D1 database, Turnstile widget and rate limiter. The Worker sends the confirmation message
 * only when `WEBSITE_CONFIRMATION_EMAIL` is `on`; unset, that is `on` for the `prod` stage and `off` for every other.
 * A stage other than `prod` that turns sending on also sets `WEBSITE_PUBLIC_ORIGIN`, the origin its message links use.
 *
 * @module @delorun/website/alchemy.run
 */
import { fileURLToPath } from 'node:url'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import { SITE_URL, SUPPORT_EMAIL, UPDATES_EMAIL } from './src/site/config.ts'
import { resolveSending } from './src/site/sending.ts'

/** The site's directory, where the build runs, whichever directory the command starts in. */
const SITE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Sign-ups a connection may make per period, counted by Cloudflare's rate limiter. */
const SIGNUPS_PER_MINUTE = 5

export default Alchemy.Stack(
  'DelorunWebsite',
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const prod = stage === 'prod'
    const { sending, publicOrigin } = resolveSending(stage, process.env)

    const database = yield* Cloudflare.D1.Database('Subscribers', { name: `delorun-website-${stage}-subscribers`, migrations: `${SITE_DIR}migrations` })
    // A widget serves the hostnames it names and their subdomains: the site's own for prod, any workers.dev address for staging.
    const widget = yield* Cloudflare.Turnstile.Widget('Signup', {
      domains: [prod ? new URL(SITE_URL).hostname : 'workers.dev'],
      mode: 'managed',
    })

    const site = yield* Cloudflare.Website.StaticSite('Website', {
      command: 'pnpm run build',
      cwd: SITE_DIR,
      outdir: 'out',
      // The build reads the changelog record outside this directory, which the build hash would not cover.
      memo: false,
      main: `${SITE_DIR}src/worker/index.ts`,
      crons: ['17 3 * * *'],
      assets: {
        // `/privacy` serves privacy.html, and an address no file has gets 404.html with status 404.
        htmlHandling: 'auto-trailing-slash',
        notFoundHandling: '404-page',
        // Only the sign-up routes reach the Worker; every other address is a file the asset layer serves itself.
        runWorkerFirst: ['/api/*', '/confirm', '/unsubscribe'],
      },
      env: {
        DB: database,
        RATE_LIMIT: Cloudflare.RateLimit('RateLimit', { namespaceId: 1001, simple: { limit: SIGNUPS_PER_MINUTE, period: 60 } }),
        TURNSTILE_SITEKEY: widget.sitekey,
        TURNSTILE_SECRET: widget.secret,
        SEND_CONFIRMATION: sending ? 'on' : 'off',
        SENDER_ADDRESS: UPDATES_EMAIL,
        SUPPORT_ADDRESS: SUPPORT_EMAIL,
        ...(publicOrigin === undefined ? {} : { PUBLIC_ORIGIN: publicOrigin }),
        // The send binding exists only while sending is on, so a stage without Email Service needs none.
        ...(sending ? { EMAIL: Cloudflare.Email.SendEmail('Email', { allowedSenderAddresses: [UPDATES_EMAIL] }) } : {}),
      },
      domain: prod ? new URL(SITE_URL).hostname : undefined,
    })
    return { url: site.url, database: database.databaseName }
  }),
)
