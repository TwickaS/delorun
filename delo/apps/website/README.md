# Delorun product website

English | [中文](README.zh.md)

This package builds delorun.com, Delorun's product site: a home page, a privacy page and a not-found page, as a static site on TanStack Start. Documentation lives on the [documentation site](../docs/README.md), which the pages link. The site is a private workspace with its own lockfile, so it is outside the repository's root workspace.

## Routes

| Route | Serves |
| --- | --- |
| `/` | What Delorun is, the install command, the first setup question and six short sections that each link a guide page; with an assembled version, a What's new section from the changelog record |
| `/privacy` | What the site collects, what its host logs and where to read what the program sends |
| `/404` | The page a host serves, from `404.html`, for an address no file has |

## Design

The tokens, the Delorun mark, the page footer and the changelog view are in [`delo/packages/site-design`](../../packages/site-design/src/tokens.css), which this site and the documentation site import by path (`@design/*` in `tsconfig.json`). The directory has no `package.json`: each site is its own workspace with its own lockfile, so neither can install a workspace package. Each site's `vite.config.ts` points the design's `fumadocs-ui/css/` import at its own install.

The site follows the device's light or dark setting. It loads no remote font or script and sets no cookie.

## Commands

Run from the repository root, on the Node major that `.nvmrc` pins.

```sh
(cd delo/apps && pnpm --dir website install --frozen-lockfile)  # installs the site's dependencies from its own lockfile
(cd delo/apps && pnpm --dir website run build)                  # builds into out/, typechecks the site and runs the dead-link check
(cd delo/apps && pnpm --dir website run preview)                # serves the built out/ on 127.0.0.1:4173 as a static host would
```

The local check `pnpm check` runs the build as the `website-site` check when a change touches the site, the shared design or the changelog record. `scripts/og.html` is the source of `public/og.png`, the link-preview image.

## Deployment

[`alchemy.run.ts`](alchemy.run.ts) deploys `out/` with Alchemy as an assets-only Cloudflare Worker, as the documentation site's does ([its deployment steps](../docs/README.md#deployment)). The `prod` stage attaches `delorun.com`; every other stage has only its `workers.dev` address. [`public/_headers`](public/_headers) sets the security headers and long caching for the hashed files in `/assets/`.

```sh
pnpm exec alchemy plan --stage <stage>    # shows what a deploy would change, changing nothing
pnpm exec alchemy deploy --stage <stage>  # builds the site and publishes it
pnpm run typecheck:deploy                 # typechecks alchemy.run.ts
```

## Pairing

This README has its Chinese pair. `README.zh.md` holds the Chinese text, and `README.i18n.yaml` is the consistency record, re-recorded with `pnpm run verify-translation-pairing --write delo/apps/website/README.md` after each change to either side.
