---
area: Studio
section: Fixed
---

- The "Finish setup" line at the sidebar's foot pads its text by the sidebar's own inset, so the label no longer touches the bar's edges, and it carries a × that dismisses it. The dismissal is kept with the guide's progress, so it survives a reload, and it lasts only until the guide moves on or a step the person has not dismissed arrives.
- In a pinned PWA on iOS the studio's surface now reaches the physical top and bottom edges. The shell was sized to `visualViewport.height`, which on iOS stops at the status bar and the home indicator; it now takes the screen, and follows the visual viewport only while the on-screen keyboard shortens it, so the composer still stays above the keyboard.
