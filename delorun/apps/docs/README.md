# Delorun documentation website

English | [中文](README.zh.md)

This package builds Delorun's documentation website: the user guide and the references in English and Chinese, as a static site built with Fumadocs on TanStack Start. It reads each page pair under [`delorun/docs/guide/`](../../docs/guide/README.md) and [`delorun/docs/reference/`](../../docs/reference/README.md) in place and copies none of them. The site is a private workspace with its own lockfile, so it is outside the repository's root workspace.

## Routes

| Route | Serves |
| --- | --- |
| `/` | The home page, which links the two sections and, when a version is assembled, shows What's new with the latest version |
| `/guide`, `/guide/<group>/<page>` | The user guide in English. A page lives in the folder of its sidebar group, such as `/guide/get-started/install`; `/guide/roadmap` stays at the top level, linked from the header |
| `/reference`, `/reference/<page>`, `/reference/parity-with-deepseek-harness/<page>` | The references in English |
| `/changelog` | The changelog: the standing comparison with the upstream release, then every assembled version, newest first; absent when no version is assembled |
| `/zh/...` | The same routes in Chinese; a page without a Chinese pair shows its English text |
| `/llms.mdx/<section>/<page>` and `/zh/llms.mdx/...` | Each page as Markdown. A section's index is `/llms.mdx/<section>/index`, and a directory's index page is `/llms.mdx/<section>/<directory>/index` |
| `/llms.txt`, `/zh/llms.txt` | An index of each locale's pages, linking their Markdown |
| `/sitemap.xml`, `/robots.txt` | The sitemap of every page in both locales, written by the build, and the robots file in `public/` that names it |
| `/search.json` | The search index of every page in both locales, which the search dialog downloads |
| `/404` | The page a host serves, from `404.html`, for an address no file has |

A page's English and Chinese routes are the same slug under the locale prefix.

The guide sidebar has two halves: **Using Delorun** (`why-delorun`, then the groups `get-started`, `everyday-use`, `safety-and-updates` and `help`) and **Customise and build** (`customising`, `plugin-guides`). A separator inside a group's `meta.json` splits it, as **Coming from DeepSeek** does in `get-started`. Each group is a collapsible folder, and only the folder holding the current page is open. A group's folder holds its pages' files under `delorun/docs/guide/`, and its `meta.json` (`meta.zh.json` in Chinese) names the group and lists its pages in reading order. The header's Guide, Reference, Changelog and Roadmap links are tabs above the page, and the sidebar drawer's tab menu on narrow screens.

Pages that moved into a group keep their old addresses as permanent redirects, in both locales and for the Markdown routes. `src/site/redirects.ts` lists the moved pages, and the build writes the redirects as `out/_redirects`, which Cloudflare reads beside `_headers`. `pnpm run preview` serves them too. A page that moves again adds an entry. A page in one locale links to its counterpart in the same locale: a Chinese page's link to `trust.md` becomes its Chinese route.

## Links

Each relative link in a page resolves at build time. The build fails on a link that names no file.

- A link to a published page becomes that page's route.
- A link to an upstream repository file becomes its URL in [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
- A link to another Delorun file, such as a contract or the threat model, becomes its URL in Delorun's GitHub repository, because the site publishes only the guide and the references.
- A Chinese page takes the English page's heading ids, by position, so the table-of-contents links, which the pair's consistency record fixes, resolve in both locales.

The dead-link check runs after the build. It checks every internal link and fragment in the built HTML and in the Markdown and `llms.txt` files against a built file or an id on the page. It does not fetch external links.

## Version

Each page states the Delorun version it describes: the newest version in the changelog record below. With no record, the pages state no version.

## Changelog

The changelog page and the home page's What's new section are generated at build time from Delorun's changelog record, `delorun/changelog/changelog.json`, which the release tooling writes when it assembles a version. The build reads the record with the types and functions of [`delorun/apps/release/src/changelog/data.ts`](../release/src/changelog/data.ts), which also render `CHANGELOG.md` and the release notes, so the site and those files state the same entries. Unreleased fragments are never read: a version appears once it is assembled. The Chinese page has a Chinese title and labels and the English entries.

With no record, the build still succeeds and leaves out the page, its prerendered files and the home section. To review the site before a version is assembled, write a preview record from the unreleased fragments to a file outside the repository and build with it; the first command runs from the repository root. Nothing is moved and the output is never committed:

```sh
node_modules/.bin/tsx delorun/apps/docs/scripts/preview-record.ts 0.1.0 /tmp/docs-preview/changelog.json
(cd delorun/apps && DOCS_CHANGELOG_PREVIEW=/tmp/docs-preview/changelog.json pnpm --dir docs run build)
```

`DOCS_CHANGELOG_PREVIEW` names the record to publish instead of the repository's; the build fails when the file does not exist.

## Theme

The site's look comes from [`delorun/packages/site-design`](../../packages/site-design/src/tokens.css), which this site and the [product website](../website/README.md) import by path as `@design/*`: the design tokens, the page footer, the Delorun mark and the changelog view. Its files read no page, label or site setting; each site passes its own text and links. The header in [`src/theme/header.ts`](src/theme/header.ts) stays here because it adapts Fumadocs' layout options.

## Commands

Run from the repository root, on the Node major that `.nvmrc` pins.

```sh
(cd delorun/apps && pnpm --dir docs install --frozen-lockfile)  # installs the site's dependencies from its own lockfile
(cd delorun/apps && pnpm --dir docs run build)                  # builds into out/, typechecks the site and runs the dead-link check
(cd delorun/apps && pnpm --dir docs run dev)                    # serves the site for local work
(cd delorun/apps && pnpm --dir docs run preview)                # serves the built out/ on 127.0.0.1:4173 as a static host would
```

The local check `pnpm check` runs the build as the `docs-site` check when a change touches the site, its pages or the release version. The check refuses to run until the install command has succeeded.

## Deployment

The build's output is the static directory `out/`: every route above is a prerendered file, and the site runs no server code after the build. A page route is an HTML file beside its directory, such as `guide.html` beside `guide/`, so the host serves `/guide` from `guide.html`. The site's address, `https://docs.delorun.com`, which each page names as its canonical URL, and the product site the navigation links are set in [`src/site/config.ts`](src/site/config.ts).

In the browser, a link to another page renders that page from the page data the build wrote into `out/assets/`, and search queries `/search.json` in the browser, so neither asks a server. The site makes no network request during the build, loads no remote font or script and sends no telemetry.

[`alchemy.run.ts`](alchemy.run.ts) deploys `out/` with Alchemy as an assets-only Cloudflare Worker: Alchemy runs the site's build and uploads its output, and the site builds without Alchemy. The `prod` stage attaches `docs.delorun.com` as a Workers custom domain in the existing `delorun.com` zone, and Cloudflare creates its DNS record and certificate; every other stage has only its `workers.dev` address. Cloudflare serves an address no file has from `404.html` with status 404. [`public/_headers`](public/_headers), which the build copies into `out/`, sets the security headers, long caching for the hashed files in `/assets/` and the Markdown routes' `text/markdown; charset=utf-8` type.

Run the deployment commands from `delorun/apps/docs`:

```sh
pnpm exec alchemy profile edit --add Cloudflare   # once per machine: sign in to the Cloudflare account
pnpm exec alchemy state bootstrap                 # once per account: create the state store that Cloudflare.state() uses
pnpm exec alchemy plan --stage prod               # shows what a deploy would change, changing nothing
pnpm exec alchemy deploy --stage prod             # builds the site and publishes it at docs.delorun.com
pnpm exec alchemy destroy --stage <stage>         # deletes a stage's Worker and its custom domain
pnpm run typecheck:deploy                         # typechecks alchemy.run.ts
```

On a workstation the first `plan` or `deploy` also creates the state store when the account has none; with `CI=true` a missing store fails the run, so the bootstrap runs once from a workstation first. The state store is a Worker with a Durable Object, and its token and encryption key are kept in the account's Secrets Store.

A deploy job authenticates with `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` scoped to the Delorun account with these permissions: account `Workers Scripts Write` (the Worker, its assets, its `workers.dev` address and the custom domain) and `Secrets Store Write` (reading the state store's credentials, which Alchemy does by binding them to a short-lived preview Worker), and on the `delorun.com` zone only, `Zone Read` (Alchemy finds the zone by name) and `Workers Routes Read` (Alchemy reads the zone's Worker routes). `pnpm exec alchemy provider check-env` reports a missing variable before a deploy starts. The token belongs only in a deploy job that runs on the default branch in a protected environment with required reviewers, whose secrets no pull-request workflow can read; it is never committed and never given to a pull-request build.

## Pairing

This README has its Chinese pair. `README.zh.md` holds the Chinese text, and `README.i18n.yaml` is the consistency record, re-recorded with `pnpm run verify-translation-pairing --write delorun/apps/docs/README.md` after each change to either side.
