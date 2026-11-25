---
area: Studio
section: Fixed
---

- A chat with several panes open stays smooth while answers stream in. Following the newest message read the scroll position once per streamed piece of text, and each read made the browser recalculate the page's layout before it could answer, so six streaming panes cost about three times the recalculation of a closed layout. It now reads once per frame and reuses that until the next one.
