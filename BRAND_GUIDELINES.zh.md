# Delorun brand guidelines

[English](BRAND_GUIDELINES.md) | 中文

These guidelines say how to write Delorun's name, how to use its mark and colours, what a fork or a plugin may call itself, and how Delorun names its upstream. The colour values come from [`@delorun/brand`](delorun/packages/brand/README.zh.md), which is their one source.

## The name

- The name is "Delorun": one word, a capital D, the rest lower case.
- The command is `delorun`, in code font.
- Never write "Delo", "Delo Run", "Delo-Run" or "DeloRun".
- "Delorun" names the product, the project and the hosted service at delorun.com alike.

## The mark and colours

- The mark is the hex mark: a nut that takes the text colour and a plug that takes the brand colour. Use the files and the `Mark` component from `@delorun/brand`; do not redraw it.
- The brand colour is peach, `#E5734A`: fills, focus rings and the mark's plug. Text on a peach fill is `#111110`, because white on peach reaches only 3.05:1.
- Links and accent text on a light page use the text-safe peach, `#B84A1B`, which reaches 5.21:1 on white. On a dark page, peach itself reaches 6.19:1 on `#111110`.
- Text is set in Schibsted Grotesk and code in JetBrains Mono.

Do:

- Show the mark with the nut in the text colour and the plug in peach.
- Keep the contrast ratios above.

Do not:

- Stretch, rotate, outline, recolour or add effects to the mark.
- Set body text in peach `#E5734A` on a light page.
- Replace the typefaces with look-alikes in material that presents itself as Delorun's.

## Forks and plugins

- "For Delorun" and "works with Delorun" are fine in a plugin's or a project's description.
- A fork must not use "Delorun" in its name, its command, its package scope or its icon, and must not look official, endorsed or authorised by Delorun.
- A plugin's own name and icon are its own; they do not use the Delorun mark.

## Naming the upstream

Delorun is a community fork of DeepSeek Harness. Delorun says so in truthful words: "Built on DeepSeek Harness", "Import from DSH", "compared with DeepSeek Harness". It never uses "DeepSeek Harness", "DSH" or DeepSeek's own brand material as or inside Delorun's name, and nothing it publishes suggests that DeepSeek endorses, cooperates in or authorises Delorun.

A project that describes its relationship to DeepSeek Harness follows DeepSeek's own guidelines for that name.
