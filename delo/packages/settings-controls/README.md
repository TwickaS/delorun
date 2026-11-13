---
description: "The settings controls Delo's Settings sections share, for maintainers building or changing a Delo section or General row."
kind: "package-library"
---

# @delo/settings-controls

English | [中文](README.zh.md)

## Summary

`@delo/settings-controls` holds the controls every Delo Settings section is drawn with, so the sections of different plugins look and behave alike: the card with its sentence-case heading, a setting's title and help, the frame of a General row, the radio segmented control and the preview tiles. Plugin-specific controls, such as the header-art strip or the contrast slider, stay in their plugin. The entry is `src/index.ts`, exported as `.` from source.

## Contents

- [Use this package](#use-this-package)
- [Contract](#contract)
- [Tests](#tests)

## Use this package

A Delo plugin with a Settings face imports the controls from `@delo/settings-controls`, lists the package in `dependencies` and inlines it into its browser bundle with an alias in its `tsdown.config.ts`, as it inlines the contract packages: the page's module table does not provide Delo's packages at run time. `@delo/plugin-theme`, `@delo/plugin-sidebar`, `@delo/plugin-chat-states` and `@delo/bundle-local` use it.

| Export | What it draws |
| --- | --- |
| `SettingsCard` | A `<section>` labelled by its `<h3>` heading, an optional one-sentence description, then a bordered box; `cardCss` holds the classes of the stack of cards, the blocks and rows inside a box, and the failure line |
| `SettingHeading` | The title and one-line help of one setting inside a card |
| `SettingRow` | A General row laid out as upstream's preference rows: title, description and failure line, then the control, or the control below for tiles |
| `ChoiceGroup` | Two or three exclusive choices as one row of segments, exposed as a radio group: the chosen segment is the one tab stop and arrow keys move the choice |
| `TileGroup` | Exclusive choices that need a picture, as a radio group of preview tiles |

## Contract

- **Headings.** A card's heading reads upstream's `--dsh-settings-card-heading-*` properties, which `@delo/plugin-settings-layout` sets for the cards the Settings panel draws, so a Delo section's headings and the panel's match; without them the heading keeps the same sentence-case look.
- **Choices are radios.** `ChoiceGroup` and `TileGroup` are controlled: they call `onChange` with a value other than the chosen one and never with the chosen one, and a disabled group refuses every choice.
- **Spacing.** The card and tiles use the Delo look's `--delo-space-*` steps; `SettingRow` declares its own spacing, because the stock look's switch back to the Delo look uses it while those steps do not exist.
- **Copy.** Every control takes localised text from its caller and holds none of its own.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts packages/settings-controls/` runs the specs: [`tests/choice-group.client.spec.tsx`](tests/choice-group.client.spec.tsx) checks the radio semantics and arrow keys, and [`tests/cards.client.spec.tsx`](tests/cards.client.spec.tsx) the card, the setting heading, the row frame and the tiles.
