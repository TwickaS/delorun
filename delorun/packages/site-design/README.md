---
description: "The parts the Delorun website and the documentation site share: header, footer, theme control, looks stylesheet and the way a look travels between the sites, for maintainers of either site."
kind: "package-library"
---

# @delorun/site-design

## Summary

`@delorun/site-design` holds what `delorun.com` and `docs.delorun.com` share so the two apps feel like one site: the header, the footer, the theme control, the looks stylesheet, the toaster mount, the Fumadocs colour mapping and the changelog reader. The components draw only with `@delorun/brand`, and every word they show comes from the caller's language.

## Contents

- [Use this package](#use-this-package)
- [The looks](#the-looks)
- [Carrying a look between the sites](#carrying-a-look-between-the-sites)
- [Tests](#tests)

## Use this package

Each site is its own workspace root, so each lists the package as `"@delorun/site-design": "link:../../packages/site-design"` and imports its source through the `@design/*` path alias in its tsconfig and Vite config. The repository's root workspace also holds the package, which lets `delorun/apps/tools`' package-states gate see that both sites reach it.

## The looks

`scripts/looks.ts` imports the palette generator of `@delorun/plugin-theme`, resolves the colour roles the brand tokens read for every theme in light and dark, and `src/looks.css` is its output. A look is one rule keyed on `data-look` (and `data-accent` for Custom); contrast is one signed number mixed in CSS and density is one multiplier. Run `node scripts/write-looks.ts` in this package after the plugin's palettes change; the test fails while the file is out of date. The stylesheet keeps the T3 Code copyright comment.

## Carrying a look between the sites

A link from one site to the other carries the look as `?look=ocean` (and `accent`, `density`, `contrast`, `scheme` when they differ from the default). `src/head-script.ts` is the script both sites put in their `<head>`: it follows the device's light or dark setting, reads the query once, ignores any value it does not know, removes the parameters from the address and writes the look to attributes on the root element. Nothing is written to a cookie or to storage, so a reload starts again from the default.

## Tests

`tests/` checks that the stylesheet is current, that the themes and their names equal the studio's, that text reaches AA on every surface in every look, and that the head script agrees with `src/looks.ts`.
