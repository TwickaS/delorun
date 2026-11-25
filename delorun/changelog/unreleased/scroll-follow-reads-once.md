---
area: Studio
section: Fixed
---

- A chat with several panes open stays smooth while answers stream in. Following the newest message used to measure the transcript's scrollport three times for every streamed piece of text, and each measurement made the browser recalculate the page's layout before it could answer, so six streaming panes cost about three times the recalculation of a closed layout. It measures once and passes that down, so the work is a third of what it was.
