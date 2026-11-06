# Delo documentation website

English | [中文](README.zh.md)

This package builds Delo's documentation website: the user guide and the references in English and Chinese, as a static site. It reads each page pair under [`delo/docs/guide/`](../../docs/guide/README.md) and [`delo/docs/reference/`](../../docs/reference/README.md) in place and copies none of them. The site is a private workspace with its own lockfile, so it is outside the repository's root workspace.

## Routes

| Route | Serves |
| --- | --- |
| `/` | The home page, which links the two sections |
| `/guide`, `/guide/<page>` | The user guide in English |
| `/reference`, `/reference/<page>` | The references in English |
| `/zh/...` | The same routes in Chinese, for each page that has a Chinese pair |
| `/llms.mdx/<section>/<page>` and `/zh/llms.mdx/...` | Each page as Markdown. A section's index is `/llms.mdx/<section>/index`, and a directory's index page is `/llms.mdx/<section>/<directory>/index` |
| `/llms.txt`, `/zh/llms.txt` | An index of each locale's pages, linking their Markdown |

A page's English and Chinese routes are the same slug under the locale prefix. A page in one locale links to its counterpart in the same locale: a Chinese page's link to `trust.md` becomes its Chinese route.

## Links

Each relative link in a page resolves at build time. The build fails on a link that names no file.

- A link to a published page becomes that page's route.
- A link to an upstream repository file becomes its URL in [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
- A link to another Delo file, such as a contract or the threat model, becomes code text that names the file, because the site publishes only the guide and the references.
- A Chinese page takes the English page's heading ids, by position, so the table-of-contents links, which the pair's consistency record fixes, resolve in both locales.

The dead-link check runs after the build. It checks every internal link and fragment in the built HTML and in the Markdown and `llms.txt` files against a built file or an id on the page. It does not fetch external links.

## Version

Each page states the Delo version it describes. The version is read from [`delo/apps/release/package.json`](../release/package.json), the only source the site names.

## Commands

Run from the repository root, on the Node major that `.nvmrc` pins.

```sh
(cd delo/apps && pnpm --dir docs install --frozen-lockfile)  # installs the site's dependencies from its own lockfile
(cd delo/apps && pnpm --dir docs run build)                  # builds into out/ and runs the dead-link check
(cd delo/apps && pnpm --dir docs run dev)                    # serves the site for local work
```

The local check `pnpm check` runs the build as the `docs-site` check when a change touches the site, its pages or the release version. The check refuses to run until the install command has succeeded.

## Deployment

The build's output is the static directory `out/`. This package does not deploy it, configure a host, or set a domain. When deployment is decided, the host must serve the Markdown routes, which have no file extension, as `text/markdown; charset=utf-8`.

The site makes no network request during the build and loads no remote font or script. Telemetry is off for the build (`NEXT_TELEMETRY_DISABLED=1`). Search is not included yet; the search control is disabled.

## Pairing

This README has its Chinese pair. `README.zh.md` holds the Chinese text, and `README.i18n.yaml` is the consistency record, re-recorded with `pnpm run verify-translation-pairing --write delo/apps/docs/README.md` after each change to either side.
