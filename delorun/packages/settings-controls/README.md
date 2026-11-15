---
description: "The settings controls Delorun's Settings sections share, for maintainers building or changing a Delorun section or General row."
kind: "package-library"
---

# @delorun/settings-controls

English | [中文](README.zh.md)

## Summary

`@delorun/settings-controls` re-exports from [`@delorun/brand`](../brand/README.md), the one source, the controls every Delorun Settings section is drawn with, so the sections of different plugins look and behave alike: the card with its sentence-case heading, a setting's title and help, the frame of a General row, the radio segmented control and the preview tiles. Plugin-specific controls, such as the header-art strip or the contrast slider, stay in their plugin. The entry is `src/index.ts`, exported as `.` from source.

## Contents

- [Use this package](#use-this-package)
- [Contract](#contract)
- [Tests](#tests)

## Use this package

A Delorun plugin with a Settings face imports the controls from `@delorun/settings-controls`, lists the package in `dependencies` and inlines it into its browser bundle with aliases for this package and for `@delorun/brand` in its `tsdown.config.ts`, as it inlines the contract packages: the page's module table does not provide Delorun's packages at run time. `@delorun/plugin-theme`, `@delorun/plugin-sidebar`, `@delorun/plugin-chat-states` and `@delorun/bundle-local` use it.

| Export | What it draws |
| --- | --- |
| `SettingsCard` | A `<section>` labelled by its `<h3>` heading, an optional one-sentence description, then a bordered box; `cardCss` holds the classes of the stack of cards, the blocks and rows inside a box, and the failure line |
| `SettingHeading` | The title and one-line help of one setting inside a card |
| `SettingRow` | A General row laid out as upstream's preference rows: title, description and failure line, then the control, or the control below for tiles |
| `ChoiceGroup` | Two or three exclusive choices as one row of segments, exposed as a radio group: the chosen segment is the one tab stop and arrow keys move the choice |
| `TileGroup` | Exclusive choices that need a picture, as a radio group of preview tiles |

## Contract

- **Headings.** A card's heading reads upstream's `--dsh-settings-card-heading-*` properties, which `@delorun/plugin-settings-layout` sets for the cards the Settings panel draws, so a Delorun section's headings and the panel's match; without them the heading keeps the same sentence-case look.
- **Choices are radios.** `ChoiceGroup` and `TileGroup` are controlled: they call `onChange` with a value other than the chosen one and never with the chosen one, and a disabled group refuses every choice.
- **Spacing.** The card and tiles use the Delorun look's `--delorun-space-*` steps; `SettingRow` declares its own spacing, because the stock look's switch back to the Delorun look uses it while those steps do not exist.
- **Copy.** Every control takes localised text from its caller and holds none of its own.

## Tests

The specs live with the source: `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/brand` runs [`settings-choice-group.client.spec.tsx`](../brand/tests/settings-choice-group.client.spec.tsx), which checks the radio semantics and arrow keys, and [`settings-cards.client.spec.tsx`](../brand/tests/settings-cards.client.spec.tsx), which checks the card, the setting heading, the row frame and the tiles.
