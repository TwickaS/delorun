# Delorun product website

English | [中文](README.zh.md)

This package builds delorun.com, Delorun's product site: a home page, a blog index, a privacy page and a not-found page, as a static site on TanStack Start, with a small Worker that takes sign-ups for release news. Documentation lives on the [documentation site](../docs/README.md), which the pages link. The site is a private workspace with its own lockfile, so it is outside the repository's root workspace.

## Routes

| Route | Serves |
| --- | --- |
| `/` | The home page: a mosaic of real studio screenshots in the shape of the Delorun mark with the promise and the install command, a zoom into a film of one real job, the case for people who take their tools apart, a wall of every screenshot, and the sign-up. See [`DESIGN.md`](DESIGN.md) |
| `/blog` | The articles in `content/blog/`, newest first, or a line saying there are none. The header, the footer and the sitemap link it only once an article is published |
| `/sitemap.xml`, `/robots.txt` | The sitemap, written by the build from the pages that exist, and the robots file in `public/` that names it |
| `/privacy` | What the site collects, what its host logs and where to read what the program sends |
| `/404` | The page a host serves, from `404.html`, for an address no file has |
| `POST /api/subscribe` | Takes the sign-up form: validates it, rate-limits the connection, verifies the Turnstile token with Siteverify, then stores or refreshes a `pending` record. Every accepted sign-up gets the same answer, whether or not the address was known |
| `GET /api/signup-config` | The Turnstile site key, which the form fetches when a visitor first uses it |
| `GET /confirm?token=` | A page with a button; `POST /confirm` confirms the address. A link opened by a mail scanner therefore cannot confirm anyone |
| `GET /unsubscribe?token=` | Unsubscribes at once. `POST /unsubscribe?token=` does the same for a mail program's one-click `List-Unsubscribe-Post`. Both are idempotent |

The static files come from `out/`; only the four sign-up routes reach the Worker (`runWorkerFirst` in [`alchemy.run.ts`](alchemy.run.ts)). The Worker is in [`src/worker`](src/worker/routes.ts), and the sign-up form is [`src/components/signup.tsx`](src/components/signup.tsx).

## Blog

An article is one Markdown file in [`content/blog/`](content/blog), named `YYYY-MM-DD-slug.md` with a lower-case slug. It starts with a front matter block of `key: value` lines between two `---` lines: `title`, `date` (the same date as in the file name) and `summary` are required, and `crosspost` is the optional `https` address of the copy on a developer platform that points back to the original. [`src/site/blog.ts`](src/site/blog.ts) parses the files, and a malformed file stops the build. The index shows each article's title, date and summary, and links the cross-posted copy when there is one.

## Sign-ups for release news

Each stage has its own D1 database, `delorun-website-<stage>-subscribers`, created from [`migrations/0001_subscribers.sql`](migrations/0001_subscribers.sql) when Alchemy deploys. The table `subscribers` holds `email` (unique, case-insensitive), `first_name`, the consent record (`consent_at`, `consent_page`, `consent_text_version`), `status` (`pending`, `confirmed` or `unsubscribed`), the SHA-256 hashes of the confirmation and unsubscribe tokens, `confirmed_at`, `confirmation_sent_at` and the two timestamps. It holds no IP address and no browser details, and no raw token.

- A new address is `pending`. Only the confirmation link makes it `confirmed`, and a later sign-up never changes a confirmed record. An unsubscribed address stays on file as a suppression record; signing up again makes it `pending`.
- A pending address is sent a new confirmation at most once an hour.
- A daily cron (`17 03 * * *` UTC) deletes `pending` records whose consent is over 30 days old and, when sending is on, sends the confirmation to pending records that have none. Tokens are stored hashed, so that sweep issues new ones.
- Sending uses Cloudflare Email Service's `send_email` binding from `updates@delorun.com`, with the reply-to `support@delorun.com`, and carries `List-Unsubscribe` headers. The flag `WEBSITE_CONFIRMATION_EMAIL` (`on` or `off`) decides whether the binding exists and sends; unset, it is `on` for the `prod` stage and `off` for every other. A stage other than `prod` that turns it on also sets `WEBSITE_PUBLIC_ORIGIN`, the origin that the message links use. While it is off, sign-ups stay `pending` and nothing is sent.
- The rate limit is Cloudflare's rate-limiting binding, five sign-ups a minute per connection. The Worker does not store the address.

To list the people who may be mailed, run from this directory with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set for the account that holds the database:

```sh
node scripts/export-subscribers.ts --stage prod > subscribers.csv  # email, first_name, confirmed_at of every confirmed subscriber
```

The script reads only `confirmed` rows through `wrangler d1 execute`. Its specs, with the Worker's, are in `tests/` and run with the repository's unit suite; they use SQLite in memory with the real migration and send no email.

## Design

The tokens, the Delorun mark, the page footer and the changelog view are in [`delorun/packages/site-design`](../../packages/site-design/src/tokens.css), which this site and the documentation site import by path (`@design/*` in `tsconfig.json`). The directory has no `package.json`: each site is its own workspace with its own lockfile, so neither can install a workspace package. Each site's `vite.config.ts` points the design's `fumadocs-ui/css/` import at its own install.

The site follows the device's light or dark setting. It loads no remote font and sets no cookie. Cloudflare's Turnstile script loads from `challenges.cloudflare.com` only when a visitor first uses the sign-up form.

## Pictures

The home page shows real screenshots of the studio, which are not in the repository. `SITE_PICTURES_DIR` names the folder of source pictures, one `<picture id>.webp` per picture; the build fails with a message naming the variable when it is unset or the folder is missing. `scripts/wall-shots.ts <capture folder>` picks the wall's pictures from a capture set and writes them there (`ingest-owner-shots.ts` adds vetted pictures of the owner's own), then `shot-colours.ts`, `mosaic-plans.ts` and `lod.ts --write` regenerate the committed manifests in `src/home/`. `scripts/lod.ts`, which `pnpm run build` runs, makes the level-of-detail pyramid in `public/lod/` (AVIF and WebP, names hashed from their inputs, cached as immutable by `public/_headers`) and fails when a manifest is stale. It needs `ffmpeg` with libaom-av1 and libwebp on the PATH.

## Commands

Run from the repository root, on the Node major that `.nvmrc` pins.

```sh
(cd delorun/apps && pnpm --dir website install --frozen-lockfile)  # installs the site's dependencies from its own lockfile
(cd delorun/apps && SITE_PICTURES_DIR=<pictures folder> pnpm --dir website run build)  # builds the pictures and into out/, typechecks the site and runs the dead-link check
(cd delorun/apps && pnpm --dir website run preview)                # serves the built out/ on 127.0.0.1:4173 as a static host would
```

The local check `pnpm check` runs the build as the `website-site` check when a change touches the site, the shared design or the changelog record. `scripts/og.html` is the source of `public/og.png`, the link-preview image.

## Deployment

[`alchemy.run.ts`](alchemy.run.ts) deploys `out/` with Alchemy as a Cloudflare Worker with static assets, the stage's D1 database, a Turnstile widget, a rate limiter and, while sending is on, the email binding ([the documentation site's deployment steps](../docs/README.md#deployment)). Turnstile covers `delorun.com` on the `prod` stage and `workers.dev` on every other. The `prod` stage attaches `delorun.com`; every other stage has only its `workers.dev` address. [`public/_headers`](public/_headers) sets the security headers and long caching for the hashed files in `/assets/`.

```sh
pnpm exec alchemy plan --stage <stage>    # shows what a deploy would change, changing nothing
pnpm exec alchemy deploy --stage <stage>  # builds the site and publishes it
pnpm run typecheck:deploy                 # typechecks alchemy.run.ts
```

## Pairing

This README has its Chinese pair. `README.zh.md` holds the Chinese text, and `README.i18n.yaml` is the consistency record, re-recorded with `pnpm run verify-translation-pairing --write delorun/apps/website/README.md` after each change to either side.
