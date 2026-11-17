# Design direction

The site's design brief, copied from the marketing site plan (rulings MS1 to MS21, 2026-11-17) so every lane and every review works from the same page. The plan holds the rulings and the reasons; a change to the direction is made there first and copied here.

## The idea

Three ideas were weighed, each taken from a different part of what Delorun is, and the owner chose the first (MS11).

| | A. The page is a setup | B. Everything is a change under review | C. Socket and plug |
| --- | --- | --- | --- |
| Idea | The page behaves as Delorun does: the visitor changes it, each change is written as the entry Delorun would write and listed as a version, and the visitor can go back. | The page reads as a change being reviewed: sections arrive as added lines, and the visitor applies or discards them. | The hex mark is the page's structure: sections plug into a rail. |
| Depends on | Delorun writes every settings change into `cordis.patch.yml` and keeps a version you can switch back to. | `delorun changes` shows a change as files and a diff. | The mark is a hex socket with a plug, and the harness is made of plugins. |

From C the page takes its motion (things seat like a plug and come out the same way) and the 404 (the mark with its plug out). From B it takes the way a replay's chapters are captioned.

| | |
| --- | --- |
| Idea | This page is a setup. Change it, see what Delorun would write, go back. |
| Borrowed rules | Delorun's own: a settings change writes an entry, an entry makes a version, and going back is one more change. |
| Signature | The setup strip in "Make it yours". |
| First three seconds | "I can touch this, and nothing breaks." |
| How things move | They seat, like a plug going in: a short travel and a settle. Going back is the same movement backwards. |
| The frame people share | The page in Ocean beside the `delorun-theme` entry reading `palette: ocean`, and a list reading "Changed the settings of Theme". |

The idea holds beyond the strip. In the header the theme control is the strip's control. In the footer the last line offers "Back to how it started". The docs open in the look the visitor chose (MS19). The 404 is the mark with nothing plugged in.

## Look

The brand is settled (A374) and is not redesigned here. The roles the page uses:

| Role | Value | Used for |
| --- | --- | --- |
| Ground | the theme's surface (Soft: warm stone, near white in light and `#111110` in dark) | The page |
| Ink | the theme's text colour | Headlines and body |
| Muted | the theme's quiet text, AA on ground | Captions, notes, the platform line |
| Line | the theme's border colour | Hairlines between sections, frames around the replica |
| Accent | the chosen theme's accent | Three things only: the main button, the focus ring, and the marker on the current version |
| Text-safe accent | computed per theme at build time | Links, and text on an accent fill |
| The mark | peach `#E5734A`, always | Header, footer, 404, favicon. It does not change with the theme (A374). |

Warm stone with a peach accent sits close to a look that generated sites reach for by habit. Three things keep the page out of it: the type is a grotesk with no serif anywhere, the accent appears in three places, and the palette is not fixed, since changing it is the point of the page.

- **Type.** Schibsted Grotesk carries headlines and text. JetBrains Mono is used only for real data: commands, the entry, file names. It is not used for labels. Headline sizes are fluid with a large step between headline and body, tracking between -0.02 and -0.04em set per size, leading 0.95 to 1.05, lines balanced, the first glyph aligned to the grid by eye. Body is 16 to 18 px with 1.5 leading and a measure of 45 to 70 characters. Small text is 13 to 14 px. Numbers are tabular; quotes and apostrophes are typographic.
- **Grid.** Twelve columns on a wide screen, four on a phone, with the outer margin equal to the gutter. Text hangs from three lines (columns 1, 5 and 9) down the whole page. Section spacing has three sizes, chosen per section.
- **Shape.** One rule: frames and cards use the 12 px radius, controls 8 px, small marks 4 px.
- **States.** Every control has hover, focus-visible and pressed states that belong to the system. Selection colour, focus ring, favicon and the link-preview image are designed, not defaults.

## Layout of each section

Each section uses a different arrangement. Every section must look finished with scripts off.

| Section | Arrangement | Phone (390 px) |
| --- | --- | --- |
| Hero | A split: the statement, the install command and the disabled desktop button on columns 1 to 5, the studio replica on 6 to 12 | The statement, the command, the desktop button, then the replica at phone width |
| Five claims | Full-width rows, a number and one sentence, each row a link | The same rows |
| Make it yours | The signature: controls on the left third, the entry and the versions on the right | Theme tiles in a row that scrolls sideways and snaps; the entry beneath |
| Plugin browser | A list on columns 1 to 4 and the chosen plugin's detail on 5 to 12 | The list; the detail opens beneath the chosen row |
| Replays | The replica edge to edge with a rail of chapters under it | The replica at phone width; chapters as a snapping row |
| Phone beside desktop | The replica at desktop width on eight columns and at phone width on three, offset vertically | The phone-width one first, the wide one in a sideways-scrolling frame |
| What's new | Dates and headlines as a plain list set large | The same |
| Footer | A closing composition: the install command again at headline size, "Back to how it started", then the links | The same, stacked |

Phone layouts are composed, not shrunk. Nothing on a phone depends on hover, nothing overflows sideways, tap targets are at least 24 px and 44 px for the main actions.

## Motion and feedback

The page has no loader, no WebGL, no smooth-scroll library, no scroll-jacking and no custom cursor.

- **Animate only for a reason.** Each movement explains something, confirms a press, or stops a jarring change. Controls pressed many times in a visit (theme tiles, tabs, chapters) respond almost at once; rare moments may take longer.
- **Timing.** Presses 100 to 160 ms. Tabs, tiles and menus 150 to 250 ms. Nothing in the interface over 300 ms. The theme change is the one explanatory movement and may run 300 to 400 ms. Leaving is quicker than arriving.
- **Easing.** One family. Things arriving use a strong ease-out; things moving across the screen use ease-in-out; colour changes use ease. Nothing uses ease-in.
- **What moves.** Only transform, opacity and clip-path. Transitions, not keyframes, for anything a visitor can interrupt.
- **The signature movement.** The new colours spread from the tile that was pressed (the View Transitions interface, in current Chrome, Safari and Firefox); elsewhere, and under reduced motion, the colours change in place. The entry and the version seat with a short travel and a settle, 30 to 80 ms apart.
- **Presses.** Buttons shrink to 0.97 while pressed. Things arrive from 0.95 scale with opacity, never from nothing. Hover effects apply only where there is a real pointer.
- **Reduced motion.** Fewer and gentler: colour and opacity changes stay, movement goes, replays show their chapters as still states with captions, and no text is ever hidden.
- **Unseen details.** A replay pauses when it leaves the screen or the tab is hidden. The copy button answers in place ("Copied"). The sign-up form answers in place and announces errors. Movements are reviewed in slow motion, on a later day, and on a real phone.

**Toasts.** One toast, for one case: the look was changed away from the strip (the header's control, on either site). It says what changed ("Theme changed to Ocean") and offers the way back by name ("Back to Soft"). A change made in the strip is announced by the strip's own live region, because the way back is already beside it. A new change replaces the last toast; the toast stays while it has focus or the pointer, is reachable by keyboard, and leaves by swipe on a phone. It is a `Toast` in the design library with the library's look, drawn through Sonner (9.4 KB compressed, MIT) on the two sites, since the sites' stand-in for upstream has no toast.

## What the page avoids

A centred hero over a gradient; three equal feature cards; purple or blue glows; glass effects; a small capital label over every heading; mono type for every label; an arrow after every link; fade-up on every section; a second idea competing with the signature. The five claims keep their numbers because the owner chose that form (MS1); nothing else is numbered unless it is a real sequence.

## Words

Agents draft; the owner rewrites (ST54). Sentence case. Concrete nouns and verbs. No sentence appears twice on the page. One name for each action everywhere. No em or en dashes in the page's visible text. Words fit the device ("press", not "hover", on a phone). Numbers only when true, and no count of providers.
