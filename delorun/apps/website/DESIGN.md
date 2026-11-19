# Design direction

The home page is prototype B, chosen by the owner (L71): a wall of real studio screenshots that forms the Delorun mark, a zoom into one real job, and the case for people who take their tools apart. The decisions are L57 to L80 in the plan's decisions file; this page records what the code draws and keeps.

## The idea

The first thing a visitor sees is the product, in many looks, laid out as the hexagon of the mark with the promise beside it: "Bring your own everything." Scrolling zooms into one chat in the mark's hole; that chat is the first picture of the film, which tells one real job in five screenshots. Below it are the reasons, a wall of every screenshot, and the install command again.

Every picture is a real screenshot of the Delorun studio, scaled and never retouched. The only treatment is a tint over mosaic tiles at wall level; the lightbox always shows the untouched picture.

## Look

| Role | Token | Used for |
| --- | --- | --- |
| Page | `--dl-surface` | The header and the sections around the stage |
| Stage | `--dl-stage`, `--dl-stage-text`, `--dl-stage-muted`, `--dl-stage-line` | The ground the screenshots hang on: near black in dark, warm paper in light |
| Plate | `--dl-plate`, `--dl-plate-text`, `--dl-plate-muted`, `--dl-plate-accent` | The lightbox's caption plate, a paper label in both schemes |
| Accent | `--dl-accent` | The main button, the focus ring, the lit target of the zoom, and the mark's peach plug |
| Type | `--dl-font-sans`, `--dl-font-mono` | Schibsted Grotesk at weight 800 for the headline, JetBrains Mono only for data (commands, the status readout, times) |

The page draws only with `@delorun/brand` tokens and components. The stage and plate tokens and the `scene` duration were added to the library for this page.

## The mark

The hexagon is a photomosaic: a grid of 16:10 screenshot tiles in which each cell takes the picture whose measured lightness is closest to what the cell needs. A cell that straddles the hexagon's edge takes the share-weighted mix, so the outline is graded and reads at any size. In the dark scheme the nut is light on a dark ground; in the light scheme it is dark on the cream ground, so the hexagon reads in both. The plug takes the pictures with the most peach in them. No picture sits next to itself, diagonals included.

`scripts/mosaic-plans.ts` runs the match once for each look, scheme and layout; `scripts/lod.ts` composes each plan into one atlas picture, which is the first paint. The tiles are transparent buttons over it.

## Pictures

Pictures are built, not served from a resizer. The sources are `<id>.webp` files in the folder `SITE_PICTURES_DIR` names, outside the repository (written by `scripts/wall-shots.ts` from the capture folder, and by `scripts/ingest-owner-shots.ts` for the owner's own, which join only when vetted). `scripts/lod.ts` makes four levels of each, as AVIF with a WebP fallback, into `public/lod/`: L0 the mosaic atlas, L1 about 96 px for a mosaic tile, L2 about 480 px for the zoom and the wall, L3 the capture's own size for the lightbox. File names carry a hash of what they are made from, and `public/_headers` caches them as immutable. The page picks a level from each tile's size on screen times the device pixel ratio and loads only what is near the viewport or the zoom's target. Picture bytes are reported by `scripts/page-weight.ts`, not budgeted; the first screen's code, fonts and HTML are, by `scripts/weight.ts`.

## Motion

- The zoom, the re-tile and the lightbox's grow are scenes: explanatory moments that may run longer than a control (`--dl-motion-scene`, 760 ms). Everything in the interface stays inside the brand's other durations.
- Presses shrink to 0.97. Hover effects apply only with a real pointer. Only transform, opacity and clip-path move.
- Theme changes and other page effects go through one queue (`src/home/effects.ts`): each plays in full and in order, the queue holds five, later ones replace the last waiting one and everything plays faster while some wait. The header's readout shows what runs and what waits.
- Reduced motion: the page opens on the formed mark, the film shows each chapter's wide shot with no push, and the zoom does not run. Nothing hides text.

## Without scripts

The prerendered page holds the atlas still in the hero, the headline, the paragraph and every install command; the film shows its first picture; the wall and the sign-up form are present. The scripted parts of the install block are replaced by plain commands.

## What the page avoids

A centred hero over a gradient; three equal feature cards; purple or blue glows; glass effects; a small capital label over every heading; mono type for every label; an arrow after every link; fade-up on every section; a count that is not shown on the page.

## Words

English only, British spelling, sentence case. Concrete nouns and verbs. No dashes in visible text. No invented numbers, users or quotes: a count appears only where the page shows what it counts.
