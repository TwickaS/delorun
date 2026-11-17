---
description: "The parts the Delorun website and the documentation site share: header, footer, theme control, looks stylesheet and the way a look travels between the sites, for maintainers of either site."
kind: "package-library"
---

# @delorun/site-design

English | [中文](README.zh.md)

## Summary

`@delorun/site-design` holds what `delorun.com` and `docs.delorun.com` share so the two apps feel like one site: the header, the footer, the theme control, the search field, the looks stylesheet, the toast and the changelog reader. The components draw only with `@delorun/brand`, and every word they show comes from the caller's language.

## Contents

- [Use this package](#use-this-package)
- [The looks](#the-looks)
- [Carrying a look between the sites](#carrying-a-look-between-the-sites)
- [The shared parts](#the-shared-parts)
- [Weight](#weight)
- [Tests and tools](#tests-and-tools)

## Use this package

Each site is its own workspace root, so each lists the package as `"@delorun/site-design": "link:../../packages/site-design"` and imports its source through the `@design/*` path alias in its tsconfig and Vite config. The repository's root workspace also holds the package, which lets the package-states gate see that both sites reach it.

## The looks

`scripts/looks.ts` imports the palette generator of `@delorun/plugin-theme` and resolves the colour roles the brand tokens read for every theme in light and dark. `src/looks.css` and `src/look-swatches.ts` are its output. A look is one rule keyed on `data-look` (and `data-accent` for Custom). Contrast is one number mixed in CSS, with the stops `default`, `high` and `highest`: the palettes put quiet text exactly at the AA floor, so no stop weakens it. Density is one multiplier. Run `node scripts/write-looks.ts` in this package after the plugin's palettes change; the test fails while the files are out of date. The stylesheet keeps the T3 Code copyright comment, and `scripts/notices.ts` reads the licence texts the sites' notices page shows.

## Carrying a look between the sites

A link from one site to the other carries the look as `?look=ocean`, with `accent`, `density`, `contrast` and `scheme` when they differ from the default. `src/head-script.ts` is the script both sites put in their `<head>`: it follows the device's light or dark setting, reads the query once, ignores any value it does not know, removes the parameters from the address and writes the look to attributes on the root element. Nothing is written to a cookie or to storage, so a reload starts again from the default.

## The shared parts

- **Header and footer.** `SiteHeader` and `SiteFooter` take their text and links from the caller. The mark is always peach (`ProductMark`), whatever the look.
- **Theme control.** A button that opens a native popover placed beside it. It is drawn only once scripts run. The menu and the toast load on first use.
- **Search field.** `SearchForm` is a plain GET form to the documentation's `?search=` address and carries the look in hidden fields once scripts run.

## Weight

The product site's first screen must stay within 120 KB compressed. `scripts/chunk-modules.ts` lists a built chunk by source module from its source map (`vite build --sourcemap`), to find what the entry script carries.

## Tests and tools

`tests/` checks that the stylesheet is current, that the themes and their names equal the studio's, that text reaches AA on every surface in every look, that the head script agrees with `src/looks.ts`, and that the mark stays peach. `scripts/shots.ts` takes a screenshot of a locally served page and prints what the page keeps in storage and cookies.
