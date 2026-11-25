---
area: Studio
section: Fixed
---

- Following a streaming reply no longer measures the transcript scrollport three times per update: the follow path reuses the geometry it already read, so a six-pane Multiview layout does less work on every streamed chunk.
